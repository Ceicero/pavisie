// Made-up numbers for "Preview with sample data". They let you see every screen before signing in.
// Nothing here comes from a real server, and the app labels the whole window while this is showing.

/** Small repeatable pseudo-random generator, so the preview looks the same every time. */
function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function lastDays(days) {
  const today = new Date();
  const start =
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - (days - 1) * 86_400_000;
  return Array.from({ length: days }, (_, i) => new Date(start + i * 86_400_000).toISOString().slice(0, 10));
}

const hoursAgo = (n) => new Date(Date.now() - n * 3_600_000).toISOString();

const GUILDS = [
  ['Ember Lounge', 4210, 9, 14, 3],
  ['Night Shift Gaming', 2870, 7, 6, 1],
  ['The Fog Archive', 1955, 11, 21, 5],
  ['Pixel Harbor', 1320, 6, 2, 0],
  ['Latchkey Collective', 890, 8, 4, 2],
  ['Quiet Corner', 412, 5, 0, 0],
  ['Sundial Studio', 233, 4, 1, 0],
  ['Old Mill Tavern', 96, 3, 0, 0],
];

const CHANNELS = [
  ['emberlive', 'connected', 'Ember Lounge', 12, 4, 6],
  ['nightshift_tv', 'connected', 'Night Shift Gaming', 8, 3, 2],
  ['fogwalker', 'connected', 'The Fog Archive', 15, 5, 9],
  ['pixelharbor', 'error', 'Pixel Harbor', 5, 1, 0],
  ['solo_streams', 'connected', null, 6, 2, 3],
  ['quietcornerfm', 'pending', null, 0, 0, 0],
  ['sundialcraft', 'connected', 'Sundial Studio', 3, 1, 1],
];

