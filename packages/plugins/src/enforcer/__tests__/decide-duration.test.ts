import { describe, expect, it, vi } from 'vitest';
import type { EmbedBuilder, ModalSubmitInteraction } from 'discord.js';
import type { ComponentContext } from '../../sdk';
import { createTestContext } from '../../sdk/testing';
import { decideComponents } from '../components/decide';
import type { EnforcerService } from '../../sdk/services';

const decideModalHandler = decideComponents.find((h) => h.action === 'decide-modal')!;

/** `decide-modal`'s handler never calls `c.config()`, so a trivial stub is enough. */
function buildContext(
  args: string[],
  fieldValues: Record<string, string>,
  decide: EnforcerService['decide'],
) {
  const { ctx } = createTestContext();
  ctx.services.register('enforcer', {
    decide,
    flag: vi.fn(),
    search: vi.fn(),
  } as unknown as EnforcerService);

  const replies: { embeds?: EmbedBuilder[] }[] = [];
  const interaction = {
    user: { id: 'mod-1' },
    fields: { getTextInputValue: (id: string) => fieldValues[id] ?? '' },
    reply: vi.fn(async (payload: { embeds?: EmbedBuilder[] }) => {
      replies.push(payload);
    }),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
  };

  const c: ComponentContext<ModalSubmitInteraction<'cached'>> = {
    interaction: interaction as unknown as ModalSubmitInteraction<'cached'>,
    ctx,
    guildId: 'g1',
    staffLevel: 'admin',
    locale: 'en-US' as never,
    t: (key: string) => key,
    config: async <T,>() => ({}) as T,
    args,
  };

  return { c, interaction, replies };
}

function replyText(replies: { embeds?: EmbedBuilder[] }[]): string {
  return replies[0]?.embeds?.[0]?.data.description ?? '';
}

describe('Enforcer decide modal — duration validation (BUG 3)', () => {
  it('rejects a TIMEOUT duration below the 5-second floor instead of proceeding', async () => {
    const decide = vi.fn();
    const { c, interaction, replies } = buildContext(
      ['rec-1', 'TIMEOUT'],
      { reason: 'spam', duration: '1s' },
      decide,
    );

    await decideModalHandler.handler(c as never);

    expect(decide).not.toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(replyText(replies)).toMatch(/at least 5 seconds/i);
  });

  it("rejects a TIMEOUT duration above Discord's 28-day cap instead of proceeding", async () => {
    const decide = vi.fn();
    const { c, interaction, replies } = buildContext(
      ['rec-1', 'TIMEOUT'],
      { reason: 'spam', duration: '40d' },
      decide,
    );

    await decideModalHandler.handler(c as never);

    expect(decide).not.toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(replyText(replies)).toMatch(/28 days/i);
  });

  it('accepts a valid TIMEOUT duration and passes the parsed milliseconds through to decide()', async () => {
    const decide = vi.fn(async () => ({ recordNumber: 5 }));
    const { c, interaction } = buildContext(
      ['rec-1', 'TIMEOUT'],
      { reason: 'spam', duration: '10m' },
      decide,
    );

    await decideModalHandler.handler(c as never);

    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 10 * 60_000 }));
    expect(interaction.editReply).toHaveBeenCalled();
  });

  it('rejects a MUTE duration below the 5-second floor', async () => {
    const decide = vi.fn();
    const { c, replies } = buildContext(['rec-1', 'MUTE'], { reason: 'x', duration: '2s' }, decide);

    await decideModalHandler.handler(c as never);

    expect(decide).not.toHaveBeenCalled();
    expect(replyText(replies)).toMatch(/at least 5 seconds/i);
  });

  it('accepts a MUTE duration well past the 28-day timeout cap (MUTE has no such cap)', async () => {
    const decide = vi.fn(async () => ({ recordNumber: 6 }));
    const { c } = buildContext(['rec-1', 'MUTE'], { reason: 'x', duration: '60d' }, decide);

    await decideModalHandler.handler(c as never);

    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 60 * 86_400_000 }));
  });

  it('rejects a MUTE duration past the 1-year ceiling', async () => {
    const decide = vi.fn();
    const { c, replies } = buildContext(['rec-1', 'MUTE'], { reason: 'x', duration: '400d' }, decide);

    await decideModalHandler.handler(c as never);

    expect(decide).not.toHaveBeenCalled();
    expect(replyText(replies)).toMatch(/1 year/i);
  });

  it('leaves durationMs undefined (server default) when the duration field is left blank', async () => {
    const decide = vi.fn(async () => ({ recordNumber: 7 }));
    const { c } = buildContext(['rec-1', 'TIMEOUT'], { reason: 'spam', duration: '' }, decide);

    await decideModalHandler.handler(c as never);

    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ durationMs: undefined }));
  });
});
