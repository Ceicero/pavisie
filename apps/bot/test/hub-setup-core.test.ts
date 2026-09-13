// Tests for the root-level operator script `scripts/hub-setup.mjs` and its pure logic in
// `scripts/lib/hub-setup-core.mjs`. That script lives outside every workspace package (it configures a
// Discord server declaratively — see infra/hub/README.md), so it isn't covered by any package's vitest
// config and root has no vitest config of its own. It lives here because apps/bot already has a working
// vitest + tsc setup and is the package closest to what the script talks to (Discord, via the same
// discord-api-types the bot itself uses).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits, ChannelType } from 'discord-api-types/v10';
import * as hub from '../../../scripts/lib/hub-setup-core.mjs';
import { runHubSetup, parseArgs } from '../../../scripts/hub-setup.mjs';
import type { ExistingChannel, ExistingRole } from '../../../scripts/lib/hub-setup-core.d.mts';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PLAN_PATH = path.join(REPO_ROOT, 'infra', 'hub', 'hub-plan.json');

async function loadRealPlan() {
  return JSON.parse(await readFile(PLAN_PATH, 'utf8'));
}

// ---------------------------------------------------------------------------------------------------------
// Plan validation
// ---------------------------------------------------------------------------------------------------------

describe('validatePlan', () => {
  it('accepts the real hub plan checked into infra/hub/hub-plan.json', async () => {
    const plan = await loadRealPlan();
    const result = hub.validatePlan(plan);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects a plan missing required top-level fields', () => {
    const result = hub.validatePlan({});
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'missing guildId',
        'missing ownerUserId',
        'roles_top_to_bottom must be a non-empty array',
        'categories_in_order must be a non-empty array',
        'mutedOverwrites.deny must be an array',
        'missing messages',
      ]),
    );
  });

  it('rejects a channel with an unknown type', () => {
    const plan = {
      guildId: 'g',
      ownerUserId: 'u',
      roles_top_to_bottom: [{ name: 'Owner', permissions: [] }],
      categories_in_order: [{ name: 'Cat', channels: [{ name: 'chan', type: 'holographic' }] }],
      mutedOverwrites: { deny: [] },
      messages: { rules: ['hi'] },
    };
    const result = hub.validatePlan(plan);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining('unknown type "holographic"')]));
  });
});

// ---------------------------------------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------------------------------------

describe('normalizePlanRoles', () => {
  it('defaults pingRoles to hoist:false, mentionable:true unless overridden', () => {
    const specs = hub.normalizePlanRoles({
      roles_top_to_bottom: [{ name: 'Owner', color: '#fff', hoist: true, mentionable: false, permissions: ['Administrator'] }],
      pingRoles: [{ name: 'Stream Ping', color: '#9146ff' }, { name: 'Quiet Ping', color: '#000', mentionable: false }],
    });
    expect(specs.map((s) => s.name)).toEqual(['Owner', 'Stream Ping', 'Quiet Ping']);
    const streamPing = specs.find((s) => s.name === 'Stream Ping');
    expect(streamPing).toMatchObject({ hoist: false, mentionable: true, isPingRole: true });
    const quietPing = specs.find((s) => s.name === 'Quiet Ping');
    expect(quietPing!.mentionable).toBe(false); // explicit override respected
  });
});

describe('hexToInt', () => {
  it('parses a hex color string', () => {
    expect(hub.hexToInt('#f1c40f')).toBe(0xf1c40f);
  });
  it('falls back to 0 for missing/invalid input', () => {
    expect(hub.hexToInt(undefined)).toBe(0);
    expect(hub.hexToInt('#zzzzzz')).toBe(0);
  });
});

describe('permissionsToBitfield', () => {
  it('sums known permission names and reports unknown ones', () => {
    const { value, unknown } = hub.permissionsToBitfield(['Administrator', 'ManageGuild', 'NotARealPermission']);
    expect(value).toBe(PermissionFlagsBits.Administrator | PermissionFlagsBits.ManageGuild);
    expect(unknown).toEqual(['NotARealPermission']);
  });
  it('returns 0n for an empty/undefined list', () => {
    expect(hub.permissionsToBitfield(undefined).value).toBe(0n);
    expect(hub.permissionsToBitfield([]).value).toBe(0n);
  });
});

