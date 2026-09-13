import { z } from 'zod';
import { assertPublicHttpUrl, encryptSecret, SsrfError, ValidationError } from '@pavisie/core';
import type { AiSettingsDto, AiTestResultDto, AiUsageSummaryDto } from '@pavisie/types/ai';
import type { ZodFastifyInstance } from '../lib/http';
import { requireGuildAccess } from '../lib/guild-access';
import { guildIdParamSchema } from '../lib/schemas';

const AI_PLUGIN_ID = 'ai' as const;

/** Mirrors `packages/plugins/src/ai/manifest.ts`'s `configSchema`'s `chat` sub-object. */
interface AiChatConfigShape {
  enabled: boolean;
  channelIds: string[];
  persona: string | null;
  historyMessages: number;
  maxReplyChars: number;
}

/** Mirrors `packages/plugins/src/ai/manifest.ts`'s `configSchema` — kept local (rather than importing the plugins package into the API) per ARCHITECTURE.md §10's config-store note that the API only ever needs manifest-level shape, read/validated generically via `app.configStore`. */
interface AiConfigShape {
  provider: 'openai' | 'anthropic' | 'compatible';
  model: string;
  baseUrl: string | null;
  apiKeyEnc: string | null;
  allowEnvKeys: boolean;
  allowedChannelIds: string[];
  userCooldownSeconds: number;
  dailyTokenBudget: number;
  perUserDailyTokenBudget: number;
  chat: AiChatConfigShape;
}

const chatSettingsSchema = z.object({
  enabled: z.boolean(),
  channelIds: z.array(z.string().regex(/^\d{17,20}$/)).max(20),
  persona: z.string().trim().min(1).max(1500).nullable(),
  historyMessages: z.number().int().min(0).max(10),
  maxReplyChars: z.number().int().min(200).max(2000),
});

const settingsBodySchema = z.object({
  provider: z.enum(['openai', 'anthropic', 'compatible']).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  baseUrl: z.string().trim().url().nullable().optional(),
  apiKey: z.string().trim().min(1).max(500).optional(),
  clearKey: z.boolean().optional(),
  allowEnvKeys: z.boolean().optional(),
  allowedChannelIds: z
    .array(z.string().regex(/^\d{17,20}$/))
    .max(50)
    .optional(),
  userCooldownSeconds: z.number().int().min(0).max(3600).optional(),
  dailyTokenBudget: z.number().int().min(1000).max(10_000_000).optional(),
  perUserDailyTokenBudget: z.number().int().min(100).max(1_000_000).optional(),
  // Sent whole (never a partial patch) — the dashboard form keeps `chat` as one draft object, same as every
  // other settings field; `configStore.setConfig` shallow-merges at the top level, so a whole-object replace here
  // is intentional and correct (unlike the bot's `/ai chat` subcommands, which each patch one field and so have
  // to spread the current `chat` object themselves — see `packages/plugins/src/ai/commands/config.ts`).
  chat: chatSettingsSchema.optional(),
});

const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
});

function toSettingsDto(guildId: string, config: AiConfigShape): AiSettingsDto {
  return {
    guildId,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    hasKey: Boolean(config.apiKeyEnc),
    allowEnvKeys: config.allowEnvKeys,
    allowedChannelIds: config.allowedChannelIds,
    userCooldownSeconds: config.userCooldownSeconds,
    dailyTokenBudget: config.dailyTokenBudget,
    perUserDailyTokenBudget: config.perUserDailyTokenBudget,
    chat: config.chat,
  };
}

interface AiUsageRow {
  command: string;
  promptTokens: number;
  completionTokens: number;
  createdAt: Date;
}

