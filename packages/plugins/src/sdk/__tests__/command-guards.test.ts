import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { allPlugins } from '../../index';

/**
 * Discord's `default_member_permissions` only gates the slash-command UI — prefix commands (apps/bot/src/host/prefix)
 * and server-side permission overrides bypass it. Every command that Discord hides from regular members must
 * therefore also declare a runtime `requirement` (staffLevel / discordPermissions / botOwnerOnly) that the router
 * enforces for both entry points.
 */
describe('privileged command guards', () => {
  const rows = allPlugins.flatMap((p) =>
    p.commands.map((c) => ({ plugin: p.manifest.id, cmd: c, json: c.data.toJSON() })),
  );

  it('has commands to check', () => {
    expect(rows.length).toBeGreaterThan(0);
  });

  it.each(
    rows
      .filter((r) => r.json.default_member_permissions && r.json.default_member_permissions !== '0')
      .map((r) => [`${r.plugin}/${r.json.name}`, r] as const),
  )('%s declares a runtime requirement', (_name, r) => {
    const req = r.cmd.requirement;
    const guarded = Boolean(
      req && (req.staffLevel !== undefined || (req.discordPermissions?.length ?? 0) > 0 || req.botOwnerOnly),
    );
    expect(guarded).toBe(true);
  });
});

describe('config commands require Manage Server at runtime', () => {
  it.each(['welcome', 'goodbye'])('roles/%s', (name) => {
    const roles = allPlugins.find((p) => p.manifest.id === 'roles')!;
    const cmd = roles.commands.find((c) => c.data.toJSON().name === name)!;
    expect(cmd.requirement?.staffLevel).toBeUndefined();
    expect(cmd.requirement?.discordPermissions?.map(String)).toEqual([String(PermissionFlagsBits.ManageGuild)]);
  });
});
