// `/dbd` — the Dead by Daylight command family (link/unlink/stats/leaderboard/refresh). This is the ONLY
// command in v1 of the `gamestats` plugin: it is intentionally game-specific (not a generic `/gamestats <game>`
// command) even though the underlying framework (`../games`) is built to support more games later — see
// `games/index.ts`'s header comment. Adding the next game means adding its own `/<game>` command file here,
// never generalizing this one.
//
// STEAM_API_KEY gating: this file does NOT check `ctx.env.STEAM_API_KEY` itself. `manifest.ts` declares it as
// `requiredEnv`, so `apps/bot/src/host/router.ts`'s `checkPluginGate` already refuses every `/dbd` subcommand
// with the generic `errors.plugin_unavailable` ("The Game Stats plugin is not available: Missing required
// environment variable(s): STEAM_API_KEY.") reply before `execute()` is ever called — the same mechanism that
// gates every other `requiredEnv` plugin (see `integrations/twitch-chat/manager.ts`'s analogous internal
// "...are not configured on this deployment." gate for the same shape of problem). That already IS this
// plugin's honest "not available on this deployment" behavior; no per-command duplication needed.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  TimestampStyles,
  time,
  type ButtonInteraction,
  type EmbedBuilder,
} from 'discord.js';
import { Prisma, type GameAccountLink } from '@pavisie/database';
import {
  brandEmbed,
  buildCustomId,
  errorEmbed,
  listEmbed,
  successEmbed,
  userMention,
  type CommandContext,
  type ComponentHandler,
  type PluginCommand,
  type PluginContext,
} from '../../sdk';
import { getGame, getStatDef, providerStatKeys, type GameStatDef } from '../games';
import { buildLeaderboard, formatStatValue, refreshMemberStats, type LeaderboardPage, type LeaderboardSnapshot } from '../service';
import { getGameStats, getPlayerSummary, resolveSteamId } from '../steam';

const LEADERBOARD_PAGE_SIZE = 10;

/** True for Prisma's unique-constraint-violation error (P2002) — same check as
 *  `integrations/commands/twitch.ts`'s `isUniqueViolation`. Used here for the `@@unique([guildId, provider,
 *  externalId])` race: two members linking the same Steam account at almost the same moment can both pass the
 *  proactive `findFirst` duplicate check below before either upsert commits. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/** How long a member must wait between `/dbd refresh` calls (self-service secondary limit — the declarative
 *  `requirement.cooldown` on `PluginCommand` is per-command, not per-subcommand, so `/dbd` as a whole only
 *  carries the 5s baseline; this stricter 60s limit is enforced here via `ctx.rateLimiter`, same pattern as
 *  `community/commands/statschannel.ts`'s `handleRefresh`. */
const REFRESH_COOLDOWN_MS = 60_000;

// `dbd` is always registered in `GAMES` (`games/index.ts`) — this command exists specifically for it.
const GAME = getGame('dbd')!;
const DEFAULT_STAT = getStatDef(GAME, 'escapes')!;

const STAT_CHOICES = GAME.stats.map((stat) => ({ name: stat.label, value: stat.id }));

