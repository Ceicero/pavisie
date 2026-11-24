import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every <Switch> (Radix button[role=switch], no built-in label) must have an accessible name,
 * otherwise screen readers just announce "switch, off".
 */

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

/**
 * Files that still contain unnamed switches. They are owned by other workstreams and are left
 * for their owners to fix; remove an entry once its file is fixed (the staleness check below
 * fails if an entry no longer has an unnamed switch).
 */
const KNOWN_UNLABELED: string[] = [];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Returns the opening tag of each `<Switch ...>` / `<Switch ... />` element. Tracks `{}` depth and
 * string literals, so `=>`, `>` or braces inside prop expressions and strings don't end the tag early.
 * `<Switch.Thumb>` and the like are not matched.
 */
function switchTags(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const tags: string[] = [];
  const re = /<Switch(?=[\s/>])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < code.length; i++) {
      const c = code[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push(code.slice(m.index, i + 1));
  }
  return tags;
}

const ARIA_NAMED = /\b(aria-label|aria-labelledby)=/;
const STATIC_ID = /\bid="([^"]+)"/;

/** Named by aria-label/aria-labelledby, or by a static `id` that a `htmlFor` in the same file points at. */
function isNamed(tag: string, source: string): boolean {
  if (ARIA_NAMED.test(tag)) return true;
  const id = STATIC_ID.exec(tag)?.[1];
  return id !== undefined && source.includes(`htmlFor="${id}"`);
}

const files = walk(SRC_DIR).map((f) => ({
  rel: relative(SRC_DIR, f).split('\\').join('/'),
  source: readFileSync(f, 'utf8'),
}));

function unnamedCount(source: string): number {
  return switchTags(source).filter((t) => !isNamed(t, source)).length;
}

describe('Dashboard switches — accessible names', () => {
  it('finds switches to check', () => {
    expect(files.reduce((n, f) => n + switchTags(f.source).length, 0)).toBeGreaterThan(20);
  });

  it('every <Switch> has aria-label, aria-labelledby or a label pointing at its id', () => {
    const offenders = files
      .filter((f) => !KNOWN_UNLABELED.includes(f.rel))
      .filter((f) => unnamedCount(f.source) > 0)
      .map((f) => `${f.rel} (${unnamedCount(f.source)} unnamed)`);
    expect(offenders).toEqual([]);
  });

  it('KNOWN_UNLABELED entries still contain an unnamed switch (allowlist is not stale)', () => {
    for (const rel of KNOWN_UNLABELED) {
      const file = files.find((f) => f.rel === rel);
      expect(file, `${rel} should exist`).toBeTruthy();
      expect(unnamedCount(file!.source), `${rel} no longer has unnamed switches; remove it`).toBeGreaterThan(
        0,
      );
    }
  });
});

/**
 * Switches that have adjacent help text and must point at it with aria-describedby.
 * `id` is a static id="..." in the same file. Entries without `id` use a dynamic
 * aria-describedby={...} whose target is an id={...} in the same file.
 */
