import { describe, expect, it } from 'vitest';
import {
  RewardCooldowns,
  applyRewardTemplate,
  matchRewardActions,
  sanitizeRewardText,
  type RewardRedemptionEvent,
} from '../twitch-chat/rewards';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture stands in for the full Prisma model.
function makeRewardRow(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'reward-1',
    channelId: 'channel-a',
    guildId: 'guild-1',
    rewardId: 'twitch-reward-1',
    rewardTitle: 'Hydrate!',
    enabled: true,
    action: 'CHAT',
    soundUrl: null,
    volume: 80,
    ttsTemplate: null,
    chatTemplate: 'Thanks {user}!',
    discordChannelId: null,
    discordTemplate: null,
    cooldownSeconds: 0,
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<RewardRedemptionEvent> = {}): RewardRedemptionEvent {
  return {
    rewardId: 'twitch-reward-1',
    rewardTitle: 'Hydrate!',
    userInput: 'hello world',
    userDisplayName: 'ViewerOne',
    ...overrides,
  };
}

describe('matchRewardActions — matching', () => {
  it('matches by rewardId when the row has one, ignoring rewardTitle entirely', () => {
    const row = makeRewardRow({ rewardId: 'twitch-reward-1', rewardTitle: 'Some Other Title' });
    const actions = matchRewardActions('channel-a', [row], makeEvent({ rewardId: 'twitch-reward-1' }), new RewardCooldowns());
    expect(actions).toHaveLength(1);
  });

  it('does not match by rewardId when the ids differ, even if titles happen to match', () => {
    const row = makeRewardRow({ rewardId: 'twitch-reward-1', rewardTitle: 'Hydrate!' });
    const actions = matchRewardActions(
      'channel-a',
      [row],
      makeEvent({ rewardId: 'some-other-id', rewardTitle: 'Hydrate!' }),
      new RewardCooldowns(),
    );
    expect(actions).toHaveLength(0);
  });

  it('falls back to case-insensitive rewardTitle matching when the row has no rewardId', () => {
    const row = makeRewardRow({ rewardId: null, rewardTitle: 'Hydrate!' });
    const actions = matchRewardActions(
      'channel-a',
      [row],
      makeEvent({ rewardId: 'whatever-twitch-assigned', rewardTitle: 'HYDRATE!' }),
      new RewardCooldowns(),
    );
    expect(actions).toHaveLength(1);
  });

  it('does not match a different title when matching by title', () => {
    const row = makeRewardRow({ rewardId: null, rewardTitle: 'Hydrate!' });
    const actions = matchRewardActions(
      'channel-a',
      [row],
      makeEvent({ rewardId: 'whatever', rewardTitle: 'Something Else' }),
      new RewardCooldowns(),
    );
    expect(actions).toHaveLength(0);
  });

  it('skips disabled rows even when they otherwise match', () => {
    const row = makeRewardRow({ enabled: false });
    const actions = matchRewardActions('channel-a', [row], makeEvent(), new RewardCooldowns());
    expect(actions).toHaveLength(0);
  });

  it('a single redemption can match multiple rows (one per configured action kind)', () => {
    const rows = [
      makeRewardRow({ id: 'r1', action: 'CHAT', chatTemplate: 'chat!' }),
      makeRewardRow({ id: 'r2', action: 'SOUND', soundUrl: 'https://example.com/s.mp3' }),
    ];
    const actions = matchRewardActions('channel-a', rows, makeEvent(), new RewardCooldowns());
    expect(actions.map((a) => a.kind).sort()).toEqual(['CHAT', 'SOUND']);
  });

  it('a row missing its action-specific required field is silently skipped, not dispatched with undefined fields', () => {
    const row = makeRewardRow({ action: 'CHAT', chatTemplate: null });
    const actions = matchRewardActions('channel-a', [row], makeEvent(), new RewardCooldowns());
    expect(actions).toHaveLength(0);
  });
});

