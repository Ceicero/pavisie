import { z } from 'zod';
import { EMBED_LIMITS, truncate } from '@pavisie/core';
import { getValidAccessToken } from './oauth-tokens';
import { claimAlertOnce, markConnectionError, markConnectionSynced, sendConnectionAlert } from './util';
import type { IntegrationProviderDef } from './types';
import type { AlertEmbedData } from '../formatters/types';

const MICROSOFT_BLUE = 0x0078d4;
const LOOKAHEAD_HOURS = 24;

export const microsoftCalendarConfigSchema = z.object({
  target: z.string().max(200).nullable().optional().default(''),
  channelId: z.string().regex(/^\d{17,20}$/),
  roleId: z
    .string()
    .regex(/^\d{17,20}$/)
    .nullable()
    .optional(),
  template: z.string().max(300).nullable().optional(),
});

interface GraphEventsResponse {
  value?: {
    id: string;
    subject?: string;
    webLink?: string;
    start?: { dateTime?: string };
    location?: { displayName?: string };
  }[];
}

function eventEmbed(item: NonNullable<GraphEventsResponse['value']>[number]): AlertEmbedData {
  const start = item.start?.dateTime;
  // Graph returns naive local-timezone datetimes by default; treated as UTC here (Prefer: outlook.timezone below).
  const startTs = start ? Math.floor(new Date(`${start}Z`).getTime() / 1000) : null;
  return {
    title: truncate(item.subject ?? '(untitled event)', EMBED_LIMITS.title),
    url: item.webLink,
    description: startTs ? `Starts <t:${startTs}:F> (<t:${startTs}:R>)` : 'Upcoming event',
    color: MICROSOFT_BLUE,
    fields: item.location?.displayName
      ? [{ name: 'Location', value: truncate(item.location.displayName, EMBED_LIMITS.fieldValue) }]
      : [],
    footer: 'Microsoft 365 Calendar',
  };
}

export const microsoftCalendarProvider: IntegrationProviderDef = {
  id: 'microsoft_calendar',
  name: 'Microsoft 365 Calendar',
  kind: 'oauth',
  requiredEnv: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
  pollIntervalSeconds: 900,
  configSchema: microsoftCalendarConfigSchema,
  async poll(ctx, connection) {
    const accessToken = await getValidAccessToken(ctx, 'microsoft_calendar', connection);
    if (!accessToken) {
      await markConnectionError(
        ctx,
        connection.id,
        'Microsoft 365 Calendar is not authorized (connect again from the dashboard).',
      );
      return;
    }

    const now = new Date();
    const end = new Date(now.getTime() + LOOKAHEAD_HOURS * 60 * 60 * 1000);
    const params = new URLSearchParams({ startDateTime: now.toISOString(), endDateTime: end.toISOString() });

    const res = await fetch(`https://graph.microsoft.com/v1.0/me/calendarview?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC"' },
    });
    if (!res.ok) {
      await markConnectionError(ctx, connection.id, `Microsoft Graph request failed (${res.status}).`);
      return;
    }
    const json = (await res.json()) as GraphEventsResponse;

    for (const item of json.value ?? []) {
      const isNew = await claimAlertOnce(ctx, 'microsoft_calendar', connection.id, item.id);
      if (!isNew) continue;
      await sendConnectionAlert(ctx, connection, eventEmbed(item));
    }

    await markConnectionSynced(ctx, connection.id);
  },
};
