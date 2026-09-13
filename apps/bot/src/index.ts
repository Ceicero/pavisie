// Discord gateway bot process bootstrap (ARCHITECTURE.md §9).
import type { Client } from 'discord.js';
import { GatewayIntentBits } from 'discord.js';
import { createLogger, createRedis, loadEnv, listFromCsv, requireEnv, env } from '@pavisie/core';
import { ensureGuild, markGuildLeft, prisma } from '@pavisie/database';
import { allPlugins, PluginRegistry, type PrivilegedIntentsEnabled } from '@pavisie/plugins';
import { createClient } from './client';
import { bullConnectionOptionsFromUrl } from './lib/redis-options';
import { createBotActionsWorker } from './host/bot-actions';
import { createDataRequestsWorker } from './host/data-requests';
import { startHealthServer } from './host/health';
import { loadPlugins } from './host/loader';
import { describeTarget, registerCommands, type RegisterTarget } from './host/register-commands';
import { routeInteraction } from './host/router';
import { handleMessageCommand } from './host/prefix';
import { startWorkers } from './workers';

const DEFAULT_HEALTH_PORT = 3002;

async function main(): Promise<void> {
  loadEnv();
  requireEnv('DISCORD_TOKEN', 'DATABASE_URL', 'REDIS_URL', 'DISCORD_CLIENT_ID');

  const logger = createLogger('bot');
  const redisUrl = env.REDIS_URL as string;
  const redis = createRedis(redisUrl);
  const bullConnectionOptions = bullConnectionOptionsFromUrl(redisUrl);
  const botOwnerIds = listFromCsv(env.BOT_OWNER_IDS);

  const registry = new PluginRegistry(allPlugins);
  const intentsEnabled: PrivilegedIntentsEnabled = {
    messageContent: env.ENABLE_MESSAGE_CONTENT_INTENT,
    guildMembers: env.ENABLE_GUILD_MEMBERS_INTENT,
    guildPresences: env.ENABLE_GUILD_PRESENCES_INTENT,
  };
  let intents = registry.requiredIntents(intentsEnabled);
  // If message content intent is enabled, ensure GuildMessages intent is present (needed for message events)
  if (intentsEnabled.messageContent && !intents.includes(GatewayIntentBits.GuildMessages)) {
    intents = [...intents, GatewayIntentBits.GuildMessages];
  }
  // `PluginContext.client`/`loadPlugins` are typed as `Client<true>` (logged-in) per the SDK contract, but we
  // build/wire everything before calling `client.login()` below (standard discord.js bootstrap ordering — the
  // client is only actually used once `ready` fires, by which point it genuinely is `<true>`).
  const client = createClient(intents) as unknown as Client<true>;

  const host = await loadPlugins({
    plugins: allPlugins,
    client,
    prisma,
    redis,
    env,
    botOwnerIds,
    intentsEnabled,
    bullConnectionOptions,
    logger,
  });

  client.on('interactionCreate', (interaction) => {
    void routeInteraction(interaction, host, logger).catch((err: unknown) => {
      logger.error({ err }, 'unhandled error while routing an interaction');
    });
  });

  // Prefix-command message listener (only when message content intent is enabled)
  if (intentsEnabled.messageContent) {
    client.on('messageCreate', (message) => {
      void handleMessageCommand(message, host, logger, env.COMMAND_PREFIX as string).catch((err: unknown) => {
        logger.error({ err }, 'unhandled error while handling a prefix message command');
      });
    });
  }

  client.once('ready', (readyClient) => {
    logger.info({ guilds: readyClient.guilds.cache.size, tag: readyClient.user.tag }, 'bot ready');

    // Always report the prefix layer's resolved state, working or not. A `+` command that silently does
    // nothing is indistinguishable from a bot that never saw the message, so this one line is what turns
    // "it isn't working" into an answerable question: it says whether the listener is attached, what prefix
    // it is listening for, and whether the gateway actually negotiated the MessageContent intent.
    logger.info(
      {
        prefix: env.COMMAND_PREFIX,
        messageContentEnvFlag: intentsEnabled.messageContent,
        messageContentIntentRequested: intents.includes(GatewayIntentBits.MessageContent),
        guildMessagesIntentRequested: intents.includes(GatewayIntentBits.GuildMessages),
        listenerAttached: intentsEnabled.messageContent,
      },
      intentsEnabled.messageContent
        ? 'prefix commands enabled'
        : 'prefix commands DISABLED (ENABLE_MESSAGE_CONTENT_INTENT is false)',
    );

    // Optional self-registration of slash commands at boot (REGISTER_COMMANDS_ON_BOOT=global|guild), so hosted
    // deployments never need a local `commands:register` run. Failures are logged, never fatal.
    if (env.REGISTER_COMMANDS_ON_BOOT !== 'off') {
      const target: RegisterTarget | null =
        env.REGISTER_COMMANDS_ON_BOOT === 'guild'
          ? env.DEV_GUILD_ID
            ? { scope: 'guild', guildId: env.DEV_GUILD_ID }
            : null
          : { scope: 'global' };
      if (!target) {
        logger.warn('REGISTER_COMMANDS_ON_BOOT=guild requires DEV_GUILD_ID; skipping command registration');
      } else {
        void registerCommands({
          token: env.DISCORD_TOKEN as string,
          clientId: env.DISCORD_CLIENT_ID as string,
          registry,
          target,
        })
          .then((result) =>
            logger.info(
              { count: result.commands.length, target: result.target },
              `registered slash commands ${describeTarget(result.target)}`,
            ),
          )
          .catch((err: unknown) => logger.error({ err, target }, 'command registration on boot failed'));
      }
    }

    void (async () => {
      for (const guild of readyClient.guilds.cache.values()) {
        try {
          await ensureGuild(prisma, {
            id: guild.id,
            name: guild.name,
            iconHash: guild.icon,
            ownerId: guild.ownerId,
            memberCount: guild.memberCount,
          });
        } catch (err) {
          logger.error({ err, guildId: guild.id }, 'failed to sync guild on ready');
        }
      }

      try {
        const currentIds = new Set(readyClient.guilds.cache.keys());
        const presentInDb = await prisma.guild.findMany({
          where: { botPresent: true },
          select: { id: true },
        });
        for (const row of presentInDb) {
          if (!currentIds.has(row.id)) {
            await markGuildLeft(prisma, row.id).catch((err: unknown) => {
              logger.error({ err, guildId: row.id }, 'failed to mark left guild');
            });
          }
        }
      } catch (err) {
        logger.error({ err }, 'failed to reconcile left guilds on ready');
      }
    })();
  });

  client.on('guildCreate', (guild) => {
    void ensureGuild(prisma, {
      id: guild.id,
      name: guild.name,
      iconHash: guild.icon,
      ownerId: guild.ownerId,
      memberCount: guild.memberCount,
    }).catch((err: unknown) => {
      logger.error({ err, guildId: guild.id }, 'failed to sync guild on guildCreate');
    });
  });

  client.on('guildDelete', (guild) => {
    void markGuildLeft(prisma, guild.id).catch((err: unknown) => {
      logger.error({ err, guildId: guild.id }, 'failed to mark guild left on guildDelete');
    });
  });

  const jobWorkers = startWorkers({
    plugins: allPlugins,
    ctxFactory: (plugin) => host.contexts.get(plugin.manifest.id),
    connection: bullConnectionOptions,
    logger,
  });

  const botActionsWorker = createBotActionsWorker({
    services: host.services,
    client,
    prisma,
    connection: bullConnectionOptions,
    logger,
  });

  const dataRequestsWorker = createDataRequestsWorker({
    client,
    prisma,
    connection: bullConnectionOptions,
    logger,
  });

  const healthServer = startHealthServer({
    port: env.BOT_HEALTH_PORT ?? DEFAULT_HEALTH_PORT,
    client,
    host,
    logger,
  });

  // Discord refuses the gateway handshake (close code 4014) when the process asks for a privileged intent the
  // application has not been granted in the Developer Portal. That surfaces as an opaque "Used disallowed
  // intents" crash, and since ENABLE_MESSAGE_CONTENT_INTENT defaults to true (the `+` prefix layer needs it —
  // ARCHITECTURE.md §9.1), the likeliest cause by far is the portal toggle simply never being switched on.
  // Rethrow with the actual fix instead. Retrying without the intent is not possible here: intents are fixed at
  // Client construction, and every plugin's event listeners are already bound to this client.
  try {
    await client.login(env.DISCORD_TOKEN);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/disallowed intents/i.test(text) || /\b4014\b/.test(text)) {
      logger.fatal(
        {
          err,
          messageContent: intentsEnabled.messageContent,
          guildMembers: intentsEnabled.guildMembers,
          guildPresences: intentsEnabled.guildPresences,
        },
        'Discord rejected login: this bot requested a privileged intent it has not been granted. Enable the ' +
          'matching toggles under Discord Developer Portal → Applications → (this app) → Bot → Privileged ' +
          'Gateway Intents, or set the corresponding ENABLE_*_INTENT variable to false. Message Content is ' +
          'required for +prefix commands, automod, Enforcer auto-flagging and message logging.',
      );
    }
    throw err;
  }

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    try {
      await healthServer.close();
    } catch (err) {
      logger.error({ err }, 'error closing health server');
    }
    try {
      await botActionsWorker.close();
    } catch (err) {
      logger.error({ err }, 'error closing bot-actions worker');
    }
    try {
      await dataRequestsWorker.close();
    } catch (err) {
      logger.error({ err }, 'error closing data-requests worker');
    }
    try {
      await jobWorkers.close();
    } catch (err) {
      logger.error({ err }, 'error closing plugin job workers');
    }
    try {
      await host.services.get('twitchChat')?.stop();
    } catch (err) {
      logger.error({ err }, 'error stopping twitch chat service');
    }
    for (const queue of host.queueCache.values()) {
      try {
        await queue.close();
      } catch (err) {
        logger.error({ err }, 'error closing a plugin queue');
      }
    }
    try {
      client.destroy();
    } catch (err) {
      logger.error({ err }, 'error destroying Discord client');
    }
    try {
      await redis.quit();
    } catch {
      // Already closed or unreachable — nothing more to do.
    }
    try {
      await prisma.$disconnect();
    } catch (err) {
      logger.error({ err }, 'error disconnecting Prisma');
    }

    logger.info('shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaughtException');
  });
}

main().catch((err: unknown) => {
  // no-console: `error`/`warn` are allowed by the root eslint config. Fatal boot failure (e.g. missing env vars)
  // must be visible even before the logger/redis/db are up, at the top-level process entrypoint.
  console.error('Fatal error during bot startup:', err instanceof Error ? err.message : err);
  process.exit(1);
});
