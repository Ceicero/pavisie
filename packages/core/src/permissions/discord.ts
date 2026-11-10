import { PermissionFlagsBits } from 'discord-api-types/v10';

/** Human-readable names for the Discord permission flags this platform references. */
export const PERMISSION_NAMES: ReadonlyMap<bigint, string> = new Map<bigint, string>([
  [PermissionFlagsBits.CreateInstantInvite, 'Create Invite'],
  [PermissionFlagsBits.KickMembers, 'Kick Members'],
  [PermissionFlagsBits.BanMembers, 'Ban Members'],
  [PermissionFlagsBits.Administrator, 'Administrator'],
  [PermissionFlagsBits.ManageChannels, 'Manage Channels'],
  [PermissionFlagsBits.ManageGuild, 'Manage Server'],
  [PermissionFlagsBits.AddReactions, 'Add Reactions'],
  [PermissionFlagsBits.ViewAuditLog, 'View Audit Log'],
  [PermissionFlagsBits.PrioritySpeaker, 'Priority Speaker'],
  [PermissionFlagsBits.Stream, 'Video'],
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.SendTTSMessages, 'Send Text-to-Speech Messages'],
  [PermissionFlagsBits.ManageMessages, 'Manage Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
  [PermissionFlagsBits.AttachFiles, 'Attach Files'],
  [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
  [PermissionFlagsBits.MentionEveryone, 'Mention @everyone, @here, and All Roles'],
  [PermissionFlagsBits.UseExternalEmojis, 'Use External Emoji'],
  [PermissionFlagsBits.ViewGuildInsights, 'View Server Insights'],
  [PermissionFlagsBits.Connect, 'Connect'],
  [PermissionFlagsBits.Speak, 'Speak'],
  [PermissionFlagsBits.MuteMembers, 'Mute Members'],
  [PermissionFlagsBits.DeafenMembers, 'Deafen Members'],
  [PermissionFlagsBits.MoveMembers, 'Move Members'],
  [PermissionFlagsBits.UseVAD, 'Use Voice Activity'],
  [PermissionFlagsBits.ChangeNickname, 'Change Nickname'],
  [PermissionFlagsBits.ManageNicknames, 'Manage Nicknames'],
  [PermissionFlagsBits.ManageRoles, 'Manage Roles'],
  [PermissionFlagsBits.ManageWebhooks, 'Manage Webhooks'],
  [PermissionFlagsBits.ManageEmojisAndStickers, 'Manage Expressions'],
  [PermissionFlagsBits.UseApplicationCommands, 'Use Application Commands'],
  [PermissionFlagsBits.RequestToSpeak, 'Request to Speak'],
  [PermissionFlagsBits.ManageEvents, 'Manage Events'],
  [PermissionFlagsBits.ManageThreads, 'Manage Threads'],
  [PermissionFlagsBits.CreatePublicThreads, 'Create Public Threads'],
  [PermissionFlagsBits.CreatePrivateThreads, 'Create Private Threads'],
  [PermissionFlagsBits.UseExternalStickers, 'Use External Stickers'],
  [PermissionFlagsBits.SendMessagesInThreads, 'Send Messages in Threads'],
  [PermissionFlagsBits.UseEmbeddedActivities, 'Use Activities'],
  [PermissionFlagsBits.ModerateMembers, 'Timeout Members'],
]);

/** Human-readable name for a single Discord permission flag. */
export function describePermission(flag: bigint): string {
  return PERMISSION_NAMES.get(flag) ?? `Unknown Permission (${flag.toString()})`;
}

/**
 * Returns the human-readable names of every permission in `required` that is missing from `have`.
 *
 * Administrator short-circuits to "nothing missing", because Discord grants every permission to anyone who
 * holds it — a plain `have & flag` bitwise test does not know that, since the other bits are simply absent
 * from the bitfield. Without this, a bot with Administrator is told it lacks permissions it can actually
 * exercise: the audit prints warnings that contradict the bot's own member info, and, worse,
 * `assertBotPermissions` refuses to run commands that would have succeeded.
 */
export function missingPermissions(have: bigint, required: bigint[]): string[] {
  if ((have & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator) return [];
  return required.filter((flag) => (have & flag) !== flag).map((flag) => describePermission(flag));
}

/** Least-privilege bot invite permission set (ARCHITECTURE.md §7.8). Never includes Administrator. */
export const INVITE_PERMISSIONS: bigint[] = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
  PermissionFlagsBits.MoveMembers,
  PermissionFlagsBits.ManageEvents,
  // Optional per engagement's manifest (temp voice: owner can mute/deafen members in their own channel) — the
  // bot degrades gracefully without these, but without inviting with them, Discord will never let the bot grant
  // them via a channel permission overwrite at all (see engagement/events/voice-state-update.ts).
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
];

/** The combined bitfield of `INVITE_PERMISSIONS`. */
export const INVITE_PERMISSIONS_BITFIELD: bigint = INVITE_PERMISSIONS.reduce((acc, flag) => acc | flag, 0n);

/**
 * Builds a Discord bot invite URL with scopes `bot applications.commands` and a least-privilege permission
 * integer. Administrator is always stripped, even if accidentally included in `permissions`.
 */
export function buildInviteUrl(clientId: string, permissions: bigint = INVITE_PERMISSIONS_BITFIELD): string {
  const safePermissions = permissions & ~PermissionFlagsBits.Administrator;
  const scope = encodeURIComponent('bot applications.commands');
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&scope=${scope}&permissions=${safePermissions.toString()}`;
}