describe('matchRewardActions — cooldown gate', () => {
  it('blocks a second redemption of the same reward row within its cooldown window', () => {
    const row = makeRewardRow({ cooldownSeconds: 30 });
    const cooldowns = new RewardCooldowns();
    const now = 1_000_000;

    const first = matchRewardActions('channel-a', [row], makeEvent(), cooldowns, now);
    expect(first).toHaveLength(1);

    const second = matchRewardActions('channel-a', [row], makeEvent(), cooldowns, now + 10_000);
    expect(second).toHaveLength(0);
  });

  it('allows the next redemption once the cooldown has elapsed', () => {
    const row = makeRewardRow({ cooldownSeconds: 30 });
    const cooldowns = new RewardCooldowns();
    const now = 1_000_000;

    expect(matchRewardActions('channel-a', [row], makeEvent(), cooldowns, now)).toHaveLength(1);
    expect(matchRewardActions('channel-a', [row], makeEvent(), cooldowns, now + 31_000)).toHaveLength(1);
  });

  it('cooldownSeconds of 0 (the default) never blocks', () => {
    const row = makeRewardRow({ cooldownSeconds: 0 });
    const cooldowns = new RewardCooldowns();
    const now = 1_000_000;

    expect(matchRewardActions('channel-a', [row], makeEvent(), cooldowns, now)).toHaveLength(1);
    expect(matchRewardActions('channel-a', [row], makeEvent(), cooldowns, now + 1)).toHaveLength(1);
  });

  it('cooldowns are independent per reward ROW id, not per reward title — two rows for the same title/reward each get their own cooldown', () => {
    const rows = [
      makeRewardRow({ id: 'r1', action: 'CHAT', chatTemplate: 'chat!', cooldownSeconds: 30 }),
      makeRewardRow({ id: 'r2', action: 'SOUND', soundUrl: 'https://example.com/s.mp3', cooldownSeconds: 30 }),
    ];
    const cooldowns = new RewardCooldowns();
    const now = 1_000_000;

    expect(matchRewardActions('channel-a', rows, makeEvent(), cooldowns, now)).toHaveLength(2);
    // Immediately again — both rows should now be on cooldown independently, not affecting each other's state.
    expect(matchRewardActions('channel-a', rows, makeEvent(), cooldowns, now + 1)).toHaveLength(0);
  });

  it('pruneChannel clears cooldowns for a channel so a later redemption is not blocked by stale state', () => {
    const row = makeRewardRow({ cooldownSeconds: 9999 });
    const cooldowns = new RewardCooldowns();
    const now = 1_000_000;

    expect(matchRewardActions('channel-a', [row], makeEvent(), cooldowns, now)).toHaveLength(1);
    expect(matchRewardActions('channel-a', [row], makeEvent(), cooldowns, now + 1)).toHaveLength(0);

    cooldowns.pruneChannel('channel-a');

    expect(matchRewardActions('channel-a', [row], makeEvent(), cooldowns, now + 2)).toHaveLength(1);
  });

  it('pruneChannel only clears the named channel, leaving other channels alone', () => {
    const row = makeRewardRow({ cooldownSeconds: 9999 });
    const cooldowns = new RewardCooldowns();
    const now = 1_000_000;

    expect(matchRewardActions('channel-a', [row], makeEvent(), cooldowns, now)).toHaveLength(1);
    expect(matchRewardActions('channel-b', [row], makeEvent(), cooldowns, now)).toHaveLength(1);

    cooldowns.pruneChannel('channel-a');

    expect(matchRewardActions('channel-a', [row], makeEvent(), cooldowns, now + 1)).toHaveLength(1); // pruned, allowed again
    expect(matchRewardActions('channel-b', [row], makeEvent(), cooldowns, now + 1)).toHaveLength(0); // untouched, still on cooldown
  });

  it('cooldown is only consumed when buildAction succeeds — a failed action (e.g., template resolves to whitespace) does not burn the cooldown', () => {
    // Row with a cooldown that will resolve to an empty action
    const row = makeRewardRow({
      cooldownSeconds: 30,
      action: 'CHAT',
      chatTemplate: '{input}', // Will be empty/whitespace, failing the action build
    });
    const cooldowns = new RewardCooldowns();
    const now = 1_000_000;

    // First redemption: input resolves to only whitespace, action fails to build, cooldown NOT consumed
    const first = matchRewardActions(
      'channel-a',
      [row],
      makeEvent({ userInput: '   \n\t  ' }), // Just whitespace
      cooldowns,
      now,
    );
    expect(first).toHaveLength(0); // No action produced

    // Second redemption immediately after: should succeed because cooldown was never consumed
    const second = matchRewardActions(
      'channel-a',
      [row],
      makeEvent({ userInput: 'hello world' }), // Valid input
      cooldowns,
      now + 1,
    );
    expect(second).toHaveLength(1); // Action produced this time
    expect((second[0] as { text: string }).text).toBe('hello world');
  });
});

