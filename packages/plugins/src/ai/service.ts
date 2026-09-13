import { AppError, Cooldowns, RateLimitError } from '@entrophy/core';
import type { AiCompleteInput, AiCompleteResult, AiService, PluginContext } from '../sdk';
import { checkBudget, recordUsage, reconcileUsage, releaseReservation, reserveBudget } from './budget';
import { AI_MAX_OUTPUT_TOKENS } from './manifest';
import type { AiConfig } from './manifest';
import { AI_SYSTEM_PROMPT } from './prompt';
import { resolveProvider } from './providers/resolve';
import { redact } from './redact';
import { resolveApiKey } from './resolve-key';

export interface AiUnavailableInfo {
  available: boolean;
  reason?: string;
}

/**
 * 503, and — unlike `ExternalServiceError` — `expose: true`: these are user-actionable "this isn't configured
 * yet" states (no key, plugin disabled, dependency plugin missing), not opaque upstream failures, so the
 * specific reason should reach the command's reply rather than being replaced with a generic message.
 */
export class AiUnavailableError extends AppError {
  constructor(message: string) {
    super('ai_unavailable', message, { status: 503, expose: true });
    this.name = 'AiUnavailableError';
  }
}

/** `/ai config view`, `/plugin status`, and the API settings endpoint all need "is this actually usable right now". */
export function describeAvailability(
  config: AiConfig,
  env: { OPENAI_API_KEY?: string; ANTHROPIC_API_KEY?: string },
): AiUnavailableInfo {
  const resolved = resolveApiKey(config, env);
  if (!resolved) {
    return {
      available: false,
      reason: config.allowEnvKeys
        ? 'No API key is configured (per-guild key not set, and no matching environment key fallback is available).'
        : 'No API key is configured and the environment-key fallback is turned off.',
    };
  }
  return { available: true };
}

/** Checks the per-user cooldown for AI commands, using the guild's configured `userCooldownSeconds`. Throws `RateLimitError` if still cooling down. */
export async function enforceCooldown(
  ctx: PluginContext,
  guildId: string,
  userId: string,
  seconds: number,
  t: PluginContext['t'],
): Promise<void> {
  if (seconds <= 0) return;
  const cooldowns = new Cooldowns(ctx.redis);
  const result = await cooldowns.take(`ai:${guildId}:${userId}`, seconds);
  if (!result.ok) {
    throw new RateLimitError(
      t('errors.cooldown', { seconds: Math.max(1, Math.ceil(result.retryAfterMs / 1000)) }),
    );
  }
}

/** Checks (but does not yet spend) today's guild/user token budget. Throws `RateLimitError` if either is exhausted. */
export async function enforceBudget(
  ctx: PluginContext,
  guildId: string,
  userId: string,
  config: AiConfig,
  t: PluginContext['t'],
): Promise<void> {
  const result = await checkBudget(
    ctx.redis,
    guildId,
    userId,
    config.dailyTokenBudget,
    config.perUserDailyTokenBudget,
  );
  if (!result.ok) {
    throw new RateLimitError(
      result.scope === 'guild' ? t('errors.guildBudgetExhausted') : t('errors.userBudgetExhausted'),
    );
  }
}

