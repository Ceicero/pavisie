import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { describePermission, INVITE_PERMISSIONS, INVITE_PERMISSIONS_BITFIELD } from '@pavisie/core';
import { allManifests } from '../../manifests';

// Least-privilege guard: the invite link may only ask for a permission that some plugin's manifest explains
// (feature + fallback). A permission added to `INVITE_PERMISSIONS` without a manifest row, or left behind after
// the feature that needed it is removed, fails here instead of quietly widening what the bot requests.
describe('invite permissions are least-privilege', () => {
  const declared = allManifests.reduce(
    (acc, manifest) =>
      manifest.permissions.reduce((inner, doc) => inner | PermissionsBitField.resolve(doc.permission), acc),
    0n,
  );

  it('requests no permission that no plugin manifest declares', () => {
    const unexplained = INVITE_PERMISSIONS.filter((flag) => (declared & flag) !== flag).map(
      describePermission,
    );
    expect(unexplained).toEqual([]);
  });

  it('lists each permission once', () => {
    expect(new Set(INVITE_PERMISSIONS).size).toBe(INVITE_PERMISSIONS.length);
  });

  it('never requests Administrator, Manage Server, or View Audit Log', () => {
    for (const flag of [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ViewAuditLog,
    ]) {
      expect(INVITE_PERMISSIONS_BITFIELD & flag).toBe(0n);
    }
  });
});
