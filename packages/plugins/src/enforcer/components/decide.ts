import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import {
  assertStaffLevel,
  buildCustomId,
  classifyDiscordFailure,
  discordErrorCode,
  discordFailureKey,
  errorEmbed,
  successEmbed,
  type ComponentHandler,
} from '../../sdk';
import type { EnforcerDecideInput } from '../../sdk/services';
// The modal previously parsed duration with the raw `parseDuration` and used it as-is, skipping the floor/cap
// validation `/mod timeout` applies via `parseTimeoutDuration` — reusing that (and a matching bounded parse for
// MUTE, which has no Discord cap) closes that gap. Both are dependency-free pure functions; enforcer already
// depends on moderation being enabled (`/enforcer setup` refuses otherwise), so this just formalizes that in code.
import { parseMuteDuration, parseTimeoutDuration } from '../../moderation/duration';
import type { EnforcerConfig } from '../manifest';

type Decision = EnforcerDecideInput['decision'];

/** Shared Discord-failure sentence, or `errors.generic` for any other numeric Discord code. Never reads `err.message`. */
function discordRestReply(
  t: (key: string, vars?: Record<string, string | number>) => string,
  err: unknown,
): string | null {
  const key = discordFailureKey(err);
  if (key) return t(key);
  if (classifyDiscordFailure(err) !== null || discordErrorCode(err) !== null) return t('errors.generic');
  return null;
}

const REQUIRE_REASON_KEY: Partial<Record<Decision, 'warn' | 'timeout' | 'mute' | 'kick' | 'ban'>> = {
  WARN: 'warn',
  TIMEOUT: 'timeout',
  MUTE: 'mute',
  KICK: 'kick',
  BAN: 'ban',
};

/** The subset of `Decision` a flag-queue button/modal can ever carry — excludes `UNMUTE`, which isn't a queue action. */
const QUEUE_DECISIONS = ['WARN', 'TIMEOUT', 'MUTE', 'KICK', 'BAN', 'DISMISS'] as const;

/**
 * Normalises the `<decision>` custom-id arg. `embeds.ts` builds decision buttons with lowercase ids
 * (`enforcer:decide:<recordId>:warn`, locked in by `embeds.test.ts`), but the service and this file's own
 * comparisons work in uppercase — so every read of the arg must go through this instead of a raw cast.
 * Returns null for anything outside the six queue decisions (including `unmute`, which has no queue button).
 */
export function parseDecisionArg(raw: string | undefined): Decision | null {
  const upper = raw?.toUpperCase();
  return QUEUE_DECISIONS.includes(upper as (typeof QUEUE_DECISIONS)[number]) ? (upper as Decision) : null;
}

function needsModal(decision: Decision, config: EnforcerConfig): boolean {
  if (decision === 'DISMISS') return false;
  const key = REQUIRE_REASON_KEY[decision];
  // Kick/Ban/Timeout/Mute always collect a reason and (for timeout/mute) a duration, or (for ban) a delete-days
  // window, through the modal even when a reason isn't strictly required — Warn is the one decision that can
  // skip the modal entirely when the server hasn't required a reason for it (ARCHITECTURE.md §19).
  if (decision === 'WARN') return Boolean(key && config.requireReasonOn.includes(key));
  return true;
}