const data = new SlashCommandBuilder()
  .setName('dbd')
  .setDescription('Dead by Daylight stats: link your Steam account, stat cards, and leaderboards.')
  .setDMPermission(false)
  .addSubcommand((sub) =>
    sub
      .setName('link')
      .setDescription('Link your Steam account to track Dead by Daylight stats.')
      .addStringOption((opt) =>
        opt
          .setName('account')
          .setDescription('SteamID64, profile URL, or vanity name')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('unlink').setDescription('Remove your linked Steam account and stats from this server.'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('stats')
      .setDescription('Show a Dead by Daylight stat card.')
      .addUserOption((opt) => opt.setName('member').setDescription('Defaults to you.')),
  )
  .addSubcommand((sub) =>
    sub
      .setName('leaderboard')
      .setDescription('Show the Dead by Daylight leaderboard for one stat.')
      .addStringOption((opt) =>
        opt
          .setName('stat')
          .setDescription('Stat to rank by (default: Escapes)')
          .setRequired(false)
          .addChoices(...STAT_CHOICES),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('refresh').setDescription('Force-refresh your own Dead by Daylight stats.'),
  );

function statValue(snapshot: { stats: unknown }, statDef: GameStatDef): number {
  return (snapshot.stats as Record<string, number>)[statDef.id] ?? 0;
}

async function fetchLeaderboardPage(
  ctx: PluginContext,
  guildId: string,
  statDef: GameStatDef,
  page: number,
): Promise<LeaderboardPage> {
  const rows = await ctx.prisma.gameStatSnapshot.findMany({
    where: { guildId, game: GAME.key },
    select: { userId: true, stats: true },
  });
  const snapshots: LeaderboardSnapshot[] = rows.map((row) => ({
    userId: row.userId,
    stats: row.stats as Record<string, number>,
  }));
  return buildLeaderboard(snapshots, statDef, page, LEADERBOARD_PAGE_SIZE);
}

function buildLeaderboardEmbed(
  result: LeaderboardPage,
  statDef: GameStatDef,
  t: (key: string, vars?: Record<string, string | number>) => string,
): EmbedBuilder {
  const lines =
    result.rows.length > 0
      ? result.rows.map(
          (row) => `**#${row.rank}** ${userMention(row.userId)} — ${formatStatValue(row.value, statDef.kind)}`,
        )
      : [t('dbd.leaderboard.empty')];
  return listEmbed(
    t('dbd.leaderboard.title', { stat: statDef.label, page: result.page, totalPages: result.totalPages }),
    lines,
  ).setFooter({ text: t('dbd.leaderboard.footer') });
}

function buildLeaderboardRow(
  ownerId: string,
  statId: string,
  page: number,
  totalPages: number,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId('gamestats', 'lb-page', ownerId, statId, String(page - 1)))
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 1),
    new ButtonBuilder()
      .setCustomId(buildCustomId('gamestats', 'lb-page', ownerId, statId, String(page + 1)))
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages),
  );
}

