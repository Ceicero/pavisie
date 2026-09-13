import { z } from 'zod';
import { EMBED_LIMITS, truncate } from '@pavisie/core';
import { getValidAccessToken } from './oauth-tokens';
import { claimAlertOnce, markConnectionError, markConnectionSynced, sendConnectionAlert } from './util';
import type { IntegrationProviderDef } from './types';
import type { AlertEmbedData } from '../formatters/types';

const GOOGLE_BLUE = 0x4285f4;
const LOOKAHEAD_HOURS = 24;

export const googleCalendarConfigSchema = z.object({
  // 'target' is unused for calendar (always the connected account's primary calendar) but kept for shape parity
  // with the other alert-style providers' commands; the dashboard leaves it blank.
  target: z.string().max(200).nullable().optional().default(''),
  channelId: z.string().regex(/^\d{17,20}$/),
  roleId: z
    .string()
    .regex(/^\d{17,20}$/)
    .nullable()
    .optional(),
  template: z.string().max(300).nullable().optional(),
});

interface GoogleEventsResponse {
  items?: {
    id: string;
    summary?: string;
    htmlLink?: string;
    start?: { dateTime?: string; date?: string };
    location?: string;
  }[];
}

function eventEmbed(item: NonNullable<GoogleEventsResponse['items']>[number]): AlertEmbedData {
  const start = item.start?.dateTime ?? item.start?.date;
  const startTs = start ? Math.floor(new Date(start).getTime() / 1000) : null;
  return {
    title: truncate(item.summary ?? '(untitled event)', EMBED_LIMITS.title),
    url: item.htmlLink,
    description: startTs ? `Starts <t:${startTs}:F> (<t:${startTs}:R>)` : 'Upcoming event',
    color: GOOGLE_BLUE,
    fields: item.location
      ? [{ name: 'Location', value: truncate(item.location, EMBED_LIMITS.fieldValue) }]
      : [],
    footer: 'Google Calendar',
  };
}

export const googleCalendarProvider: IntegrationProviderDef = {
  id: 'google_calendar',
  name: 'Google Calendar',
  kind: 'oauth',
  requiredEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  pollIntervalSeconds: 900,
  configSchema: googleCalendarConfigSchema,
  async poll(ctx, connection) {
    const accessToken = await getValidAccessToken(ctx, 'google_calendar', connection);
    if (!accessToken) {
      await markConnectionError(
        ctx,
        connection.id,
        'Google Calendar is not authorized (connect again from the dashboard).',
      );
      return;
    }

    const now = new Date();
    const timeMax = new Date(now.getTime() + LOOKAHEAD_HOURS * 60 * 60 * 1000);
    const params = new URLSearchParams({
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: '10',
      singleEvents: 'true',
      orderBy: 'startTime',
    });

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!res.ok) {
      await markConnectionError(ctx, connection.id, `Google Calendar request failed (${res.status}).`);
      return;
    }
    const json = (await res.json()) as GoogleEventsResponse;

    for (const item of json.items ?? []) {
      const isNew = await claimAlertOnce(ctx, 'google_calendar', connection.id, item.id);
      if (!isNew) continue;
      await sendConnectionAlert(ctx, connection, eventEmbed(item));
    }

    await markConnectionSynced(ctx, connection.id);
  },
};