describe('diffRolePayload', () => {
  const spec = { name: 'Admin', color: '#e74c3c', hoist: true, mentionable: true, permissions: ['ManageGuild'] };

  it('produces no patch when the existing role already matches', () => {
    const existing = { id: 'r1', name: 'Admin', color: 0xe74c3c, hoist: true, mentionable: true, permissions: String(PermissionFlagsBits.ManageGuild) };
    const { hasChanges, patch } = hub.diffRolePayload(existing, spec);
    expect(hasChanges).toBe(false);
    expect(patch).toEqual({});
  });

  it('only includes fields that actually differ', () => {
    const existing = { id: 'r1', name: 'Admin', color: 0x000000, hoist: true, mentionable: true, permissions: String(PermissionFlagsBits.ManageGuild) };
    const { hasChanges, patch } = hub.diffRolePayload(existing, spec);
    expect(hasChanges).toBe(true);
    expect(patch).toEqual({ color: 0xe74c3c });
  });

  it('surfaces a note for an unknown permission name without throwing', () => {
    const existing = { id: 'r1', name: 'Admin', color: 0xe74c3c, hoist: true, mentionable: true, permissions: '0' };
    const { notes } = hub.diffRolePayload(existing, { ...spec, permissions: ['TotallyMadeUp'] });
    expect(notes[0]).toMatch(/unknown permission name.*TotallyMadeUp/);
  });
});

describe('resolveRoleTarget', () => {
  const existingRoles = [
    { id: '1', name: 'Admin' },
    { id: '2', name: 'Other' },
  ];

  it('matches by id from the plan.existing map first', () => {
    const found = hub.resolveRoleTarget({ spec: { name: 'Admin' }, existingRoles, existingIdMap: { Admin: '1' } });
    expect(found!.id).toBe('1');
  });

  it('falls back to an exact name match', () => {
    const found = hub.resolveRoleTarget({ spec: { name: 'Other' }, existingRoles, existingIdMap: {} });
    expect(found!.id).toBe('2');
  });

  it('returns null when nothing matches', () => {
    const found = hub.resolveRoleTarget({ spec: { name: 'Missing' }, existingRoles, existingIdMap: {} });
    expect(found).toBeNull();
  });
});

describe('planRoleActions', () => {
  const specs = hub.normalizePlanRoles({
    roles_top_to_bottom: [
      { name: 'Owner', color: '#fff', hoist: true, mentionable: false, permissions: ['Administrator'] },
      { name: 'Admin', color: '#e74c3c', hoist: true, mentionable: true, permissions: ['ManageGuild'] },
      { name: 'Ancient', color: '#000', hoist: false, mentionable: false, permissions: [] },
    ],
  });

  it('classifies create / update / noop / skip_above_bot correctly', () => {
    const existingRoles = [
      { id: 'admin-id', name: 'Admin', color: 0, hoist: false, mentionable: false, permissions: '0', position: 3 },
      { id: 'ancient-id', name: 'Ancient', color: 0, hoist: false, mentionable: false, permissions: '0', position: 99 },
    ];
    const { actions, notes } = hub.planRoleActions({
      specs,
      existingRoles,
      existingIdMap: {},
      botTopPosition: 10,
    });

    const byName = Object.fromEntries(actions.map((a) => [a.name, a]));
    expect(byName.Owner.type).toBe('create');
    expect(byName.Admin.type).toBe('update');
    expect((byName.Admin as any).patch).toHaveProperty('color');
    expect(byName.Ancient.type).toBe('skip_above_bot');
    expect(notes.some((n) => n.includes('Ancient'))).toBe(true);
  });

  it('reports noop when an existing role already matches exactly', () => {
    // specs[0] ("Owner") was built above from color: '#fff' — hexToInt does not expand 3-digit CSS
    // shorthand (the real plan only ever uses 6-digit hex codes), so '#fff' parses to 0xfff, not
    // 0xffffff. Match that here rather than asserting hexToInt should expand shorthand it never sees.
    const existingRoles = [{ id: 'owner-id', name: 'Owner', color: 0xfff, hoist: true, mentionable: false, permissions: String(PermissionFlagsBits.Administrator), position: 5 }];
    const { actions } = hub.planRoleActions({ specs: [specs[0]], existingRoles, existingIdMap: {}, botTopPosition: 10 });
    expect(actions[0]).toMatchObject({ type: 'noop', id: 'owner-id' });
  });
});

