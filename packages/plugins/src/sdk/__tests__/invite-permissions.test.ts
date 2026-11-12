import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { describePermission, INVITE_PERMISSIONS, INVITE_PERMISSIONS_BITFIELD } from '@pavisie/core';
import { allManifests } from '../../manifests';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

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

  it('never requests Administrator, Manage Server, View Audit Log, or Mention Everyone', () => {
    for (const flag of [
      PermissionFlagsBits.Administrator,
      PermissionFlagsBits.ManageGuild,
      PermissionFlagsBits.ViewAuditLog,
      PermissionFlagsBits.MentionEveryone,
    ]) {
      expect(INVITE_PERMISSIONS_BITFIELD & flag).toBe(0n);
    }
  });

  // Both files are written by `pnpm commands:export`. CI's staleness check diffs `docs/invite.json` only, so
  // without this a stale website copy would keep the "Add to Discord" button on an older, wider permission set.
  it.each(['docs/invite.json', 'apps/web/src/data/invite.json'])('%s carries the current invite', (path) => {
    const file = JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8')) as {
      permissions: string;
      scopes: string[];
    };
    expect(file.permissions).toBe(INVITE_PERMISSIONS_BITFIELD.toString());
    expect(file.scopes).toEqual(['bot', 'applications.commands']);
  });
});