describe('templating', () => {
  it('fills {user}, {input}, and {reward} and nothing else', () => {
    const result = applyRewardTemplate('{user} said {input} for {reward} — {notAPlaceholder}', {
      user: 'Viewer',
      input: 'hi',
      reward: 'Say Hi',
    });
    expect(result).toBe('Viewer said hi for Say Hi — {notAPlaceholder}');
  });

  it('CHAT/DISCORD/TTS actions all apply {user}/{input}/{reward} templating end to end', () => {
    const rows = [
      makeRewardRow({ id: 'r-chat', action: 'CHAT', chatTemplate: '{user}:{input}:{reward}' }),
      makeRewardRow({
        id: 'r-discord',
        action: 'DISCORD',
        discordChannelId: 'chan-1',
        discordTemplate: '{user}:{input}:{reward}',
      }),
      makeRewardRow({ id: 'r-tts', action: 'TTS', ttsTemplate: '{user}:{input}:{reward}' }),
    ];
    const actions = matchRewardActions(
      'channel-a',
      rows,
      makeEvent({ userDisplayName: 'Viewer', userInput: 'input-text', rewardTitle: 'Hydrate!' }),
      new RewardCooldowns(),
    );

    const byKind = Object.fromEntries(actions.map((a) => [a.kind, a]));
    expect((byKind.CHAT as { text: string }).text).toBe('Viewer:input-text:Hydrate!');
    expect((byKind.DISCORD as { text: string }).text).toBe('Viewer:input-text:Hydrate!');
    expect((byKind.TTS as { text: string }).text).toBe('Viewer:input-text:Hydrate!');
  });

  it('SOUND actions carry soundUrl/volume through untouched, with no templating applied to them', () => {
    const row = makeRewardRow({ action: 'SOUND', soundUrl: 'https://example.com/{user}.mp3', volume: 42 });
    const actions = matchRewardActions('channel-a', [row], makeEvent(), new RewardCooldowns());
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'SOUND', soundUrl: 'https://example.com/{user}.mp3', volume: 42 }),
    ]);
  });
});

describe('safety gate (sanitizeRewardText)', () => {
  it('strips control characters', () => {
    expect(sanitizeRewardText('hello\x00wor\x1Fld\x7F!', 100)).toBe('hello wor ld !');
  });

  it('collapses runs of whitespace to a single space and trims', () => {
    expect(sanitizeRewardText('  hello    world  \n\n done  ', 100)).toBe('hello world done');
  });

  it('caps length after templating and sanitizing', () => {
    const longText = 'a'.repeat(500);
    expect(sanitizeRewardText(longText, 50)).toHaveLength(50);
  });

  it('TTS text is capped at 200 chars after templating', () => {
    const row = makeRewardRow({ action: 'TTS', ttsTemplate: '{input}' });
    const actions = matchRewardActions(
      'channel-a',
      [row],
      makeEvent({ userInput: 'x'.repeat(500) }),
      new RewardCooldowns(),
    );
    expect(actions).toHaveLength(1);
    expect((actions[0] as { text: string }).text).toHaveLength(200);
  });

  it('CHAT/DISCORD text is capped at 300 chars after templating', () => {
    const rows = [
      makeRewardRow({ id: 'r-chat', action: 'CHAT', chatTemplate: '{input}' }),
      makeRewardRow({ id: 'r-discord', action: 'DISCORD', discordChannelId: 'chan-1', discordTemplate: '{input}' }),
    ];
    const actions = matchRewardActions(
      'channel-a',
      rows,
      makeEvent({ userInput: 'y'.repeat(500) }),
      new RewardCooldowns(),
    );
    for (const action of actions) {
      expect((action as { text: string }).text).toHaveLength(300);
    }
  });

  it('a template that resolves to only control characters/whitespace yields no action at all', () => {
    const row = makeRewardRow({ action: 'CHAT', chatTemplate: '{input}' });
    const actions = matchRewardActions(
      'channel-a',
      [row],
      makeEvent({ userInput: '\x00\x01   \n\t  ' }),
      new RewardCooldowns(),
    );
    expect(actions).toHaveLength(0);
  });

  it('an oversized {input} cannot smuggle a too-long final string past the cap (cap applies AFTER templating)', () => {
    const row = makeRewardRow({ action: 'CHAT', chatTemplate: 'prefix {input} suffix' });
    const actions = matchRewardActions(
      'channel-a',
      [row],
      makeEvent({ userInput: 'z'.repeat(1000) }),
      new RewardCooldowns(),
    );
    expect((actions[0] as { text: string }).text.length).toBeLessThanOrEqual(300);
  });
});

describe('privacy: matchRewardActions never logs (it has no logging dependency at all)', () => {
  it('is a pure function that only returns data — nothing to spy on, by construction', () => {
    // rewards.ts imports no logger and calls no I/O; the only way it could ever leak `userInput`/
    // `userDisplayName` is by including them in its RETURN VALUE, which is expected (the caller needs the
    // templated text to actually dispatch the action). This test documents/locks that contract: the secret
    // values only ever appear inside the templated `text`/nowhere else on the action object.
    const SECRET_INPUT = 'SECRET_INPUT_marker';
    const SECRET_NAME = 'SECRET_NAME_marker';
    const row = makeRewardRow({ action: 'CHAT', chatTemplate: 'no placeholders here' });
    const actions = matchRewardActions(
      'channel-a',
      [row],
      makeEvent({ userInput: SECRET_INPUT, userDisplayName: SECRET_NAME }),
      new RewardCooldowns(),
    );

    expect(actions).toHaveLength(1);
    // The template didn't reference {user}/{input}, so neither secret appears anywhere in the result at all.
    expect(JSON.stringify(actions)).not.toContain(SECRET_INPUT);
    expect(JSON.stringify(actions)).not.toContain(SECRET_NAME);
  });
});
