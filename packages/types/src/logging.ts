/**
 * DTOs for the `logging` plugin's dashboard/API surface.
 *
 * `LOG_KINDS`/`LogKind` deliberately duplicate `packages/plugins/src/sdk/services.ts`'s `LogKind` union
 * (string-for-string identical) and `packages/plugins/src/logging/constants.ts`'s `LOG_KIND_LABELS`. The
 * dashboard never imports `@pavisie/plugins` (ARCHITECTURE.md §3: "the dashboard never imports
 * `@pavisie/database` or `@pavisie/plugins` — it talks to the API only"), and this package's owner list for
 * this task explicitly forbids editing `sdk/**`, so there is no single shared source of truth reachable from
 * both sides without an out-of-scope SDK change. Flagged under openIssues for a follow-up wiring pass that
 * moves `LogKind` into this file and has the SDK re-export it instead.
 */
export const LOG_KINDS = [
  'member.join',
  'member.leave',
  'message.edit',
  'message.delete',
  'role.update',
  'channel.update',
  'guild.update',
  'moderation.action',
  'voice.join',
  'voice.leave',
  'invite.use',
  'bot.error',
  'webhook.failure',
  'automod.trigger',
  'ticket.event',
  'verification.event',
] as const;

export type LogKind = (typeof LOG_KINDS)[number];

export const LOG_KIND_LABELS: Record<LogKind, string> = {
  'member.join': 'Member joined',
  'member.leave': 'Member left',
  'message.edit': 'Message edited',
  'message.delete': 'Message deleted',
  'role.update': 'Role changes',
  'channel.update': 'Channel & thread changes',
  'guild.update': 'Server settings changed',
  'moderation.action': 'Moderation action',
  'voice.join': 'Voice channel joined',
  'voice.leave': 'Voice channel left',
  'invite.use': 'Invite used',
  'bot.error': 'Bot error',
  'webhook.failure': 'Webhook delivery failed',
  'automod.trigger': 'Automod triggered',
  'ticket.event': 'Ticket event',
  'verification.event': 'Verification event',
};

/** `channels` keys: every `LogKind` plus `'default'` (the fallback channel for kinds without their own mapping). */
export type LogChannelKey = LogKind | 'default';

/** Mirrors the `logging` plugin's `configSchema` (packages/plugins/src/logging/manifest.ts). */
export interface LoggingConfigDto {
  channels: Partial<Record<LogChannelKey, string | null>>;
  enabledKinds: LogKind[];
  storeEvents: boolean;
  retentionDays: number;
  redactionPatterns: string[];
  captureContent: boolean;
}

export interface RedactionTestRequestDto {
  text: string;
}

export interface RedactionTestMatchDto {
  /** Pattern name, e.g. `'email'`, `'ipv4'`, or `'custom1'` for a guild-defined pattern. */
  name: string;
  /** Whether this pattern matched anywhere in the input text. */
  matched: boolean;
}

export interface RedactionTestResponseDto {
  redacted: string;
  matches: RedactionTestMatchDto[];
}
