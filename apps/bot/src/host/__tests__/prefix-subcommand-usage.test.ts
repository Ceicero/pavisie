import { describe, expect, it } from 'vitest';
import { resolvePrefixOptions } from '../prefix/options';

/**
 * `+level` (a command that only exists as subcommands) used to fall through the option binder with no
 * subcommand selected, so `getSubcommand(true)` threw inside the handler and the router rendered a bare
 * "Something went wrong. Please try again." — which tells someone who just discovered the prefix nothing at
 * all. Verified live in Discord before the fix.
 */

// Mirrors the shape of `new SlashCommandBuilder()...toJSON()` for a subcommand-only command.
const levelCommand = {
  options: [
    { type: 1, name: 'rank', description: 'Show your rank.' },
    { type: 1, name: 'leaderboard', description: 'Show the leaderboard.' },
    { type: 2, name: 'config', description: 'Configure leveling.', options: [] },
  ],
};

const message = { guild: { members: { cache: new Map() } }, attachments: new Map() } as never;

describe('a command needing a subcommand explains itself instead of throwing', () => {
  it('lists the available subcommands when none was given', async () => {
    const result = await resolvePrefixOptions(levelCommand, [], message, 'level');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('rank');
    expect(result.error).toContain('leaderboard');
    expect(result.error).toContain('config');
    expect(result.usage).toContain('level');
  });

  it('names the offending token when the subcommand is not recognised', async () => {
    const result = await resolvePrefixOptions(levelCommand, ['bogus'], message, 'level');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('bogus');
    expect(result.error).toContain('rank');
  });

  it('still resolves normally once a real subcommand is supplied', async () => {
    const result = await resolvePrefixOptions(levelCommand, ['rank'], message, 'level');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.subcommand).toBe('rank');
  });

  it('leaves commands without subcommands alone', async () => {
    const simple = { options: [{ type: 3, name: 'query', description: 'A string.', required: false }] };

    const result = await resolvePrefixOptions(simple, [], message, 'ask');

    expect(result.ok).toBe(true);
  });
});

describe('a command with exactly one subcommand selects it automatically', () => {
  // Regression: the "needs a subcommand" guard broke +permissions, +pavisie and +embed, which each have a
  // single subcommand and had been working. There is nothing to choose, so choosing is the bot's job.
  const permissions = { options: [{ type: 1, name: 'audit', description: 'Audit permissions.' }] };

  it('runs without the user naming the only subcommand', async () => {
    const result = await resolvePrefixOptions(permissions, [], message, 'permissions');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.subcommand).toBe('audit');
  });

  it('still works when the user does name it', async () => {
    const result = await resolvePrefixOptions(permissions, ['audit'], message, 'permissions');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.subcommand).toBe('audit');
  });

  it('does not auto-select when there is more than one choice', async () => {
    const result = await resolvePrefixOptions(levelCommand, [], message, 'level');

    expect(result.ok).toBe(false);
  });
});
