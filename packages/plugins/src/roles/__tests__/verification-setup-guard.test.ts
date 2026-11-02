import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { assertCanRunVerificationSetup } from '../commands/verification';

const t = (key: string) => key;

describe('assertCanRunVerificationSetup', () => {
  it('allows an admin with Manage Server', () => {
    expect(() => assertCanRunVerificationSetup('admin', PermissionFlagsBits.ManageGuild, t)).not.toThrow();
  });
  it('refuses an admin without Manage Server (prefix path)', () => {
    expect(() => assertCanRunVerificationSetup('admin', PermissionFlagsBits.ManageMessages, t)).toThrow(
      'errors.missing_discord_permission',
    );
    expect(() => assertCanRunVerificationSetup('admin', undefined, t)).toThrow();
  });
  it('still refuses a moderator even with Manage Server', () => {
    expect(() => assertCanRunVerificationSetup('moderator', PermissionFlagsBits.ManageGuild, t)).toThrow(
      'errors.missing_staff_level',
    );
  });
});
