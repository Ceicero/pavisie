import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBlackjackCommand } from '../blackjack/commands';
import { CoalescingOutbound, type OutboundSendResult } from '../outbound';

describe('blackjack command parsing', () => {
  const parse = (text: string, prefix = '!') => parseBlackjackCommand(text, prefix);

  it('reads the full commands', () => {
    expect(parse('!bj start')).toMatchObject({ kind: 'start', commandName: 'bj', viaAlias: false });
    expect(parse('!blackjack start')).toMatchObject({ kind: 'start', commandName: 'blackjack' });
    expect(parse('!bj stop')).toMatchObject({ kind: 'stop' });
    expect(parse('!bj deal')).toMatchObject({ kind: 'deal' });
    expect(parse('!bj join 50')).toMatchObject({ kind: 'join', amount: 50 });
    expect(parse('!bj bet 50')).toMatchObject({ kind: 'join', amount: 50 });
    expect(parse('!bj hit')).toMatchObject({ kind: 'hit' });
    expect(parse('!bj stay')).toMatchObject({ kind: 'stand' });
    expect(parse('!BJ JOIN 50')).toMatchObject({ kind: 'join', amount: 50, commandName: 'bj' });
  });

  it('shows help for a bare command or an unknown word', () => {
    expect(parse('!bj')).toMatchObject({ kind: 'help' });
    expect(parse('!bj whatever')).toMatchObject({ kind: 'help' });
  });

  it('reads the short forms and marks them as aliases', () => {
    for (const [text, kind] of [
      ['!hit', 'hit'],
      ['!stand', 'stand'],
      ['!double', 'double'],
      ['!split', 'split'],
      ['!leave', 'leave'],
    ] as const) {
      expect(parse(text)).toMatchObject({ kind, viaAlias: true, amount: null });
    }
    expect(parse('!join 25')).toMatchObject({
      kind: 'join',
      viaAlias: true,
      amount: 25,
      commandName: 'join',
    });
    expect(parse('!bet 25')).toMatchObject({ kind: 'join', viaAlias: true, amount: 25, commandName: 'bet' });
  });

  it('is not a blackjack command without the prefix, or for any other word', () => {
    expect(parse('bj start')).toBeNull();
    expect(parse('hit me')).toBeNull();
    expect(parse('!hello')).toBeNull();
    expect(parse('!')).toBeNull();
    expect(parse('!bj start', '')).toBeNull();
    expect(parse('?bj start', '?')).toMatchObject({ kind: 'start' });
  });

  it('accepts only a plain whole number as a bet', () => {
    for (const bad of ['', 'all', '50.5', '-50', '1e9', '0', '0x10', '５０', '50abc', '9999999999999']) {
      expect(parse(`!bj join ${bad}`)?.amount ?? null).toBeNull();
    }
    expect(parse('!bj join 007')?.amount).toBe(7);
  });

  it('never carries anything the viewer typed, beyond a fixed command word and a number', () => {
    const intent = parse('!bj join 50 SECRET-TEXT https://evil.example <script>');
    expect(JSON.stringify(intent)).not.toContain('SECRET');
    expect(JSON.stringify(intent)).not.toContain('evil');
    expect(Object.keys(intent ?? {}).sort()).toEqual(['amount', 'commandName', 'kind', 'viaAlias']);

    const junk = parse('!bj SECRET-TEXT');
    expect(JSON.stringify(junk)).not.toContain('SECRET');
  });
});

