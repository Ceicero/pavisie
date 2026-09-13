import { describe, expect, it } from 'vitest';
import type { Guild, GuildMember } from 'discord.js';
import { PermissionError } from '@pavisie/core';
import { hierarchyGuard, type HierarchyGuardInteraction } from '../../sdk';

/** Minimal fake `GuildMember` — only the fields `hierarchyGuard`/`checkModerationTarget` read. */
function fakeMember(id: string, highestRolePosition: number, isBot = false): GuildMember {
  return {
    id,
    user: { bot: isBot },
    roles: { highest: { position: highestRolePosition } },
  } as unknown as GuildMember;
}

function fakeGuild(ownerId: string, botMember: GuildMember): Guild {
  return { ownerId, members: { me: botMember } } as unknown as Guild;
}

const BOT = fakeMember('bot-1', 100, true);
const BOT_OWNER_IDS = ['owner-account-1'];

function interactionWith(actor: GuildMember, ownerId = 'guild-owner-1'): HierarchyGuardInteraction {
  return { guild: fakeGuild(ownerId, BOT), member: actor };
}

describe('hierarchyGuard integration (moderation command layer)', () => {
  it('allows a moderator to act on a lower-ranked member', () => {
    const actor = fakeMember('mod-1', 50);
    const target = fakeMember('member-1', 10);
    expect(() => hierarchyGuard(interactionWith(actor), target, BOT_OWNER_IDS)).not.toThrow();
  });

  it('rejects acting on yourself', () => {
    const actor = fakeMember('mod-1', 50);
    expect(() => hierarchyGuard(interactionWith(actor), actor, BOT_OWNER_IDS)).toThrow(PermissionError);
  });

  it('rejects acting on the bot', () => {
    const actor = fakeMember('mod-1', 50);
    expect(() => hierarchyGuard(interactionWith(actor), BOT, BOT_OWNER_IDS)).toThrow(PermissionError);
  });

  it('rejects acting on the guild owner', () => {
    const actor = fakeMember('mod-1', 50);
    const owner = fakeMember('guild-owner-1', 5); // low role position, but still the owner
    expect(() => hierarchyGuard(interactionWith(actor, 'guild-owner-1'), owner, BOT_OWNER_IDS)).toThrow(
      PermissionError,
    );
  });

  it('rejects acting on a configured bot owner regardless of role position', () => {
    const actor = fakeMember('mod-1', 90);
    const botOwnerTarget = fakeMember('owner-account-1', 1);
    expect(() => hierarchyGuard(interactionWith(actor), botOwnerTarget, BOT_OWNER_IDS)).toThrow(
      PermissionError,
    );
  });

  it("rejects a target whose highest role is at or above the actor's", () => {
    const actor = fakeMember('mod-1', 50);
    const equalTarget = fakeMember('member-1', 50);
    const higherTarget = fakeMember('member-2', 51);
    expect(() => hierarchyGuard(interactionWith(actor), equalTarget, BOT_OWNER_IDS)).toThrow(PermissionError);
    expect(() => hierarchyGuard(interactionWith(actor), higherTarget, BOT_OWNER_IDS)).toThrow(
      PermissionError,
    );
  });

  it("rejects a target whose highest role is at or above the bot's own", () => {
    const actor = fakeMember('mod-1', 999); // very high actor role, still capped by the bot's own position
    const target = fakeMember('member-1', 100); // equal to BOT's position (100)
    expect(() => hierarchyGuard(interactionWith(actor), target, BOT_OWNER_IDS)).toThrow(PermissionError);
  });

  it("lets the guild owner act on anyone below the bot, ignoring the owner's own role position", () => {
    const owner = fakeMember('guild-owner-1', 0); // owners often have no special role, position 0
    const target = fakeMember('member-1', 50);
    expect(() =>
      hierarchyGuard(interactionWith(owner, 'guild-owner-1'), target, BOT_OWNER_IDS),
    ).not.toThrow();
  });
});