const EXPECTED_DESCRIBED: { rel: string; needle: string; id?: string }[] = [
  {
    rel: 'app/dashboard/[guildId]/settings/page.tsx',
    needle: 'aria-label="Fast actions"',
    id: 'fast-actions-help',
  },
  {
    rel: 'app/dashboard/[guildId]/settings/page.tsx',
    needle: 'aria-label="DM users on moderation action"',
    id: 'dm-on-moderation-help',
  },
  {
    rel: 'app/dashboard/[guildId]/settings/page.tsx',
    needle: 'aria-label="Enable analytics data collection"',
    id: 'analytics-data-collection-help',
  },
  {
    rel: 'app/dashboard/[guildId]/settings/page.tsx',
    needle: 'aria-label="Log message content on edit/delete"',
    id: 'log-message-content-help',
  },
  {
    rel: 'app/dashboard/[guildId]/ai/page.tsx',
    needle: 'aria-label="Toggle AI assistant"',
    id: 'ai-opt-in-help',
  },
  {
    rel: 'components/dashboard/ai/ai-settings-form.tsx',
    needle: 'id="ai-allow-env"',
    id: 'ai-allow-env-help',
  },
  {
    rel: 'components/dashboard/ai/mention-chat-form.tsx',
    needle: 'id="chat-enabled"',
    id: 'chat-enabled-help',
  },
  {
    rel: 'components/dashboard/community/birthdays-tab.tsx',
    needle: 'aria-label="Enabled: birthdays"',
    id: 'birthdays-enabled-help',
  },
  {
    rel: 'components/dashboard/community/birthdays-tab.tsx',
    needle: 'aria-label="Public list"',
    id: 'birthdays-public-list-help',
  },
  {
    rel: 'components/dashboard/community/birthdays-tab.tsx',
    needle: 'aria-label="Members can set their own birthday"',
    id: 'birthdays-members-can-set-help',
  },
  {
    rel: 'components/dashboard/community/channel-automations-card.tsx',
    needle: 'aria-label="Also publish other bots and webhooks"',
    id: 'automations-publish-bots-help',
  },
  {
    rel: 'components/dashboard/community/channel-automations-card.tsx',
    needle: 'aria-label="Attachments or embeds only"',
    id: 'automations-attachments-only-help',
  },
  {
    rel: 'components/dashboard/community/tags-tab.tsx',
    needle: 'aria-label="Staff only"',
    id: 'tag-staff-only-help',
  },
  {
    rel: 'components/dashboard/engagement/leveling-tab.tsx',
    needle: 'aria-label="Leveling enabled"',
    id: 'leveling-enabled-help',
  },
  {
    rel: 'components/dashboard/engagement/leveling-tab.tsx',
    needle: 'aria-label="Public leaderboard"',
    id: 'public-leaderboard-help',
  },
  {
    rel: 'components/dashboard/engagement/reputation-tab.tsx',
    needle: 'aria-label="Reputation enabled"',
    id: 'reputation-enabled-help',
  },
  {
    rel: 'components/dashboard/engagement/starboard-tab.tsx',
    needle: 'aria-label="Ignore self-stars"',
    id: 'starboard-ignore-self-stars-help',
  },
  {
    rel: 'components/dashboard/engagement/starboard-tab.tsx',
    needle: 'aria-label="Allow NSFW channels"',
    id: 'starboard-allow-nsfw-help',
  },
  {
    rel: 'components/dashboard/logging/channel-map-table.tsx',
    needle: 'aria-label="Store events for search & export"',
    id: 'logging-store-events-help',
  },
  {
    rel: 'components/dashboard/logging/channel-map-table.tsx',
    needle: 'aria-label="Capture message content on edit/delete"',
    id: 'logging-capture-content-help',
  },
  {
    rel: 'components/dashboard/moderation/settings-tab.tsx',
    needle: 'aria-label="DM users on moderation action"',
    id: 'moderation-dm-users-help',
  },
  {
    rel: 'components/dashboard/moderation/settings-tab.tsx',
    needle: 'aria-label="Allow temporary bans"',
    id: 'moderation-temporary-bans-help',
  },
  {
    rel: 'components/dashboard/roles/autoroles-tab.tsx',
    needle: 'aria-label="Enabled: autoroles"',
    id: 'autoroles-enabled-help',
  },
  {
    rel: 'components/dashboard/roles/groups-tab.tsx',
    needle: 'aria-label="Exclusive"',
    id: 'role-group-exclusive-help',
  },
  {
    rel: 'components/dashboard/roles/persistence-tab.tsx',
    needle: 'aria-label="Enabled: role persistence"',
    id: 'role-persistence-enabled-help',
  },
  {
    rel: 'components/dashboard/tickets/panel-form-dialog.tsx',
    needle: 'aria-label="Ask questions before opening"',
    id: 'ticket-panel-ask-questions-help',
  },
  {
    rel: 'components/dashboard/tickets/settings-tab.tsx',
    needle: 'aria-label="DM the transcript to the ticket opener"',
    id: 'tickets-dm-transcript-help',
  },
  {
    rel: 'components/dashboard/tickets/settings-tab.tsx',
    needle: 'aria-label="Never auto-delete closed channels"',
    id: 'tickets-keep-closed-channels-help',
  },
  {
    rel: 'components/dashboard/integrations/twitch-chat-bridge-panel.tsx',
    needle: 'aria-label="Relay Discord messages into Twitch chat"',
    id: 'twitch-chat-bridge-help',
  },
  {
    rel: 'components/dashboard/integrations/twitch-chat-bridge-panel.tsx',
    needle: 'aria-label="Relay Twitch chat messages into Discord"',
    id: 'twitch-chat-bridge-help',
  },
  {
    rel: 'components/dashboard/plugin-card.tsx',
    needle: 'aria-label={`Toggle ${plugin.name}`}',
  },
  { rel: 'components/dashboard/json-schema-form.tsx', needle: 'aria-label={label}' },
  {
    rel: 'components/dashboard/integrations/require-timestamp-setting.tsx',
    needle: 'aria-describedby={helpId}',
  },
  {
    rel: 'components/dashboard/automod/rule-config-fields.tsx',
    needle: 'aria-label={label}',
  },
  {
    rel: 'components/dashboard/automod/settings-tab.tsx',
    needle: 'aria-label="Guild-wide dry-run"',
    id: 'automod-guild-wide-dry-run-help',
  },
  {
    rel: 'components/dashboard/automod/settings-tab.tsx',
    needle: 'aria-label="Exempt staff"',
    id: 'automod-exempt-staff-help',
  },
  {
    rel: 'components/dashboard/enforcer/settings-tab.tsx',
    needle: 'aria-label="Automatic flagging"',
    id: 'enforcer-automatic-flagging-help',
  },
  {
    rel: 'components/dashboard/enforcer/settings-tab.tsx',
    needle: 'aria-label="Exempt staff from auto-flagging"',
    id: 'enforcer-exempt-staff-help',
  },
  {
    rel: 'components/dashboard/enforcer/settings-tab.tsx',
    needle: 'aria-label="Capture context"',
    id: 'enforcer-capture-context-help',
  },
  {
    rel: 'components/dashboard/enforcer/settings-tab.tsx',
    needle: 'aria-label="Optional AI risk scoring (assistive only)"',
    id: 'enforcer-ai-assist-help',
  },
  {
    rel: 'components/dashboard/enforcer/settings-tab.tsx',
    needle: 'aria-label="DM the user on action"',
    id: 'enforcer-dm-on-action-help',
  },
];