async function handleLink(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const input = interaction.options.getString('account', true).trim();

  const resolved = await resolveSteamId(ctx, input);
  if (!resolved.ok) {
    await interaction.reply({
      embeds: [
        errorEmbed(t(resolved.error === 'not_found' ? 'dbd.link.notFound' : 'dbd.link.lookupFailed', { input })),
      ],
      ephemeral: true,
    });
    return;
  }

  // Validate the account's Dead by Daylight stats are actually fetchable BEFORE saving anything — one live Steam
  // call (`bypassCache: true` — a member linking or re-linking needs their CURRENT profile state, never a stale
  // cache entry from before they fixed a privacy setting). The fresh, curated result is still cached afterward,
  // so `refreshMemberStats` right below reuses it instead of hitting Steam again.
  const statsResult = await getGameStats(ctx, resolved.steamId64, GAME.steamAppId, {
    bypassCache: true,
    keepKeys: providerStatKeys(GAME),
  });
  if (!statsResult.ok) {
    const key =
      statsResult.reason === 'private'
        ? 'dbd.link.private'
        : statsResult.reason === 'no_game'
          ? 'dbd.link.noGame'
          : statsResult.reason === 'transient'
            ? 'dbd.link.transientError'
            : 'dbd.link.fetchFailed';
    await interaction.reply({ embeds: [errorEmbed(t(key))], ephemeral: true });
    return;
  }

  // Self-reported, unverified linking (no Steam sign-in — see manifest.ts's privacyNotes): the only guard
  // against one Steam account being claimed by multiple members in the same guild is this proactive check plus
  // the `@@unique([guildId, provider, externalId])` constraint's P2002 catch below for the race window between
  // this check and the upsert committing.
  const claimedByAnother = await ctx.prisma.gameAccountLink.findFirst({
    where: { guildId, provider: 'STEAM', externalId: resolved.steamId64, NOT: { userId: interaction.user.id } },
  });
  if (claimedByAnother) {
    await interaction.reply({ embeds: [errorEmbed(t('dbd.link.duplicate'))], ephemeral: true });
    return;
  }

  // Read the caller's existing link (if any) BEFORE upserting, purely to detect a re-link to a different Steam
  // account below — the persona-name staleness fix needs to know whether `externalId` is about to change.
  const existingLink = await ctx.prisma.gameAccountLink.findUnique({
    where: { guildId_userId_provider: { guildId, userId: interaction.user.id, provider: 'STEAM' } },
  });
  const isReLinkToNewAccount = existingLink != null && existingLink.externalId !== resolved.steamId64;

  const summary = await getPlayerSummary(ctx, resolved.steamId64);

  // Member self-service data: deliberately not audited (same reasoning as
  // community/commands/birthday.ts's handleSet — no audit trail of personal, self-managed opt-in data).
  let link: GameAccountLink;
  try {
    link = await ctx.prisma.gameAccountLink.upsert({
      where: { guildId_userId_provider: { guildId, userId: interaction.user.id, provider: 'STEAM' } },
      create: {
        guildId,
        userId: interaction.user.id,
        provider: 'STEAM',
        externalId: resolved.steamId64,
        externalName: summary?.personaName,
      },
      update: {
        externalId: resolved.steamId64,
        // Same account re-linked and the fresh persona lookup failed: `undefined` leaves the cached name as-is
        // (same graceful-degrade as `service.ts`'s `refreshMemberStats`). Re-linking to a DIFFERENT account and
        // the lookup failed: null it out instead of keeping the PREVIOUS account's name, which would misattribute
        // whose data the new account's stats belong to.
        externalName: summary?.personaName ?? (isReLinkToNewAccount ? null : undefined),
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      await interaction.reply({ embeds: [errorEmbed(t('dbd.link.duplicate'))], ephemeral: true });
      return;
    }
    throw err;
  }

  await refreshMemberStats(ctx, link, GAME);

  await interaction.reply({
    embeds: [successEmbed(t('dbd.link.success', { name: summary?.personaName ?? resolved.steamId64 }))],
    ephemeral: true,
  });
}

async function handleUnlink(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const userId = interaction.user.id;

  // Member self-service data: deliberately not audited (same reasoning as handleLink above / birthday.ts).
  const [deletedLink] = await Promise.all([
    ctx.prisma.gameAccountLink.deleteMany({ where: { guildId, userId, provider: 'STEAM' } }),
    ctx.prisma.gameStatSnapshot.deleteMany({ where: { guildId, userId } }),
  ]);

  await interaction.reply({
    embeds: [successEmbed(t(deletedLink.count > 0 ? 'dbd.unlink.done' : 'dbd.unlink.none'))],
    ephemeral: true,
  });
}

async function handleStats(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const target = interaction.options.getUser('member') ?? interaction.user;
  const isSelf = target.id === interaction.user.id;

  const link = await ctx.prisma.gameAccountLink.findUnique({
    where: { guildId_userId_provider: { guildId, userId: target.id, provider: 'STEAM' } },
  });
  if (!link) {
    await interaction.reply({
      embeds: [
        errorEmbed(
          isSelf ? t('dbd.stats.unlinkedSelf') : t('dbd.stats.unlinkedOther', { user: userMention(target.id) }),
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  const snapshot = await ctx.prisma.gameStatSnapshot.findUnique({
    where: { guildId_userId_game: { guildId, userId: target.id, game: GAME.key } },
  });
  if (!snapshot) {
    await interaction.reply({
      embeds: [errorEmbed(t('dbd.stats.noSnapshot', { user: userMention(target.id) }))],
      ephemeral: true,
    });
    return;
  }

  const fields = GAME.stats.map((statDef) => ({
    name: statDef.label,
    value: formatStatValue(statValue(snapshot, statDef), statDef.kind),
    inline: true,
  }));

  let description = t('dbd.stats.fetched', { when: time(snapshot.fetchedAt, TimestampStyles.RelativeTime) });
  if (snapshot.lastError) {
    description += `\n${t('dbd.stats.staleNote', { reason: t(`dbd.stats.reason.${snapshot.lastError}`) })}`;
  }

  const embed = brandEmbed()
    .setTitle(t('dbd.stats.title', { name: link.externalName ?? target.username }))
    .setThumbnail(target.displayAvatarURL())
    .setDescription(description)
    .addFields(fields);

  await interaction.reply({ embeds: [embed], ephemeral: false, allowedMentions: { parse: [] } });
}

async function handleLeaderboard(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const statId = interaction.options.getString('stat') ?? DEFAULT_STAT.id;
  const statDef = getStatDef(GAME, statId) ?? DEFAULT_STAT;

  const result = await fetchLeaderboardPage(ctx, guildId, statDef, 1);
  const embed = buildLeaderboardEmbed(result, statDef, t);
  const components =
    result.totalPages > 1
      ? [buildLeaderboardRow(interaction.user.id, statDef.id, result.page, result.totalPages)]
      : [];

  await interaction.reply({ embeds: [embed], components, ephemeral: false, allowedMentions: { parse: [] } });
}

async function handleRefresh(c: CommandContext): Promise<void> {
  const { interaction, ctx, guildId, t } = c;
  const userId = interaction.user.id;

  const link = await ctx.prisma.gameAccountLink.findUnique({
    where: { guildId_userId_provider: { guildId, userId, provider: 'STEAM' } },
  });
  if (!link) {
    await interaction.reply({ embeds: [errorEmbed(t('dbd.refresh.unlinked'))], ephemeral: true });
    return;
  }

  const limit = await ctx.rateLimiter.consume(`gamestats:dbd-refresh:${guildId}:${userId}`, 1, REFRESH_COOLDOWN_MS);
  if (!limit.allowed) {
    const retryAt = new Date(Date.now() + limit.resetMs);
    await interaction.reply({
      embeds: [errorEmbed(t('dbd.refresh.tooSoon', { when: time(retryAt, TimestampStyles.RelativeTime) }))],
      ephemeral: true,
    });
    return;
  }

  // `bypassCache: true` — a member explicitly asking to refresh needs their CURRENT Steam state, never a Redis
  // hit from up to 10 minutes ago (that would make "refresh" a no-op right after fixing a privacy setting).
  const outcome = await refreshMemberStats(ctx, link, GAME, { bypassCache: true });
  const key = outcome.ok
    ? 'dbd.refresh.done'
    : outcome.reason === 'private'
      ? 'dbd.refresh.private'
      : outcome.reason === 'no_game'
        ? 'dbd.refresh.noGame'
        : outcome.reason === 'transient'
          ? 'dbd.refresh.transientError'
          : 'dbd.refresh.error';

  await interaction.reply({
    embeds: [outcome.ok ? successEmbed(t(key)) : errorEmbed(t(key))],
    ephemeral: true,
  });
}

export const command: PluginCommand = {
  data,
  requirement: { guildOnly: true, cooldown: { seconds: 5, scope: 'user' } },
  async execute(c) {
    const sub = c.interaction.options.getSubcommand(true);
    if (sub === 'link') return handleLink(c);
    if (sub === 'unlink') return handleUnlink(c);
    if (sub === 'stats') return handleStats(c);
    if (sub === 'leaderboard') return handleLeaderboard(c);
    return handleRefresh(c);
  },
};

const leaderboardPageComponent: ComponentHandler = {
  action: 'lb-page',
  kind: 'button',
  ownerOnly: true,
  async handler(c) {
    const interaction = c.interaction as ButtonInteraction<'cached'>;
    const [ownerId, statId, pageStr] = c.args;
    const statDef = getStatDef(GAME, statId ?? '') ?? DEFAULT_STAT;
    const page = Math.max(1, Number(pageStr) || 1);

    const result = await fetchLeaderboardPage(c.ctx, c.guildId, statDef, page);
    const embed = buildLeaderboardEmbed(result, statDef, c.t);
    await interaction.update({
      embeds: [embed],
      components: [buildLeaderboardRow(ownerId ?? interaction.user.id, statDef.id, result.page, result.totalPages)],
    });
  },
};

export const dbdComponents: ComponentHandler[] = [leaderboardPageComponent];