describe('computeRolePositions', () => {
  it('assigns descending positions below the bot, skipping named roles', () => {
    const { positions, skipped } = hub.computeRolePositions({
      orderedNames: ['A', 'B', 'C'],
      nameToId: { A: 'idA', B: 'idB', C: 'idC' },
      skipNames: ['B'],
      botTopPosition: 5,
    });
    expect(positions).toEqual([
      { id: 'idA', position: 4 },
      { id: 'idC', position: 3 },
    ]);
    expect(skipped).toEqual(['B']);
  });

  it('skips everything when there is no room above @everyone', () => {
    const { positions, skipped } = hub.computeRolePositions({
      orderedNames: ['A', 'B'],
      nameToId: { A: 'idA', B: 'idB' },
      skipNames: [],
      botTopPosition: 1,
    });
    expect(positions).toEqual([]);
    expect(skipped).toEqual(['A', 'B']);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Categories & channels
// ---------------------------------------------------------------------------------------------------------

describe('resolveCategoryTarget / computeCategoryPatch', () => {
  it('matches an existing category by exact name and only patches position when needed', () => {
    const existingChannels = [{ id: 'cat-1', name: '💬 COMMUNITY', type: ChannelType.GuildCategory, position: 3 }];
    const found = hub.resolveCategoryTarget({ spec: { name: '💬 COMMUNITY' }, existingChannels })!;
    expect(found.id).toBe('cat-1');
    expect(hub.computeCategoryPatch({ existing: found, position: 3 }).hasChanges).toBe(false);
    expect(hub.computeCategoryPatch({ existing: found, position: 0 }).patch).toEqual({ position: 0 });
  });
});

describe('resolveChannelTarget', () => {
  const existingChannels = [
    { id: 'by-key-id', name: 'support' },
    { id: 'by-name-id', name: 'rules' },
    { id: 'by-fallback-id', name: 'general' },
  ];
  const existingIdMap = { support: 'by-key-id' };

  it('resolves via existingKey first', () => {
    const found = hub.resolveChannelTarget({ spec: { name: 'support', existingKey: 'support' }, existingChannels, existingIdMap });
    expect(found!.id).toBe('by-key-id');
  });

  it('resolves via existingName when no existingKey matches', () => {
    const found = hub.resolveChannelTarget({ spec: { name: 'rules', existingName: 'rules' }, existingChannels, existingIdMap });
    expect(found!.id).toBe('by-name-id');
  });

  it('falls back to an exact match on the plan name', () => {
    const found = hub.resolveChannelTarget({ spec: { name: 'general' }, existingChannels, existingIdMap });
    expect(found!.id).toBe('by-fallback-id');
  });

  it('returns null for a channel that does not exist yet', () => {
    const found = hub.resolveChannelTarget({ spec: { name: 'brand-new' }, existingChannels, existingIdMap });
    expect(found).toBeNull();
  });
});

describe('isTrivialRename', () => {
  it('treats emoji-prefix/case/whitespace-only differences as trivial', () => {
    expect(hub.isTrivialRename('rules', '📖 Rules')).toBe(true);
    expect(hub.isTrivialRename('bot-commands', ' BOT-COMMANDS ')).toBe(true);
  });
  it('treats a genuinely different name as non-trivial', () => {
    expect(hub.isTrivialRename('general', 'off-topic')).toBe(false);
  });
});

describe('computeChannelPatch', () => {
  const existing = {
    id: 'chan-1',
    name: 'general',
    topic: 'old topic',
    rate_limit_per_user: 0,
    parent_id: 'old-cat',
    position: 5,
    type: ChannelType.GuildText,
  };

  it('only patches fields that changed', () => {
    const { patch, hasChanges, notes } = hub.computeChannelPatch({
      existing,
      spec: { name: 'general', topic: 'new topic', slowmode: 10 },
      categoryId: 'new-cat',
      position: 2,
      channelType: 'text',
    });
    expect(hasChanges).toBe(true);
    expect(patch).toEqual({ topic: 'new topic', rate_limit_per_user: 10, parent_id: 'new-cat', position: 2 });
    expect(notes).toEqual([]);
  });

  it('renames only on a trivial diff, otherwise leaves the name and notes why', () => {
    const trivial = hub.computeChannelPatch({
      existing: { ...existing, name: 'rules' },
      spec: { name: '📖 rules' },
      categoryId: 'old-cat',
      position: 5,
      channelType: 'text',
    });
    expect(trivial.patch.name).toBe('📖 rules');

    const nonTrivial = hub.computeChannelPatch({
      existing: { ...existing, name: 'general' },
      spec: { name: 'off-topic' },
      categoryId: 'old-cat',
      position: 5,
      channelType: 'text',
    });
    expect(nonTrivial.patch.name).toBeUndefined();
    expect(nonTrivial.notes[0]).toMatch(/non-trivially/);
  });

  it('allows text<->announcement type conversion but not other type changes', () => {
    const toAnnouncement = hub.computeChannelPatch({
      existing,
      spec: { name: 'general' },
      categoryId: 'old-cat',
      position: 5,
      channelType: 'announcement',
    });
    expect(toAnnouncement.patch.type).toBe(ChannelType.GuildAnnouncement);

    const voiceExisting = { ...existing, type: ChannelType.GuildVoice };
    const toText = hub.computeChannelPatch({
      existing: voiceExisting,
      spec: { name: 'general' },
      categoryId: 'old-cat',
      position: 5,
      channelType: 'text',
    });
    expect(toText.patch.type).toBeUndefined();
    expect(toText.notes[0]).toMatch(/can't safely convert/);
  });
});

describe('computeChannelCreatePayload', () => {
  it('builds the full create payload, including optional topic/slowmode', () => {
    const payload = hub.computeChannelCreatePayload({
      spec: { name: 'media', topic: 'Clips and memes', slowmode: 10 },
      categoryId: 'cat-1',
      position: 1,
      channelType: 'text',
    });
    expect(payload).toEqual({
      name: 'media',
      type: ChannelType.GuildText,
      parent_id: 'cat-1',
      position: 1,
      topic: 'Clips and memes',
      rate_limit_per_user: 10,
    });
  });
});

describe('computeChannelOverwrites', () => {
  const roleNameToId = { Helper: 'helper-id', Moderator: 'mod-id', Admin: 'admin-id', Owner: 'owner-id' };

  it('denies @everyone from spec.everyone.deny', () => {
    const { overwrites } = hub.computeChannelOverwrites({
      spec: { name: 'welcome', everyone: { deny: ['SendMessages'] } },
      channelType: 'text',
      roleNameToId,
      everyoneId: 'guild-id',
      mutedRoleId: null,
      mutedDenyList: [],
      botUserId: null,
      boosterRoleId: null,
    });
    expect(overwrites).toEqual([
      { id: 'guild-id', type: hub.ROLE_OVERWRITE_TYPE, allow: '0', deny: String(PermissionFlagsBits.SendMessages) },
    ]);
  });

  it('handles roleOnly: denies everyone, allows listed roles, and notes an unresolvable role name', () => {
    const { overwrites, notes } = hub.computeChannelOverwrites({
      spec: { name: 'server-owners', roleOnly: ['Helper', 'GhostRole'] },
      channelType: 'text',
      roleNameToId,
      everyoneId: 'guild-id',
      mutedRoleId: null,
      mutedDenyList: [],
      botUserId: null,
      boosterRoleId: null,
    });
    const everyone = overwrites.find((o) => o.id === 'guild-id')!;
    expect(everyone.deny).toBe(String(PermissionFlagsBits.ViewChannel));
    const helper = overwrites.find((o) => o.id === 'helper-id')!;
    expect(BigInt(helper.allow) & PermissionFlagsBits.ViewChannel).toBe(PermissionFlagsBits.ViewChannel);
    expect(BigInt(helper.allow) & PermissionFlagsBits.SendMessages).toBe(PermissionFlagsBits.SendMessages);
    expect(overwrites.some((o) => o.id === undefined)).toBe(false);
    expect(notes[0]).toMatch(/GhostRole.*not found/);
  });

  it('handles boosterOnly with a resolvable booster role and staff always allowed', () => {
    const { overwrites, notes } = hub.computeChannelOverwrites({
      spec: { name: 'booster-lounge', boosterOnly: true },
      channelType: 'text',
      roleNameToId,
      everyoneId: 'guild-id',
      mutedRoleId: null,
      mutedDenyList: [],
      botUserId: null,
      boosterRoleId: 'booster-id',
    });
    expect(overwrites.find((o) => o.id === 'booster-id')!.allow).toBe(String(PermissionFlagsBits.ViewChannel));
    expect(overwrites.some((o) => o.id === 'helper-id')).toBe(true);
    expect(overwrites.some((o) => o.id === 'owner-id')).toBe(true);
    expect(notes).toEqual([]);
  });

  it('notes when boosterOnly has no resolvable booster role, but still restricts @everyone and allows staff', () => {
    const { overwrites, notes } = hub.computeChannelOverwrites({
      spec: { name: 'booster-lounge', boosterOnly: true },
      channelType: 'text',
      roleNameToId,
      everyoneId: 'guild-id',
      mutedRoleId: null,
      mutedDenyList: [],
      botUserId: null,
      boosterRoleId: null,
    });
    expect(overwrites.find((o) => o.id === 'guild-id')!.deny).toBe(String(PermissionFlagsBits.ViewChannel));
    expect(overwrites.some((o) => o.id === 'helper-id')).toBe(true);
    expect(notes[0]).toMatch(/no premium-subscriber/i);
  });

  it('grants botNeeds and always extends BOT_ALWAYS_VIEW_CHANNELS with ViewChannel/SendMessages/EmbedLinks', () => {
    const { overwrites } = hub.computeChannelOverwrites({
      spec: { name: 'mod-log', roleOnly: ['Helper'], botNeeds: ['ViewChannel', 'SendMessages', 'EmbedLinks'] },
      channelType: 'text',
      roleNameToId,
      everyoneId: 'guild-id',
      mutedRoleId: null,
      mutedDenyList: [],
      botUserId: 'bot-id',
      boosterRoleId: null,
    });
    const bot = overwrites.find((o) => o.id === 'bot-id')!;
    expect(bot.type).toBe(hub.MEMBER_OVERWRITE_TYPE);
    const expected = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages | PermissionFlagsBits.EmbedLinks;
    expect(BigInt(bot.allow)).toBe(expected);
  });

  it('applies the guild-wide Muted deny list to the Muted role overwrite', () => {
    const { overwrites } = hub.computeChannelOverwrites({
      spec: { name: 'general' },
      channelType: 'text',
      roleNameToId,
      everyoneId: 'guild-id',
      mutedRoleId: 'muted-id',
      mutedDenyList: ['SendMessages', 'AddReactions'],
      botUserId: null,
      boosterRoleId: null,
    });
    expect(overwrites).toEqual([
      {
        id: 'muted-id',
        type: hub.ROLE_OVERWRITE_TYPE,
        allow: '0',
        deny: String(PermissionFlagsBits.SendMessages | PermissionFlagsBits.AddReactions),
      },
    ]);
  });

  it('resolves an allow/deny conflict on the same id in favor of deny (fail closed)', () => {
    // Muted is (unusually) also in roleOnly, which would allow it SendMessages — but Muted's own
    // guild-wide deny list also denies SendMessages. Deny must win.
    const { overwrites } = hub.computeChannelOverwrites({
      spec: { name: 'weird-channel', roleOnly: ['Muted'] },
      channelType: 'text',
      roleNameToId: { Muted: 'muted-id' },
      everyoneId: 'guild-id',
      mutedRoleId: 'muted-id',
      mutedDenyList: ['SendMessages'],
      botUserId: null,
      boosterRoleId: null,
    });
    const muted = overwrites.find((o) => o.id === 'muted-id')!;
    expect(BigInt(muted.deny) & PermissionFlagsBits.SendMessages).toBe(PermissionFlagsBits.SendMessages);
    expect(BigInt(muted.allow) & PermissionFlagsBits.SendMessages).toBe(0n);
    // ViewChannel was only ever allowed, never denied, so it survives.
    expect(BigInt(muted.allow) & PermissionFlagsBits.ViewChannel).toBe(PermissionFlagsBits.ViewChannel);
  });
});

// ---------------------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------------------

describe('chunkMessage', () => {
  it('joins short lines into a single message', () => {
    const chunks = hub.chunkMessage(['one', 'two', 'three']);
    expect(chunks).toEqual(['one\n\ntwo\n\nthree']);
  });

  it('splits long content into multiple messages, each within the limit', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}: ${'x'.repeat(150)}`);
    const chunks = hub.chunkMessage(lines, { maxLen: 500 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
    // No line's text was dropped.
    for (const line of lines) expect(chunks.some((c) => c.includes(line))).toBe(true);
  });

  it('hard-splits a single line that alone exceeds the limit', () => {
    const chunks = hub.chunkMessage(['x'.repeat(4500)], { maxLen: 2000 });
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
    expect(chunks.join('')).toBe('x'.repeat(4500));
  });

  it('keeps the real rules message under Discord\'s 2000-char limit per chunk', async () => {
    const plan = await loadRealPlan();
    const chunks = hub.chunkMessage(plan.messages.rules);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(2000);
  });
});

describe('hasBotPosted', () => {
  it('detects a prior post by the bot among recent messages', () => {
    expect(hub.hasBotPosted([{ author: { id: 'user' } }, { author: { id: 'bot' } }], 'bot')).toBe(true);
    expect(hub.hasBotPosted([{ author: { id: 'user' } }], 'bot')).toBe(false);
    expect(hub.hasBotPosted([], 'bot')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------------------------------------

describe('parseArgs', () => {
  it('defaults to dry-run when neither flag is given', () => {
    expect(parseArgs(['--plan', 'infra/hub/hub-plan.json'])).toMatchObject({ dryRun: true, apply: false });
  });
  it('honors --apply', () => {
    expect(parseArgs(['--plan', 'x.json', '--apply'])).toMatchObject({ dryRun: false, apply: true });
  });
  it('accepts --plan=<path>', () => {
    expect(parseArgs(['--plan=x.json']).plan).toBe('x.json');
  });
  it('rejects passing both --dry-run and --apply', () => {
    expect(() => parseArgs(['--plan', 'x.json', '--dry-run', '--apply'])).toThrow();
  });
  it('requires --plan', () => {
    expect(() => parseArgs([])).toThrow(/--plan/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// End-to-end dry run against the real plan, with a fully mocked Discord REST client (no network, no token).
// ---------------------------------------------------------------------------------------------------------

function buildMockGuildState(plan: any): { existingRoles: ExistingRole[]; existingChannels: ExistingChannel[] } {
  const everyoneRole = { id: plan.guildId, name: '@everyone', position: 0, color: 0, hoist: false, mentionable: false, permissions: '0' };
  const botRole = { id: 'bot-role-id', name: 'Pavisie', position: 10, color: 0, hoist: false, mentionable: false, permissions: '0' };
  const existingRoles = [
    everyoneRole,
    botRole,
    { id: plan.existing.roles.Admin, name: 'Admin', position: 5, color: 0, hoist: false, mentionable: false, permissions: '0' },
    { id: plan.existing.roles.Moderator, name: 'Moderator', position: 4, color: 0, hoist: false, mentionable: false, permissions: '0' },
    { id: plan.existing.roles.Helper, name: 'Helper', position: 3, color: 0, hoist: false, mentionable: false, permissions: '0' },
    { id: plan.existing.roles.Muted, name: 'Muted', position: 1, color: 0, hoist: false, mentionable: false, permissions: '0' },
  ];

  const existingChannels: ExistingChannel[] = Object.entries(plan.existing.channels as Record<string, string>).map(([key, id], i) => ({
    id,
    name: key,
    type: ChannelType.GuildText,
    parent_id: null,
    position: i,
    topic: null,
    rate_limit_per_user: 0,
  }));
  existingChannels.push(
    { id: 'rules-id', name: 'rules', type: ChannelType.GuildText, parent_id: null, position: 20, topic: null, rate_limit_per_user: 0 },
    { id: 'updates-id', name: 'updates', type: ChannelType.GuildText, parent_id: null, position: 21, topic: null, rate_limit_per_user: 0 },
    { id: 'general-id', name: 'general', type: ChannelType.GuildText, parent_id: null, position: 22, topic: null, rate_limit_per_user: 0 },
  );

  return { existingRoles, existingChannels };
}

function buildMockClient(plan: any) {
  const { existingRoles, existingChannels } = buildMockGuildState(plan);
  const calledMutations: string[] = [];
  const failIfCalled = (name: string) =>
    vi.fn(async () => {
      calledMutations.push(name);
      throw new Error(`${name} must not be called during --dry-run`);
    });

  const client = {
    getRoles: vi.fn(async () => existingRoles),
    getChannels: vi.fn(async () => existingChannels),
    getBotMember: vi.fn(async () => ({ user: { id: 'bot-user-id' }, roles: ['bot-role-id'] })),
    getMessages: vi.fn(async () => []),
    createRole: failIfCalled('createRole'),
    patchRole: failIfCalled('patchRole'),
    patchRolePositions: failIfCalled('patchRolePositions'),
    assignRole: failIfCalled('assignRole'),
    createChannel: failIfCalled('createChannel'),
    patchChannel: failIfCalled('patchChannel'),
    putChannelPermission: failIfCalled('putChannelPermission'),
    postMessage: failIfCalled('postMessage'),
  };
  return { client, calledMutations };
}

describe('runHubSetup (--dry-run, real plan, mocked REST client)', () => {
  it('computes a full reconcile plan without calling any mutating endpoint', async () => {
    const plan = await loadRealPlan();
    const { client, calledMutations } = buildMockClient(plan);

    const { report, idMap } = await runHubSetup({ plan, client, dryRun: true });

    expect(calledMutations).toEqual([]);
    expect(report.errors).toEqual([]);

    // Roles that don't exist yet (per plan.existing.roles) are queued for creation.
    expect(report.created.some((s) => s.includes('role "Owner"'))).toBe(true);
    expect(report.created.some((s) => s.includes('role "Server Owner"'))).toBe(true);
    expect(report.created.some((s) => s.includes('role "Updates Ping"'))).toBe(true);
    // Roles matched by plan.existing.roles with different color/hoist/mentionable get an update.
    expect(report.updated.some((s) => s.includes('role "Admin"'))).toBe(true);
    // Owner's assignTo (Brandon) is queued.
    expect(report.notes.some((n) => n.includes('Would assign role "Owner" to user 379422418202132490'))).toBe(true);
    // No booster role exists in the mocked guild.
    expect(report.notes.some((n) => /no premium-subscriber/i.test(n))).toBe(true);

    // Every category in the plan resolved to some id (real or placeholder).
    for (const cat of plan.categories_in_order) {
      expect(idMap.categories[cat.name]).toBeTruthy();
    }
    // The empty "SERVER STATS" category doesn't crash the reconcile.
    expect(plan.categories_in_order.some((c: any) => c.channels.length === 0)).toBe(true);

    // #rules resolves to the real existing channel id via existingName, and since it has no prior bot
    // message (mocked getMessages returns []), a post is queued.
    expect(idMap.channels.rules).toBe('rules-id');
    expect(client.getMessages).toHaveBeenCalledWith('rules-id', 20);
    expect(report.notes.some((n) => n.includes('Would post') && n.includes('#rules'))).toBe(true);

    // #faq/#ai-chat/#booster-lounge don't exist in the mocked guild, so their message step is deferred
    // rather than fetching messages for a channel id that doesn't exist yet.
    expect(report.notes.some((n) => n.includes('#faq') && n.includes("doesn't exist yet"))).toBe(true);
  });
});
