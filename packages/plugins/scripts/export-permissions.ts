#!/usr/bin/env tsx
// `pnpm --filter @pavisie/plugins export:permissions` (root alias: `pnpm docs:permissions`) — walks
// `allManifests` and renders `docs/PERMISSIONS.md` deterministically, so the permissions matrix in the README
// (and the doc itself) can never drift from what each plugin's `manifest.ts` actually declares. Mirrors
// `export-commands.ts`'s shape (ARCHITECTURE.md §17): CI runs this and fails on `git diff --exit-code`.
//
// Two things below are curated prose, not derived from the manifest's typed fields, because
// `PluginManifest.privilegedIntents` is just a list of intent names with no per-intent "what degrades" text
// field (ARCHITECTURE.md §7.2): `INTENT_DEGRADATION` and the plugin dependency note under Enforcer. Everything
// else — every permission row, every optional/fallback string, every intent-needing-plugin list, the invite
// scopes and permission integer — comes straight from `allManifests` / `@pavisie/core`.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits, PermissionsBitField, type PermissionResolvable } from 'discord.js';
import { describePermission, INVITE_PERMISSIONS_BITFIELD, buildInviteUrl } from '@pavisie/core';
import { allManifests } from '../src/manifests';
import type { PluginManifest, PrivilegedIntent } from '../src/sdk';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUTPUT = join(REPO_ROOT, 'docs', 'PERMISSIONS.md');

const PRIVILEGED_INTENTS: PrivilegedIntent[] = ['GuildMembers', 'MessageContent', 'GuildPresences'];

/** What each plugin loses (never crashes on) when a privileged intent it lists is not enabled for the bot. */
const INTENT_DEGRADATION: Partial<Record<string, Partial<Record<PrivilegedIntent, string>>>> = {
  automod: {
    MessageContent:
      'Content-dependent rules (duplicate messages, invite links, scam links, regex/word filters, caps, repeated characters, attachments) show as inactive instead of evaluating; join-based rules are unaffected.',
    GuildMembers:
      'The account-age gate and raid (join-burst) detection rules cannot evaluate and show as inactive.',
  },
  enforcer: {
    MessageContent:
      'Automatic flagging (matching messages as they are sent) is unavailable. Enforcer still works fully in manual mode — the "Flag for review" context menu and `/enforcer flag` always have the message content available regardless of this intent.',
  },
  logging: {
    GuildMembers: 'Member join/leave logs and invite-use attribution on join are unavailable.',
    MessageContent:
      'Message edit/delete logs still fire, but record metadata (author, channel, time) only — never the before/after text.',
  },
  tickets: {
    MessageContent: 'Transcripts still record who said something and when, but not the message text itself.',
  },
  roles: {
    GuildMembers:
      'Welcome/goodbye messages, the account-age gate, membership screening, and role persistence on rejoin cannot function — the bot is not told about join/leave events.',
  },
  engagement: {
    MessageContent:
      "Leveling, XP, and reputation are unaffected (message events fire regardless of content). Only the starboard's message-content preview in its embed is unavailable and falls back to a jump link.",
  },
};

function permissionName(permission: PermissionResolvable): string {
  try {
    const resolved = PermissionsBitField.resolve(permission);
    return describePermission(resolved);
  } catch {
    return String(permission);
  }
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderPluginPermissionsTable(manifest: PluginManifest): string {
  if (manifest.permissions.length === 0) {
    return '_No Discord permissions declared — every command replies over the interaction token and needs no channel-level permission._\n';
  }
  const rows = manifest.permissions.map(
    (p) =>
      `| ${escapeCell(permissionName(p.permission))} | ${escapeCell(p.feature)} | ${p.optional ? 'Optional' : 'Required'} | ${escapeCell(p.fallback)} |`,
  );
  return (
    ['| Permission | Feature | Required? | Fallback if missing |', '|---|---|---|---|', ...rows].join('\n') +
    '\n'
  );
}

function renderIntentsSection(manifests: PluginManifest[]): string {
  const sections: string[] = [];
  for (const intent of PRIVILEGED_INTENTS) {
    const needing = manifests.filter((m) => m.privilegedIntents?.includes(intent));
    if (needing.length === 0) continue;
    const rows = needing.map((m) => {
      const degradation =
        INTENT_DEGRADATION[m.id]?.[intent] ??
        '_(see the plugin README for what degrades without this intent)_';
      return `| ${m.name} (\`${m.id}\`) | ${escapeCell(degradation)} |`;
    });
    sections.push(
      [`### ${intent}`, '', '| Plugin | What degrades without it |', '|---|---|', ...rows].join('\n'),
    );
  }
  return sections.join('\n\n');
}

function renderInvite(): string {
  const permissions = INVITE_PERMISSIONS_BITFIELD;
  const flagNames = new PermissionsBitField(permissions).toArray();
  const rows = flagNames.map((name) => `- ${describePermission(PermissionFlagsBits[name])}`);
  return [
    `Permission integer: \`${permissions.toString()}\``,
    '',
    'Scopes: `bot`, `applications.commands`',
    '',
    `Example invite URL: \`${buildInviteUrl('YOUR_CLIENT_ID', permissions)}\``,
    '',
    'Permissions included (never Administrator):',
    '',
    ...rows,
  ].join('\n');
}

async function main(): Promise<void> {
  const manifests = allManifests;

  const pluginSections = manifests.map((m) => {
    const badges = [m.defaultEnabled ? 'enabled by default' : 'disabled by default', m.category];
    return [
      `### ${m.name} (\`${m.id}\`)`,
      '',
      `_${escapeCell(m.description)}_ (${badges.join(', ')})`,
      '',
      renderPluginPermissionsTable(m),
    ].join('\n');
  });

  const doc = `<!-- GENERATED FILE. Do not edit by hand — run \`pnpm docs:permissions\` (packages/plugins/scripts/export-permissions.ts), which renders this from every plugin's manifest.ts. CI fails if this file is stale. -->

# Permissions matrix

Every Discord permission Pavisie's plugins can use, why each one is needed, whether it's optional, and what
happens when it's missing. Generated from \`packages/plugins/src/*/manifest.ts\` via \`allManifests\` — this file
can never drift from what the bot actually declares. See also \`/permissions audit\` in Discord, which diffs this
same data against the bot's real permissions in your server.

The bot never requests **Administrator**. See "Invite permissions" below for the exact least-privilege set used
by the invite link the README and website generate.

## Permissions by plugin

${pluginSections.join('\n\n')}

## Privileged intents

Discord gates a few event categories behind "privileged intents" that must be turned on for the bot application
in the [Discord Developer Portal](https://discord.com/developers/applications) (Bot tab → Privileged Gateway
Intents) **and** in Pavisie's own \`.env\` (\`ENABLE_MESSAGE_CONTENT_INTENT\`, \`ENABLE_GUILD_MEMBERS_INTENT\`,
\`ENABLE_GUILD_PRESENCES_INTENT\`) before the features that need them come alive. Every plugin below degrades
gracefully (never crashes, never silently misbehaves) when a privileged intent it lists is off — see each row for
exactly what stops working.

Message Content additionally requires Discord's own approval once your bot is in 100+ servers ("Message Content
Intent" eligibility in the Developer Portal) — see the README's Discord Developer Portal setup section.

${renderIntentsSection(manifests)}

## Invite permissions

${renderInvite()}
`;

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, doc, 'utf8');
  // eslint-disable-next-line no-console -- CLI summary output
  console.log(`Wrote docs/PERMISSIONS.md from ${manifests.length} plugin manifest(s).`);
}

main().catch((err: unknown) => {
  console.error('export-permissions failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