/** `enforcer:decide:<recordId>:<decision>` — every allowed decision button on a flag-queue embed. */
const decideButtonHandler: ComponentHandler = {
  action: 'decide',
  kind: 'button',
  ownerOnly: false,
  // Host router requires at least `helper` for anyone to reach the handler at all (Dismiss/View context are
  // `helper`, ARCHITECTURE.md §19); the explicit `assertStaffLevel(..., 'moderator')` below still gates every
  // decision except DISMISS.
  requirement: { staffLevel: 'helper' },
  async handler(c) {
    const [recordId, decisionRaw] = c.args;
    const decision = parseDecisionArg(decisionRaw);
    if (!decision) {
      await (c.interaction as ButtonInteraction<'cached'>).reply({
        embeds: [errorEmbed(c.t('decide.unknown'))],
        ephemeral: true,
      });
      return;
    }
    if (decision !== 'DISMISS') {
      assertStaffLevel(c.staffLevel, 'moderator', c.t);
    }

    const config = await c.config<EnforcerConfig>();

    if (!needsModal(decision, config)) {
      const interaction = c.interaction as ButtonInteraction<'cached'>;
      await interaction.deferUpdate();
      const enforcer = c.ctx.services.require('enforcer');
      try {
        const result = await enforcer.decide({
          guildId: c.guildId,
          recordId,
          decision,
          moderatorId: interaction.user.id,
          source: 'bot',
        });
        await interaction.followUp({
          embeds: [successEmbed(c.t('decide.recorded', { decision, number: result.recordNumber }))],
          ephemeral: true,
        });
      } catch (err) {
        const text = discordRestReply(c.t, err);
        if (!text) throw err;
        await interaction.followUp({ embeds: [errorEmbed(text)], ephemeral: true });
      }
      return;
    }

    const reasonRequired = Boolean(
      REQUIRE_REASON_KEY[decision] && config.requireReasonOn.includes(REQUIRE_REASON_KEY[decision]!),
    );
    const rows = [
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('reason')
          .setLabel(c.t('decide.reasonLabel'))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(reasonRequired)
          .setMaxLength(1000),
      ),
    ];
    if (decision === 'TIMEOUT' || decision === 'MUTE') {
      rows.push(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('duration')
            .setLabel(c.t('decide.durationLabel'))
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(20),
        ),
      );
    }
    if (decision === 'BAN') {
      rows.push(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('deleteDays')
            .setLabel(c.t('decide.deleteDaysLabel'))
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(1),
        ),
      );
    }

    const modal = new ModalBuilder()
      .setCustomId(buildCustomId('enforcer', 'decide-modal', recordId, decision))
      .setTitle(c.t('decide.modalTitle', { decision, id: recordId.slice(-6) }))
      .addComponents(...rows);
    await (c.interaction as ButtonInteraction<'cached'>).showModal(modal);
  },
};

/** `enforcer:decide-modal:<recordId>:<decision>` — the reason/duration/ban-delete modal submit. */
const decideModalHandler: ComponentHandler = {
  action: 'decide-modal',
  kind: 'modal',
  ownerOnly: false,
  requirement: { staffLevel: 'helper' },
  async handler(c) {
    const [recordId, decisionRaw] = c.args;
    const decision = parseDecisionArg(decisionRaw);
    if (!decision) {
      await (c.interaction as ModalSubmitInteraction<'cached'>).reply({
        embeds: [errorEmbed(c.t('decide.unknown'))],
        ephemeral: true,
      });
      return;
    }
    assertStaffLevel(c.staffLevel, 'moderator', c.t);

    const interaction = c.interaction as ModalSubmitInteraction<'cached'>;
    const reason = interaction.fields.getTextInputValue('reason').trim() || undefined;

    let durationMs: number | undefined;
    if (decision === 'TIMEOUT' || decision === 'MUTE') {
      const raw = interaction.fields.getTextInputValue('duration')?.trim();
      if (raw) {
        // TIMEOUT is a real Discord timeout (28-day cap, `/mod timeout`'s own floor); MUTE is a role add with a
        // locally tracked expiry and no Discord cap, so it gets a wider but still bounded parse (BUG FIX: this
        // modal used to skip validation entirely and pass the raw parse straight through).
        const parsed = decision === 'TIMEOUT' ? parseTimeoutDuration(raw) : parseMuteDuration(raw);
        if (!parsed.ok) {
          await interaction.reply({ embeds: [errorEmbed(parsed.error)], ephemeral: true });
          return;
        }
        durationMs = parsed.ms;
      }
    }

    let banDeleteMessageSeconds: number | undefined;
    if (decision === 'BAN') {
      const raw = interaction.fields.getTextInputValue('deleteDays')?.trim();
      const days = raw ? Number(raw) : NaN;
      if (Number.isFinite(days) && days >= 0)
        banDeleteMessageSeconds = Math.min(7, Math.floor(days)) * 86_400;
    }

    await interaction.deferReply({ ephemeral: true });
    const enforcer = c.ctx.services.require('enforcer');
    try {
      const result = await enforcer.decide({
        guildId: c.guildId,
        recordId,
        decision,
        moderatorId: interaction.user.id,
        reason,
        durationMs,
        banDeleteMessageSeconds,
        source: 'bot',
      });
      await interaction.editReply({
        embeds: [successEmbed(c.t('decide.recorded', { decision, number: result.recordNumber }))],
      });
    } catch (err) {
      const text = discordRestReply(c.t, err);
      if (!text) throw err;
      await interaction.editReply({ embeds: [errorEmbed(text)] });
    }
  },
};

export const decideComponents: ComponentHandler[] = [decideButtonHandler, decideModalHandler];
