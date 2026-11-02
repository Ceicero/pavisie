/**
 * DTOs for the streamer starter pack (`/setup streamer` and the dashboard's "Streamer starter pack" button).
 *
 * One function in the `admin` plugin (`applyStreamerStarter`) produces a {@link StreamerStarterReportDto} and both
 * entry points show it: the slash command renders it as an embed, the dashboard renders the same text, because the
 * bot runs the dashboard's request too (the API only enqueues a `bot-actions` job and reads the finished report back
 * from Redis). Every string in the report is already localized by the bot.
 */

export type StreamerStarterStepId = 'twitch' | 'stats' | 'leveling' | 'automod';

/**
 * - `enabled`: something was turned on / created by this run.
 * - `already`: it was already configured, so it was left exactly as it is.
 * - `skipped`: deliberately not done (missing permission, no login given, plugin unavailable...); `text` says why.
 * - `failed`: tried and hit an error; the other steps still ran.
 */
export type StreamerStarterStepStatus = 'enabled' | 'already' | 'skipped' | 'failed';

export interface StreamerStarterStepDto {
  id: StreamerStarterStepId;
  status: StreamerStarterStepStatus;
  /** Short name of the feature, e.g. "Twitch go-live alerts". */
  title: string;
  /** What happened (or why it did not), possibly several lines. */
  text: string;
  /** Where the admin changes this afterwards (commands and the dashboard page). */
  where: string;
}

export interface StreamerStarterReportDto {
  guildId: string;
  /** ISO 8601 time the run finished. */
  ranAt: string;
  steps: StreamerStarterStepDto[];
  /** Cross-cutting heads-ups (e.g. the bot cannot post in the chosen alert channel yet). */
  notes: string[];
}

/** `POST /guilds/:guildId/setup/streamer-starter` body. A Twitch login needs an alert channel to post in. */
export interface StreamerStarterRequestDto {
  twitchLogin?: string | null;
  alertChannelId?: string | null;
}

/** Response to the `POST`: the run is queued on the bot; poll the `GET` with this id for the report. */
export interface StreamerStarterQueuedDto {
  requestId: string;
}

/** `GET /guilds/:guildId/setup/streamer-starter/:requestId`. */
export type StreamerStarterResultDto =
  | { status: 'pending' }
  | { status: 'done'; report: StreamerStarterReportDto }
  | { status: 'failed'; error: string };