export function sampleResponse(path, query = {}) {
  const days = Math.min(365, Math.max(1, Number(query.days) || 30));
  const dates = lastDays(days);
  const rand = seeded(42 + days);

  switch (path) {
    case '/owner/metrics/overview':
      return {
        guilds: { total: 71, active: 64, inactive: 7, joined7d: 5, joined30d: 18, left30d: 4 },
        members: {
          totalAcrossGuilds: 38_420,
          largestGuild: { id: '1', name: 'Ember Lounge', memberCount: 4210 },
        },
        reports: { open: 3, handled: 22, total: 25 },
        activity: { moderationCases7d: 46, ticketsOpen: 12, automodEvents7d: 318, enforcerPending: 4 },
      };
    case '/owner/metrics/growth': {
      let netTotal = 0;
      return {
        points: dates.map((date) => {
          const joined = rand() < 0.38 ? (rand() < 0.2 ? 2 : 1) : 0;
          const left = rand() < 0.1 ? 1 : 0;
          netTotal += joined - left;
          return { date, joined, left, netTotal };
        }),
      };
    }
    case '/owner/metrics/usage': {
      const points = dates.map((date, i) => {
        const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay()) ? 1.35 : 1;
        const trend = 1 + (i / Math.max(1, days - 1)) * 0.25;
        return {
          date,
          messages: Math.round((5200 + rand() * 1800) * weekend * trend),
          moderationActions: Math.round(4 + rand() * 7),
          automodTriggers: Math.round(30 + rand() * 35),
          ticketsOpened: Math.round(rand() * 5),
          joins: Math.round(40 + rand() * 45),
          leaves: Math.round(18 + rand() * 20),
        };
      });
      const totals = {
        messages: 0,
        moderationActions: 0,
        automodTriggers: 0,
        ticketsOpened: 0,
        joins: 0,
        leaves: 0,
        activeGuilds: 58,
      };
      for (const point of points)
        for (const key of Object.keys(point)) if (key !== 'date') totals[key] += point[key];
      return { points, totals };
    }
    case '/owner/metrics/guilds':
      return {
        items: GUILDS.filter(
          ([name]) => !query.query || name.toLowerCase().includes(String(query.query).toLowerCase()),
        ).map(([name, memberCount, pluginsEnabled, moderationCases30d, ticketsOpen], i) => ({
          id: String(700000000000000000 + i),
          name,
          iconUrl: null,
          memberCount,
          ownerId: '0',
          botPresent: i !== 7,
          joinedAt: hoursAgo(24 * (3 + i * 11)),
          leftAt: i === 7 ? hoursAgo(50) : null,
          pluginsEnabled,
          moderationCases30d,
          ticketsOpen,
          lastActivityAt: hoursAgo(1 + i * 7),
        })),
        nextCursor: null,
      };
    case '/owner/metrics/twitch': {
      let runningTotal = 0;
      return {
        bot: { configured: true, login: 'pavisiebot', status: 'connected', lastError: null },
        channels: {
          total: 23,
          enabled: 21,
          status: { connected: 18, disconnected: 2, error: 1, pending: 2 },
          guildLinked: 15,
          standalone: 8,
          linked7d: 3,
          linked30d: 9,
          rewardsEnabled: 11,
          bridgeEnabled: 7,
        },
        features: {
          commands: 164,
          timers: 41,
          rewards: 58,
          rewardsByAction: { sound: 27, tts: 9, chat: 16, discord: 6 },
        },
        economy: {
          economies: 14,
          enabled: 12,
          wallets: 3_912,
          activeWallets7d: 640,
          activeWallets30d: 1_480,
          transactions7d: 21_300,
          transactions30d: 84_750,
          transactionsByType30d: [
            { type: 'twitch_chat_earn', count: 71_200 },
            { type: 'daily', count: 9_840 },
            { type: 'give', count: 3_150 },
            { type: 'admin_add', count: 410 },
            { type: 'admin_remove', count: 150 },
          ],
        },
        alerts: { total: 31, status: { connected: 27, disconnected: 1, error: 2, pending: 1 } },
        points: dates.map((date) => {
          const linked = rand() < 0.28 ? 1 : 0;
          runningTotal += linked;
          return { date, linked, runningTotal };
        }),
      };
    }
    case '/owner/metrics/twitch/channels':
      return {
        items: CHANNELS.filter(
          ([login, status]) =>
            (!query.query || login.includes(String(query.query).toLowerCase())) &&
            (!query.status || status === query.status),
        ).map(([broadcasterLogin, status, guildName, commands, timers, rewards], i) => ({
          id: `sample-${i}`,
          broadcasterLogin,
          enabled: status !== 'pending',
          status,
          guildId: guildName ? String(700000000000000000 + i) : null,
          guildName,
          commands,
          timers,
          rewards,
          rewardsEnabled: rewards > 0,
          bridgeEnabled: Boolean(guildName) && i % 2 === 0,
          lastConnectedAt: status === 'pending' ? null : hoursAgo(2 + i * 5),
          lastError:
            status === 'error'
              ? 'Twitch rejected the chat connection: the channel removed the bot authorization.'
              : null,
          linkedAt: hoursAgo(24 * (2 + i * 9)),
        })),
        nextCursor: null,
      };
    case '/owner/metrics/integrations':
      return {
        providers: [
          { provider: 'TWITCH', total: 31, status: { connected: 27, disconnected: 1, error: 2, pending: 1 } },
          {
            provider: 'YOUTUBE',
            total: 19,
            status: { connected: 18, disconnected: 0, error: 1, pending: 0 },
          },
          { provider: 'REDDIT', total: 8, status: { connected: 8, disconnected: 0, error: 0, pending: 0 } },
          { provider: 'STEAM', total: 6, status: { connected: 5, disconnected: 1, error: 0, pending: 0 } },
          {
            provider: 'GENERIC_WEBHOOK',
            total: 5,
            status: { connected: 5, disconnected: 0, error: 0, pending: 0 },
          },
          {
            provider: 'GOOGLE_CALENDAR',
            total: 3,
            status: { connected: 2, disconnected: 0, error: 0, pending: 1 },
          },
        ],
        totals: { total: 72, status: { connected: 65, disconnected: 2, error: 3, pending: 2 } },
      };
    case '/owner/metrics/errors':
      return {
        items: [
          {
            id: 'e1',
            source: 'integration',
            guildId: '4',
            guildName: 'Pixel Harbor',
            message: 'Twitch token refresh failed: invalid refresh token.',
            occurredAt: hoursAgo(3),
            context: { provider: 'TWITCH' },
          },
          {
            id: 'e2',
            source: 'webhook',
            guildId: '2',
            guildName: 'Night Shift Gaming',
            message: 'Delivery failed: the receiving server answered HTTP 502.',
            occurredAt: hoursAgo(9),
            context: { direction: 'OUTBOUND' },
          },
          {
            id: 'e3',
            source: 'job',
            guildId: '3',
            guildName: 'The Fog Archive',
            message: 'Giveaway announcement could not be posted: missing Send Messages permission.',
            occurredAt: hoursAgo(27),
            context: { jobType: 'giveaway.end' },
          },
          {
            id: 'e4',
            source: 'integration',
            guildId: '1',
            guildName: 'Ember Lounge',
            message: 'YouTube feed returned 404 for the configured channel.',
            occurredAt: hoursAgo(52),
            context: { provider: 'YOUTUBE' },
          },
        ].filter((row) => !query.source || row.source === query.source),
        nextCursor: null,
      };
    default:
      return null;
  }
}
