import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '@pavisie/core';
import { buildTestApp } from './helpers/build-test-app';

function eventSubSignature(secret: string, messageId: string, timestamp: string, body: string): string {
  return `sha256=${createHmac('sha256', secret)
    .update(messageId + timestamp + body)
    .digest('hex')}`;
}

function twitchHeaders(body: string, messageType: string, messageId = 'msg-1') {
  const timestamp = new Date().toISOString();
  return {
    'content-type': 'application/json',
    'twitch-eventsub-message-id': messageId,
    'twitch-eventsub-message-timestamp': timestamp,
    'twitch-eventsub-message-type': messageType,
    'twitch-eventsub-message-signature': eventSubSignature(
      env.TWITCH_EVENTSUB_SECRET!,
      messageId,
      timestamp,
      body,
    ),
  };
}

describe('POST /webhooks/twitch', () => {
  it('echoes the challenge back on webhook_callback_verification', async () => {
    const { app } = await buildTestApp();
    const body = JSON.stringify({ challenge: 'abc123', subscription: { type: 'stream.online' } });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/twitch',
      headers: twitchHeaders(body, 'webhook_callback_verification'),
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('abc123');
    await app.close();
  });

  it('errors every matching connection and drops the stale subscription id on revocation', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    rows.set('conn1', {
      id: 'conn1',
      guildId: '999999999999999999',
      provider: 'TWITCH',
      deletedAt: null,
      config: { target: 'shroud', channelId: '1', eventSubId: 'sub-abc' },
    });
    rows.set('conn2', {
      id: 'conn2',
      guildId: '999999999999999999',
      provider: 'TWITCH',
      deletedAt: null,
      config: { target: 'other', channelId: '2', eventSubId: 'sub-other' },
    });

    const updates: unknown[] = [];
    const { app } = await buildTestApp({
      integrationConnection: {
        findMany: async () => [...rows.values()],
        update: async (args: unknown) => {
          updates.push(args);
          return {};
        },
      },
    });

    const body = JSON.stringify({
      subscription: {
        id: 'sub-abc',
        type: 'stream.online',
        status: 'authorization_revoked',
        condition: { broadcaster_user_id: '123' },
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/twitch',
      headers: twitchHeaders(body, 'revocation'),
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    expect(updates).toHaveLength(1); // only the matching connection (conn1) is updated, not conn2
    expect(updates[0]).toMatchObject({ where: { id: 'conn1' }, data: { status: 'ERROR' } });

    await app.close();
  });

  it('rejects an invalid EventSub signature', async () => {
    const { app } = await buildTestApp();
    const body = JSON.stringify({ subscription: { type: 'stream.online' } });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/twitch',
      headers: {
        ...twitchHeaders(body, 'notification'),
        'twitch-eventsub-message-signature': 'sha256=deadbeef',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