describe('coalescing outbound queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(reply: (text: string) => OutboundSendResult = () => 'sent') {
    const sent: { at: number; channel: string; text: string }[] = [];
    const dropped: { kept: boolean; reason: string }[] = [];
    const outbound = new CoalescingOutbound({
      send: async (channel, text) => {
        sent.push({ at: Date.now(), channel, text });
        return reply(text);
      },
      onDrop: (_channel, info) => dropped.push(info),
    });
    return { outbound, sent, dropped };
  }

  it('turns eight players acting at once into one message', async () => {
    const { outbound, sent } = harness();
    for (let i = 1; i <= 8; i += 1) outbound.enqueue('ch', `Player${i} hits`);
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text.split(' | ')).toHaveLength(8);
  });

  it('never sends more than one message per interval per channel, however much is queued', async () => {
    const { outbound, sent } = harness();
    // 400 lines trickling in over ten seconds.
    for (let i = 0; i < 400; i += 1) {
      outbound.enqueue('ch', `line ${i} ${'x'.repeat(60)}`, { keep: true });
      await vi.advanceTimersByTimeAsync(25);
    }
    await vi.advanceTimersByTimeAsync(120_000);

    expect(sent.length).toBeGreaterThan(10);
    for (let i = 1; i < sent.length; i += 1) {
      expect((sent[i]?.at ?? 0) - (sent[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(1100);
    }
    // Everything marked keep was delivered, in order.
    const delivered = sent.flatMap((s) => s.text.split(' | '));
    expect(delivered).toHaveLength(400);
    expect(delivered[0]).toContain('line 0 ');
    expect(delivered[399]).toContain('line 399 ');
  });

  it('keeps every message within 500 characters', async () => {
    const { outbound, sent } = harness();
    for (let i = 0; i < 30; i += 1) outbound.enqueue('ch', `${i}:${'y'.repeat(90)}`, { keep: true });
    outbound.enqueue('ch', 'z'.repeat(900), { keep: true });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((s) => s.text.length <= 500)).toBe(true);
  });

  it('replaces an older queued line that has the same key', async () => {
    const { outbound, sent } = harness();
    outbound.enqueue('ch', 'first');
    await vi.advanceTimersByTimeAsync(0);
    // These three wait for the next slot; only the newest table state should go out.
    outbound.enqueue('ch', 'Seats 1/8', { key: 'lobby' });
    outbound.enqueue('ch', 'someone joined');
    outbound.enqueue('ch', 'Seats 2/8', { key: 'lobby' });
    outbound.enqueue('ch', 'Seats 3/8', { key: 'lobby' });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sent.map((s) => s.text)).toEqual(['first', 'Seats 3/8 | someone joined']);
  });

  it('keeps separate channels separate', async () => {
    const { outbound, sent } = harness();
    outbound.enqueue('a', 'for a');
    outbound.enqueue('b', 'for b');
    await vi.advanceTimersByTimeAsync(0);

    expect(sent.map((s) => `${s.channel}:${s.text}`).sort()).toEqual(['a:for a', 'b:for b']);
  });

  it('holds its lines and tries again when the sender says "not now"', async () => {
    let busy = 2;
    const { outbound, sent } = harness(() => (busy-- > 0 ? 'retry' : 'sent'));
    outbound.enqueue('ch', 'result line', { keep: true });
    outbound.enqueue('ch', 'a notice');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sent).toHaveLength(3);
    expect(sent[2]?.text).toBe('result line | a notice');
    expect(outbound.pending('ch')).toBe(0);
  });

  it('never drops a kept line when sends fail, but lets best-effort lines go', async () => {
    let failures = 3;
    const { outbound, sent, dropped } = harness(() => (failures-- > 0 ? 'failed' : 'sent'));
    outbound.enqueue('ch', 'FINAL RESULT', { keep: true });
    outbound.enqueue('ch', 'a notice');
    await vi.advanceTimersByTimeAsync(10_000);

    expect(sent[sent.length - 1]?.text).toBe('FINAL RESULT');
    expect(dropped).toEqual([{ kept: false, reason: 'failed' }]);
  });

  it('lets a best-effort line go stale but never a kept one', async () => {
    let open = false;
    const { outbound, sent, dropped } = harness(() => (open ? 'sent' : 'retry'));
    outbound.enqueue('ch', 'old notice');
    outbound.enqueue('ch', 'FINAL RESULT', { keep: true });
    await vi.advanceTimersByTimeAsync(20_000);
    open = true;
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sent[sent.length - 1]?.text).toBe('FINAL RESULT');
    expect(dropped).toEqual([{ kept: false, reason: 'stale' }]);
  });

  it('gives up on a kept line only after many failed attempts, and says so without the text', async () => {
    const { outbound, dropped } = harness(() => 'failed');
    outbound.enqueue('ch', 'FINAL RESULT', { keep: true });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(dropped).toEqual([{ kept: true, reason: 'failed' }]);
    expect(JSON.stringify(dropped)).not.toContain('FINAL');
    expect(outbound.pending('ch')).toBe(0);
  });

  it('resolves idle() once everything has gone out', async () => {
    const { outbound, sent } = harness();
    outbound.enqueue('ch', 'one');
    let idle = false;
    void outbound.idle('ch').then(() => {
      idle = true;
    });
    expect(idle).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(sent).toHaveLength(1);
    expect(idle).toBe(true);
  });

  it('sends nothing after stop()', async () => {
    const { outbound, sent } = harness();
    outbound.enqueue('ch', 'one');
    outbound.stop();
    outbound.enqueue('ch', 'two');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toHaveLength(0);
  });
});