const JS_KEYWORDS = new Set(['undefined', 'null', 'true', 'false']);

function describedByRef(tag: string): { staticId?: string; expr?: string } {
  const staticId = /\baria-describedby="([^"]+)"/.exec(tag)?.[1];
  if (staticId) return { staticId };
  const expr = /\baria-describedby=\{([^}]+)\}/.exec(tag)?.[1]?.trim();
  if (expr) return { expr };
  return {};
}

/** The aria-describedby value points at an element id declared in the same file. */
function idResolves(source: string, tag: string): boolean {
  const ref = describedByRef(tag);
  if (ref.staticId) return source.includes(`id="${ref.staticId}"`);
  if (!ref.expr) return false;
  if (source.includes(`id={${ref.expr}}`)) return true;
  const idents = (ref.expr.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []).filter((n) => !JS_KEYWORDS.has(n));
  if (idents.some((id) => source.includes(`id={${id}}`))) return true;
  // RequireTimestampHelp renders <p id={id}> from a helpId prop in the same file.
  return /<p\b[^>]*\bid=\{id\}/.test(source) && idents.includes('helpId');
}

function tagContaining(tags: string[], needle: string): string | undefined {
  return tags.find((t) => t.includes(needle));
}

describe('Dashboard switches — aria-describedby', () => {
  it('lists the expected switches', () => {
    expect(EXPECTED_DESCRIBED).toHaveLength(41);
  });

  it('each expected switch has aria-describedby whose id exists in the same file', () => {
    const missing: string[] = [];
    for (const { rel, needle, id } of EXPECTED_DESCRIBED) {
      const file = files.find((f) => f.rel === rel);
      if (!file) {
        missing.push(`${rel} (file missing)`);
        continue;
      }
      const tag = tagContaining(switchTags(file.source), needle);
      if (!tag) {
        missing.push(`${rel} (no switch containing ${needle})`);
        continue;
      }
      if (id && !tag.includes(`aria-describedby="${id}"`)) {
        missing.push(`${rel} :: ${needle} (expected aria-describedby="${id}")`);
        continue;
      }
      if (!idResolves(file.source, tag)) {
        missing.push(`${rel} :: ${needle} (aria-describedby does not resolve in this file)`);
      }
    }
    expect(missing).toEqual([]);
  });
});
