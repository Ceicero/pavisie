// Pure, unit-tested helpers backing `/pavisie report` (command + components). Kept dependency-free of
// discord.js so the validation/rate-limit logic can be exercised without building a fake interaction.
import { RateLimitError, ValidationError, type RateLimiterLike } from '@pavisie/core';
import type { DeveloperReportKind } from '@pavisie/types';

export const REPORT_KINDS = ['BUG', 'FEEDBACK', 'QUESTION'] as const;

/** Slash-command `addChoices` entries for the `kind` option. */
export const REPORT_KIND_CHOICES: { name: string; value: DeveloperReportKind }[] = [
  { name: 'Bug', value: 'BUG' },
  { name: 'Feedback', value: 'FEEDBACK' },
  { name: 'Question', value: 'QUESTION' },
];

export function isReportKind(value: string): value is DeveloperReportKind {
  return (REPORT_KINDS as readonly string[]).includes(value);
}

export const REPORT_SUBJECT_MAX = 150;
// Discord's own TextInputStyle.Paragraph hard cap; kept in sync with the modal's own `setMaxLength`.
export const REPORT_BODY_MAX = 4000;

/**
 * Server-side defense in depth behind the modal's own `required`/`minLength`/`maxLength` constraints (a client
 * could in principle submit a hand-built modal payload bypassing Discord's own UI validation).
 */
export function validateReportInput(input: { subject: string; body: string }): void {
  const subject = input.subject.trim();
  const body = input.body.trim();
  if (subject.length === 0) {
    throw new ValidationError('Subject cannot be empty.');
  }
  if (subject.length > REPORT_SUBJECT_MAX) {
    throw new ValidationError(`Subject must be ${REPORT_SUBJECT_MAX} characters or fewer.`);
  }
  if (body.length === 0) {
    throw new ValidationError('Body cannot be empty.');
  }
  if (body.length > REPORT_BODY_MAX) {
    throw new ValidationError(`Body must be ${REPORT_BODY_MAX} characters or fewer.`);
  }
}

// Hard per-user / per-guild caps so a single guild (regardless of how many admins it has) can't flood the
// developer's inbox. Mirrors the `ai` plugin's guild+user budget shape (packages/plugins/src/ai/budget.ts) but
// implemented directly on the shared `RateLimiterLike` (fixed-window Redis INCR/PEXPIRE, ARCHITECTURE.md §6)
// that every `PluginContext` already carries as `ctx.rateLimiter` — no new infrastructure needed.
const USER_LIMIT = 2;
const USER_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const GUILD_LIMIT = 5;
const GUILD_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function reportUserKey(guildId: string, userId: string): string {
  return `admin:report:user:${guildId}:${userId}`;
}

function reportGuildKey(guildId: string): string {
  return `admin:report:guild:${guildId}`;
}

/**
 * Consumes one unit against both the per-guild and per-user developer-report rate limits. Throws
 * `RateLimitError` (a friendly, user-facing `AppError` the router already knows how to surface) the first time
 * either is exceeded — checked guild-first (mirroring `ai/budget.ts`'s `checkBudget` order) so a guild that has
 * already saturated its own ceiling gets a "this server" message rather than a "you personally" one.
 */
export async function checkReportRateLimit(
  rateLimiter: RateLimiterLike,
  guildId: string,
  userId: string,
): Promise<void> {
  const guildResult = await rateLimiter.consume(reportGuildKey(guildId), GUILD_LIMIT, GUILD_WINDOW_MS);
  if (!guildResult.allowed) {
    const minutes = Math.max(1, Math.ceil(guildResult.resetMs / 60000));
    throw new RateLimitError(
      `This server has already sent the maximum number of developer reports for now. Try again in about ${minutes} minute(s).`,
    );
  }

  const userResult = await rateLimiter.consume(reportUserKey(guildId, userId), USER_LIMIT, USER_WINDOW_MS);
  if (!userResult.allowed) {
    const minutes = Math.max(1, Math.ceil(userResult.resetMs / 60000));
    throw new RateLimitError(
      `You've sent the maximum number of developer reports for now. Try again in about ${minutes} minute(s).`,
    );
  }
}

// Kept local to this plugin (rather than a new core constant) since it's only ever read here. Bump alongside
// the root/`apps/bot` package.json "version" field until the platform has real release versioning.
const BOT_VERSION = '0.1.0';

export function getBotVersion(): string {
  return BOT_VERSION;
}