function summarizeUsage(
  guildId: string,
  days: number,
  config: AiConfigShape,
  rows: AiUsageRow[],
): AiUsageSummaryDto {
  const dailyMap = new Map<string, { promptTokens: number; completionTokens: number; requests: number }>();
  const commandMap = new Map<string, { requests: number; totalTokens: number }>();
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  for (const row of rows) {
    const day = row.createdAt.toISOString().slice(0, 10);
    const dayBucket = dailyMap.get(day) ?? { promptTokens: 0, completionTokens: 0, requests: 0 };
    dayBucket.promptTokens += row.promptTokens;
    dayBucket.completionTokens += row.completionTokens;
    dayBucket.requests += 1;
    dailyMap.set(day, dayBucket);

    const cmdBucket = commandMap.get(row.command) ?? { requests: 0, totalTokens: 0 };
    cmdBucket.requests += 1;
    cmdBucket.totalTokens += row.promptTokens + row.completionTokens;
    commandMap.set(row.command, cmdBucket);

    totalPromptTokens += row.promptTokens;
    totalCompletionTokens += row.completionTokens;
  }

  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, bucket]) => ({
      date,
      promptTokens: bucket.promptTokens,
      completionTokens: bucket.completionTokens,
      totalTokens: bucket.promptTokens + bucket.completionTokens,
      requests: bucket.requests,
    }));

  const topCommands = [...commandMap.entries()]
    .sort(([, a], [, b]) => b.totalTokens - a.totalTokens)
    .slice(0, 10)
    .map(([command, v]) => ({ command, requests: v.requests, totalTokens: v.totalTokens }));

  return {
    guildId,
    rangeDays: days,
    totalRequests: rows.length,
    totalPromptTokens,
    totalCompletionTokens,
    dailyTokenBudget: config.dailyTokenBudget,
    perUserDailyTokenBudget: config.perUserDailyTokenBudget,
    daily,
    topCommands,
  };
}

/** `/guilds/:guildId/ai` — AI assistant settings (provider key never round-tripped in plaintext), usage summary, and a live connection test (ARCHITECTURE.md §10, task spec §K). */
export default async function aiRoutes(app: ZodFastifyInstance): Promise<void> {
  app.get(
    '/:guildId/ai/settings',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const guildId = request.guildId!;
      const config = await app.configStore.getConfig<AiConfigShape>(guildId, AI_PLUGIN_ID);
      return toSettingsDto(guildId, config);
    },
  );

  app.put(
    '/:guildId/ai/settings',
    { schema: { params: guildIdParamSchema, body: settingsBodySchema }, preHandler: requireGuildAccess() },
    async (request) => {
      const guildId = request.guildId!;
      const session = request.session!;
      const { apiKey, clearKey, ...rest } = request.body;

      if (rest.provider === 'compatible' && rest.baseUrl) {
        try {
          await assertPublicHttpUrl(rest.baseUrl);
        } catch (err) {
          throw new ValidationError(err instanceof SsrfError ? err.message : 'That base URL is not allowed.');
        }
      }

      const patch: Partial<AiConfigShape> = { ...rest };
      if (clearKey) {
        patch.apiKeyEnc = null;
      } else if (apiKey) {
        patch.apiKeyEnc = encryptSecret(apiKey);
      }

      const updated = await app.configStore.setConfig<AiConfigShape>(guildId, AI_PLUGIN_ID, patch, {
        id: session.userId,
        source: 'dashboard',
      });
      return toSettingsDto(guildId, updated);
    },
  );

  app.get(
    '/:guildId/ai/usage',
    {
      schema: { params: guildIdParamSchema, querystring: usageQuerySchema },
      preHandler: requireGuildAccess(),
    },
    async (request) => {
      const guildId = request.guildId!;
      const days = request.query.days ?? 30;
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const [config, rows] = await Promise.all([
        app.configStore.getConfig<AiConfigShape>(guildId, AI_PLUGIN_ID),
        app.prisma.aiUsage.findMany({
          where: { guildId, createdAt: { gte: since } },
          select: { command: true, promptTokens: true, completionTokens: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        }),
      ]);

      return summarizeUsage(guildId, days, config, rows);
    },
  );

  app.post(
    '/:guildId/ai/test',
    { schema: { params: guildIdParamSchema }, preHandler: requireGuildAccess() },
    async (request, reply): Promise<AiTestResultDto> => {
      const guildId = request.guildId!;
      const session = request.session!;

      const job = await app.queues
        .botActions()
        .add('bot-action', { type: 'ai.test', guildId, requestedBy: session.userId });
      // `bot-actions` jobs are processed asynchronously by the bot process — there is no synchronous result to
      // return yet. Report that the check was queued rather than fabricating a result; the dashboard polls
      // `GET /ai/usage` (a `system-test` usage row appears once the bot records the round-trip) or re-runs the
      // test after a moment. This mirrors every other bot-action-backed dashboard button (roles/tickets/etc),
      // none of which get a synchronous result either.
      void job;
      reply.code(202);
      return { ok: true, detail: 'Connection test queued — the bot will attempt it shortly.' };
    },
  );
}