/** Builds the `AiService` cross-plugin implementation, registered in `onLoad` (ARCHITECTURE.md §7.5). */
export function createAiService(ctx: PluginContext): AiService {
  async function complete(input: AiCompleteInput): Promise<AiCompleteResult> {
    const { guildId, userId, command, prompt, system, maxTokens } = input;
    const config = await ctx.getConfig<AiConfig>(guildId);

    const resolvedKey = resolveApiKey(config, {
      OPENAI_API_KEY: ctx.env.OPENAI_API_KEY,
      ANTHROPIC_API_KEY: ctx.env.ANTHROPIC_API_KEY,
    });
    if (!resolvedKey) {
      throw new AiUnavailableError(
        'The AI assistant is not configured for this server yet. An admin needs to run `/ai config set-key` (or enable the environment-key fallback).',
      );
    }

    const effectiveMaxTokens = Math.max(1, Math.min(maxTokens ?? AI_MAX_OUTPUT_TOKENS, AI_MAX_OUTPUT_TOKENS));
    // Conservatively estimate the maximum possible spend: assume the prompt is large and we use all output tokens.
    const estimatedMaxTokens = Math.ceil(effectiveMaxTokens * 1.5); // 50% buffer for prompt tokens.

    const reserveResult = await reserveBudget(
      ctx.redis,
      guildId,
      userId,
      config.dailyTokenBudget,
      config.perUserDailyTokenBudget,
      estimatedMaxTokens,
    );
    if (!reserveResult.ok) {
      throw new RateLimitError(
        reserveResult.scope === 'guild'
          ? "This server's daily AI token budget has been used up. It resets at midnight UTC."
          : 'You have used up your daily AI token allowance. It resets at midnight UTC.',
      );
    }

    const provider = resolveProvider({ config, apiKey: resolvedKey.apiKey });
    const combinedSystem = system ? `${AI_SYSTEM_PROMPT}\n\n${system}` : AI_SYSTEM_PROMPT;

    let result;
    try {
      result = await provider.complete({
        system: combinedSystem,
        messages: [{ role: 'user', content: redact(prompt) }],
        maxTokens: effectiveMaxTokens,
        temperature: 0.4,
      });
    } catch (err) {
      // Provider call failed — refund the reservation.
      await releaseReservation(ctx.redis, guildId, userId, estimatedMaxTokens);
      throw err;
    }

    const totalTokens = result.promptTokens + result.completionTokens;
    // Reconcile the reservation with actual usage: adjust by the difference.
    const adjustment = totalTokens - estimatedMaxTokens;
    if (adjustment !== 0) {
      await reconcileUsage(ctx.redis, guildId, userId, adjustment);
    }

    await ctx.prisma.aiUsage.create({
      data: {
        guildId,
        userId,
        command,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        provider: provider.id,
        model: result.model,
      },
    });

    return {
      text: result.text,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      model: result.model,
      provider: provider.id,
    };
  }

  async function test(input: string | { guildId: string }): Promise<{ ok: boolean; detail?: string }> {
    // `bot-actions.ts`'s generic dispatcher (apps/bot/src/host/bot-actions.ts) invokes every service method the
    // same way — `method.call(service, { guildId, payload, requestedBy })` — even though this interface (and
    // most `ServiceMap` methods with a single `guildId: string` parameter) is declared to take a bare string.
    // Accepting either shape here means the dashboard's "Test connection" button (routed through that dispatcher)
    // works correctly instead of receiving an object where a string was expected; see openIssues for the mismatch.
    const guildId = typeof input === 'string' ? input : input.guildId;

    try {
      const config = await ctx.getConfig<AiConfig>(guildId);
      const resolvedKey = resolveApiKey(config, {
        OPENAI_API_KEY: ctx.env.OPENAI_API_KEY,
        ANTHROPIC_API_KEY: ctx.env.ANTHROPIC_API_KEY,
      });
      if (!resolvedKey) {
        return {
          ok: false,
          detail:
            'No API key is configured for this server (set one with `/ai config set-key`, or enable the environment-key fallback).',
        };
      }

      const provider = resolveProvider({ config, apiKey: resolvedKey.apiKey });
      const result = await provider.complete({
        system: AI_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: 'Reply with only the single word: ok' }],
        maxTokens: 8,
        temperature: 0,
      });

      await recordUsage(ctx.redis, guildId, 'system-test', result.promptTokens + result.completionTokens);
      await ctx.prisma.aiUsage.create({
        data: {
          guildId,
          userId: 'system-test',
          command: 'ai.test',
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          provider: provider.id,
          model: result.model,
        },
      });

      return { ok: true, detail: `Connected to ${provider.id} (${result.model}).` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  return { complete, test };
}
