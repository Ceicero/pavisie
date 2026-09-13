// Seeds a single, clearly-labelled demo guild — never fictional live data.
// Run with `pnpm --filter @pavisie/database seed` (tsx prisma/seed.ts).
import { prisma } from '../src/client';
import { ensureGuild } from '../src/guild';

const DEMO_GUILD_ID = '000000000000000000';
const DEMO_GUILD_NAME = 'Pavisie Demo (seed)';
const SEED_ACTOR_ID = 'system-seed';

/** Plugin ids + their default enablement, mirrored from docs/ARCHITECTURE.md §7.1. */
const PLUGIN_DEFAULTS: { id: string; enabled: boolean }[] = [
  { id: 'admin', enabled: true },
  { id: 'moderation', enabled: true },
  { id: 'automod', enabled: true },
  { id: 'enforcer', enabled: false },
  { id: 'logging', enabled: true },
  { id: 'tickets', enabled: false },
  { id: 'roles', enabled: false },
  { id: 'engagement', enabled: true },
  { id: 'community', enabled: true },
  { id: 'economy', enabled: false },
  { id: 'utility', enabled: true },
  { id: 'media', enabled: false },
  { id: 'integrations', enabled: false },
  { id: 'ai', enabled: false },
];

async function main(): Promise<void> {
  const guild = await ensureGuild(prisma, {
    id: DEMO_GUILD_ID,
    name: DEMO_GUILD_NAME,
    ownerId: SEED_ACTOR_ID,
    memberCount: 1,
  });

  for (const plugin of PLUGIN_DEFAULTS) {
    await prisma.pluginState.upsert({
      where: { guildId_pluginId: { guildId: guild.id, pluginId: plugin.id } },
      create: { guildId: guild.id, pluginId: plugin.id, enabled: plugin.enabled, updatedBy: SEED_ACTOR_ID },
      update: { enabled: plugin.enabled },
    });
  }

  const existingRule = await prisma.automodRule.findFirst({
    where: { guildId: guild.id, type: 'INVITE_LINKS', deletedAt: null },
  });
  if (!existingRule) {
    await prisma.automodRule.create({
      data: {
        guildId: guild.id,
        name: 'Block unapproved invite links (demo)',
        type: 'INVITE_LINKS',
        enabled: true,
        dryRun: true,
        config: { allowOwnServerInvites: true },
        actions: [{ type: 'delete' }, { type: 'alert' }],
        exemptRoleIds: [],
        exemptChannelIds: [],
        exemptUserIds: [],
        trustedDomains: [],
        cooldownSeconds: 0,
        priority: 0,
        createdBy: SEED_ACTOR_ID,
      },
    });
  }

  const existingPolicy = await prisma.enforcerPolicy.findFirst({
    where: { guildId: guild.id, name: 'Invite links (seed example)', deletedAt: null },
  });
  if (!existingPolicy) {
    await prisma.enforcerPolicy.create({
      data: {
        guildId: guild.id,
        name: 'Invite links (seed example)',
        description: 'Flags messages containing Discord invite links for moderator review.',
        enabled: false,
        severity: 'LOW',
        matchers: [{ type: 'invite', value: '*' }],
        channelIds: [],
        exemptRoleIds: [],
        exemptChannelIds: [],
        createdBy: SEED_ACTOR_ID,
      },
    });
  }

  // ensureGuild() already created a default DataRetentionPolicy for the demo
  // guild; nothing further to do here beyond leaving the defaults in place.

  // eslint-disable-next-line no-console -- seed script output, not app logging
  console.log(`Seeded demo guild "${DEMO_GUILD_NAME}" (${guild.id}).`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
