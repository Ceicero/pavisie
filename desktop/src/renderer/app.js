import { SERIES, barList, lineChart, statusBar, statusPill } from './charts.js';
import { clear, h } from './dom.js';
import { formatCount, formatExact, formatRelative, humanize, sumOf } from './format.js';
import { sampleResponse } from './sample-data.js';

const VIEWS = [
  { id: 'overview', label: 'Overview' },
  { id: 'discord', label: 'Discord' },
  { id: 'twitch', label: 'Twitch' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'health', label: 'Health' },
];
const RANGES = [7, 30, 90];
const AUTO_REFRESH_MS = 60_000;
const PAGE_SIZE = 25;

const root = document.getElementById('root');
const state = {
  settings: { apiUrl: '', rangeDays: 30, autoRefresh: true },
  version: '',
  user: null,
  sample: false,
  view: 'overview',
  data: {},
  loading: false,
  updatedAt: null,
  signInError: null,
  // Table state lives here so a refresh keeps the search box and the pages already loaded.
  guilds: { query: '', items: [], nextCursor: null, error: null },
  channels: { query: '', status: '', items: [], nextCursor: null, error: null },
  errors: { source: '', items: [], nextCursor: null, error: null },
};
let refreshTimer = null;

/** One read through the main process — or, in preview mode, the made-up equivalent. */
async function get(path, query) {
  if (state.sample) {
    const data = sampleResponse(path, query);
    return data
      ? { ok: true, data }
      : { ok: false, code: 'not_found', message: 'No sample data for this section.' };
  }
  return window.pavisie.get(path, query);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadTable(key, path, query, { append = false } = {}) {
  const table = state[key];
  const result = await get(path, {
    ...query,
    limit: PAGE_SIZE,
    cursor: append ? table.nextCursor : undefined,
  });
  if (!result.ok) {
    table.error = result;
    if (!append) table.items = [];
    return;
  }
  table.error = null;
  table.items = append ? [...table.items, ...result.data.items] : result.data.items;
  table.nextCursor = result.data.nextCursor ?? null;
}
const loadGuilds = (options) =>
  loadTable('guilds', '/owner/metrics/guilds', { query: state.guilds.query }, options);
const loadChannels = (options) =>
  loadTable(
    'channels',
    '/owner/metrics/twitch/channels',
    { query: state.channels.query, status: state.channels.status },
    options,
  );
const loadErrors = (options) =>
  loadTable('errors', '/owner/metrics/errors', { source: state.errors.source }, options);

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  render();
  const days = state.settings.rangeDays;
  const [overview, growth, usage, twitch, integrations] = await Promise.all([
    get('/owner/metrics/overview'),
    get('/owner/metrics/growth', { days }),
    get('/owner/metrics/usage', { days }),
    get('/owner/metrics/twitch', { days }),
    get('/owner/metrics/integrations'),
    loadGuilds(),
    loadChannels(),
    loadErrors(),
  ]);
  state.data = { overview, growth, usage, twitch, integrations };
  state.loading = false;

  // A dead session shows up as "signed out" on every request: go back to the sign-in screen and say why.
  if (!state.sample && overview.code === 'signed_out') {
    state.user = null;
    state.signInError = overview;
  } else {
    state.updatedAt = new Date();
  }
  render();
}

function scheduleAutoRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = null;
  if (state.settings.autoRefresh && (state.user || state.sample)) {
    refreshTimer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, AUTO_REFRESH_MS);
  }
}

async function saveSettings(patch) {
  if (state.sample && patch.apiUrl === undefined) {
    state.settings = { ...state.settings, ...patch };
    return { ok: true };
  }
  const result = await window.pavisie.saveSettings(patch);
  if (result.ok) state.settings = result.settings;
  return result;
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function tile(label, value, note, { text = false } = {}) {
  return h(
    'div',
    { class: 'tile' },
    h('div', { class: 'tile-label' }, label),
    h(
      'div',
      {
        class: text ? 'tile-value text' : 'tile-value',
        title: typeof value === 'number' ? formatExact(value) : String(value),
      },
      typeof value === 'number' ? formatCount(value) : value,
    ),
    note ? h('div', { class: 'tile-note' }, note) : null,
  );
}

function card(title, body, { figure, sub } = {}) {
  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('h2', {}, title),
      figure !== undefined ? h('span', { class: 'figure' }, figure) : null,
    ),
    sub ? h('p', { class: 'card-sub' }, sub) : null,
    body,
  );
}

function problem(result) {
  return h(
    'div',
    { class: 'notice error', role: 'alert' },
    result?.message ?? 'This section could not be loaded.',
  );
}

/** Renders `build(data)` when the request worked, or the reason it did not, so one failure stays in its box. */
function section(result, build) {
  if (!result) return h('p', { class: 'empty' }, 'Loading…');
  return result.ok ? build(result.data) : problem(result);
}

function dailyCard(title, points, key, { color = SERIES.primary, sub, compact = false } = {}) {
  return card(
    title,
    lineChart({
      dates: points.map((p) => p.date),
      series: [{ name: title, color, values: points.map((p) => p[key]) }],
      height: compact ? 150 : 210,
      compact,
    }),
    { figure: formatCount(sumOf(points, key)), sub: sub ?? `Total over the last ${points.length} days` },
  );
}

function table(columns, rows, emptyText) {
  if (!rows.length) return h('p', { class: 'empty' }, emptyText);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          columns.map((c) => h('th', { class: c.num ? 'num' : null, scope: 'col' }, c.label)),
        ),
      ),
      h(
        'tbody',
        {},
        rows.map((row) =>
          h(
            'tr',
            {},
            columns.map((c) => h('td', { class: c.class ?? (c.num ? 'num' : null) }, c.cell(row))),
          ),
        ),
      ),
    ),
  );
}

function loadMore(key, loader) {
  if (!state[key].nextCursor) return null;
  return h(
    'button',
    {
      class: 'btn more',
      onClick: async (event) => {
        event.target.disabled = true;
        await loader({ append: true });
        render();
      },
    },
    'Load more',
  );
}

let searchTimer = null;
function searchBox(key, placeholder, loader) {
  return h('input', {
    class: 'input',
    type: 'search',
    placeholder,
    'aria-label': placeholder,
    value: state[key].query,
    'data-keep-focus': key,
    onInput: (event) => {
      state[key].query = event.target.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        await loader();
        render();
      }, 300);
    },
  });
}

function select(label, value, options, onChange, attrs = {}) {
  return h(
    'select',
    { class: 'select', 'aria-label': label, onChange: (event) => onChange(event.target.value), ...attrs },
    options.map(([optionValue, text]) =>
      h('option', { value: optionValue, selected: String(optionValue) === String(value) }, text),
    ),
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/** Everything across both platforms that someone should look at, worst first. */
function attentionItems() {
  const items = [];
  const { overview, twitch, integrations } = state.data;
  if (twitch?.ok) {
    const t = twitch.data;
    if (!t.bot.configured)
      items.push([
        'bad',
        'The Twitch chat bot account is not connected, so no Twitch channel can use chat features.',
      ]);
    else if (t.bot.status !== 'connected')
      items.push([
        'bad',
        `The Twitch chat bot account (${t.bot.login}) is ${t.bot.status}${t.bot.lastError ? `: ${t.bot.lastError}` : '.'}`,
      ]);
    if (t.channels.status.error)
      items.push([
        'bad',
        `${formatExact(t.channels.status.error)} Twitch ${t.channels.status.error === 1 ? 'channel is' : 'channels are'} in an error state.`,
      ]);
    if (t.channels.status.pending)
      items.push([
        'warn',
        `${formatExact(t.channels.status.pending)} Twitch ${t.channels.status.pending === 1 ? 'channel has' : 'channels have'} not finished connecting.`,
      ]);
  }
  if (integrations?.ok && integrations.data.totals.status.error) {
    const n = integrations.data.totals.status.error;
    items.push([
      'bad',
      `${formatExact(n)} integration ${n === 1 ? 'connection is' : 'connections are'} failing.`,
    ]);
  }
  if (overview?.ok) {
    const o = overview.data;
    if (o.reports.open)
      items.push([
        'warn',
        `${formatExact(o.reports.open)} developer ${o.reports.open === 1 ? 'report is' : 'reports are'} open.`,
      ]);
    if (o.activity.enforcerPending)
      items.push([
        'warn',
        `${formatExact(o.activity.enforcerPending)} Enforcer ${o.activity.enforcerPending === 1 ? 'flag is' : 'flags are'} waiting for a moderator.`,
      ]);
  }
  if (state.errors.items.length)
    items.push([
      'warn',
      `${state.errors.items.length}${state.errors.nextCursor ? '+' : ''} recent errors are listed under Health.`,
    ]);
  return items;
}

function attentionCount() {
  return attentionItems().filter(([level]) => level === 'bad').length;
}

function viewOverview() {
  const { overview, growth, usage, twitch, integrations } = state.data;
  const days = state.settings.rangeDays;
  const items = attentionItems();
  return [
    h(
      'div',
      { class: 'tiles' },
      overview?.ok
        ? tile(
            'Discord servers',
            overview.data.guilds.active,
            `${formatExact(overview.data.guilds.joined7d)} joined in the last 7 days`,
          )
        : null,
      overview?.ok
        ? tile('Members reached', overview.data.members.totalAcrossGuilds, 'Across servers the bot is in now')
        : null,
      twitch?.ok
        ? tile(
            'Twitch channels',
            twitch.data.channels.total,
            `${formatExact(twitch.data.channels.status.connected)} connected right now`,
          )
        : null,
      integrations?.ok
        ? tile(
            'Integrations',
            integrations.data.totals.total,
            `${formatExact(integrations.data.totals.status.connected)} connected`,
          )
        : null,
      usage?.ok
        ? tile(
            'Messages seen',
            usage.data.totals.messages,
            `Last ${days} days, ${formatExact(usage.data.totals.activeGuilds)} active servers`,
          )
        : null,
      twitch?.ok
        ? tile(
            'Twitch viewers active',
            twitch.data.economy.activeWallets7d,
            'Wallets that changed in the last 7 days',
          )
        : null,
    ),
    overview && !overview.ok ? problem(overview) : null,
    h(
      'div',
      { class: 'grid-2' },
      section(usage, (d) => dailyCard('Discord messages per day', d.points, 'messages')),
      section(growth, (d) =>
        card(
          'Net new Discord servers',
          lineChart({
            dates: d.points.map((p) => p.date),
            series: [
              {
                name: 'Net new servers',
                color: SERIES.primary,
                values: d.points.map((p) => Math.max(0, p.netTotal)),
              },
            ],
          }),
          {
            figure: signed(d.points.at(-1)?.netTotal ?? 0),
            sub: `Joined minus left, running total over the last ${d.points.length} days`,
          },
        ),
      ),
      section(twitch, (d) =>
        card(
          'New Twitch channels',
          lineChart({
            dates: d.points.map((p) => p.date),
            series: [
              { name: 'Channels linked', color: SERIES.primary, values: d.points.map((p) => p.runningTotal) },
            ],
          }),
          {
            figure: formatCount(d.points.at(-1)?.runningTotal ?? 0),
            sub: `Running total of channels linked in the last ${d.points.length} days`,
          },
        ),
      ),
      card(
        'Needs attention',
        items.length
          ? h(
              'ul',
              { class: 'attention' },
              items.map(([level, text]) =>
                h(
                  'li',
                  {},
                  h('span', { class: `mark ${level}`, 'aria-hidden': 'true' }, level === 'bad' ? '!' : '•'),
                  h('span', {}, level === 'bad' ? h('strong', {}, 'Problem: ') : null, text),
                ),
              ),
            )
          : h(
              'ul',
              { class: 'attention' },
              h(
                'li',
                {},
                h('span', { class: 'mark ok', 'aria-hidden': 'true' }, '✓'),
                'Nothing needs attention. Every connection is healthy.',
              ),
            ),
      ),
    ),
  ];
}

function signed(n) {
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${formatExact(Math.abs(n))}`;
}

function viewDiscord() {
  const { overview, growth, usage } = state.data;
  return [
    section(overview, (o) =>
      h(
        'div',
        { class: 'tiles' },
        tile('Active servers', o.guilds.active, `${formatExact(o.guilds.inactive)} have removed the bot`),
        tile('Joined, last 7 days', o.guilds.joined7d),
        tile('Joined, last 30 days', o.guilds.joined30d),
        tile('Left, last 30 days', o.guilds.left30d),
        tile('Members reached', o.members.totalAcrossGuilds),
        tile(
          'Largest server',
          o.members.largestGuild?.name ?? '—',
          o.members.largestGuild
            ? `${formatExact(o.members.largestGuild.memberCount)} members`
            : 'No servers yet',
          { text: true },
        ),
      ),
    ),
    section(growth, (d) =>
      card(
        'Servers joined and left per day',
        lineChart({
          dates: d.points.map((p) => p.date),
          series: [
            { name: 'Joined', color: SERIES.primary, values: d.points.map((p) => p.joined) },
            { name: 'Left', color: SERIES.secondary, values: d.points.map((p) => p.left) },
          ],
        }),
        {
          sub: `${formatExact(sumOf(d.points, 'joined'))} joined and ${formatExact(sumOf(d.points, 'left'))} left over the last ${d.points.length} days`,
        },
      ),
    ),
    h('h2', { class: 'section-title' }, 'Usage across every server'),
    section(usage, (d) =>
      h(
        'div',
        { class: 'grid-3' },
        dailyCard('Messages', d.points, 'messages', { compact: true }),
        dailyCard('Moderation actions', d.points, 'moderationActions', { compact: true }),
        dailyCard('Automod triggers', d.points, 'automodTriggers', { compact: true }),
        dailyCard('Tickets opened', d.points, 'ticketsOpened', { compact: true }),
        dailyCard('Members joined', d.points, 'joins', { compact: true }),
        dailyCard('Members left', d.points, 'leaves', { compact: true }),
      ),
    ),
    h('h2', { class: 'section-title' }, 'Right now'),
    section(overview, (o) =>
      h(
        'div',
        { class: 'tiles' },
        tile('Moderation cases', o.activity.moderationCases7d, 'Last 7 days'),
        tile('Automod events', o.activity.automodEvents7d, 'Last 7 days'),
        tile('Open tickets', o.activity.ticketsOpen),
        tile('Enforcer flags waiting', o.activity.enforcerPending),
      ),
    ),
    card(
      'Servers',
      [
        h('div', { class: 'toolbar' }, searchBox('guilds', 'Search servers by name or ID', loadGuilds)),
        state.guilds.error
          ? problem(state.guilds.error)
          : table(
              [
                { label: 'Server', class: 'name', cell: (g) => g.name },
                { label: 'Status', cell: (g) => statusPill(g.botPresent ? 'connected' : 'disconnected') },
                { label: 'Members', num: true, cell: (g) => formatExact(g.memberCount) },
                { label: 'Plugins on', num: true, cell: (g) => formatExact(g.pluginsEnabled) },
                { label: 'Cases, 30 days', num: true, cell: (g) => formatExact(g.moderationCases30d) },
                { label: 'Open tickets', num: true, cell: (g) => formatExact(g.ticketsOpen) },
                { label: 'Last activity', class: 'dim', cell: (g) => formatRelative(g.lastActivityAt) },
                { label: 'Joined', class: 'dim', cell: (g) => formatRelative(g.joinedAt) },
              ],
              state.guilds.items,
              state.guilds.query ? 'No servers match that search.' : 'The bot is not in any servers yet.',
            ),
        loadMore('guilds', loadGuilds),
      ],
      { sub: 'Newest first. "Connected" means the bot is in the server now.' },
    ),
  ];
}

function viewTwitch() {
  const { twitch } = state.data;
  return [
    section(twitch, (t) => [
      t.bot.configured
        ? null
        : h(
            'div',
            { class: 'notice' },
            h('strong', {}, 'The Twitch chat bot account is not connected. '),
            'Channels can be linked, but chat features stay off until the owner authorizes the bot account.',
          ),
      h(
        'div',
        { class: 'tiles' },
        tile(
          'Channels linked',
          t.channels.total,
          `${formatExact(t.channels.enabled)} switched on by the streamer`,
        ),
        tile(
          'Connected now',
          t.channels.status.connected,
          t.bot.configured ? `Chat bot ${t.bot.login}: ${t.bot.status}` : 'Chat bot not connected',
        ),
        tile('With a Discord server', t.channels.guildLinked),
        tile('Twitch only', t.channels.standalone, 'No Discord server linked'),
        tile('Linked, last 7 days', t.channels.linked7d),
        tile('Linked, last 30 days', t.channels.linked30d),
      ),
      h(
        'div',
        { class: 'grid-2' },
        card('Channel connections', statusBar(t.channels.status), {
          figure: formatExact(t.channels.total),
          sub: 'Every linked Twitch channel, by connection state',
        }),
        card('Stream-live alerts', statusBar(t.alerts.status), {
          figure: formatExact(t.alerts.total),
          sub: 'Discord servers that get a post when a Twitch stream starts',
        }),
        card(
          'What streamers have set up',
          barList([
            { label: 'Chat commands', value: t.features.commands },
            { label: 'Timers', value: t.features.timers },
            { label: 'Channel-point rewards', value: t.features.rewards },
          ]),
          {
            sub: `Switched-on items across all channels. ${formatExact(t.channels.rewardsEnabled)} ${t.channels.rewardsEnabled === 1 ? 'channel has' : 'channels have'} rewards on; ${formatExact(t.channels.bridgeEnabled)} ${t.channels.bridgeEnabled === 1 ? 'uses' : 'use'} the Discord chat bridge.`,
          },
        ),
        card(
          'Channel-point rewards by action',
          barList(
            [
              { label: 'Play a sound', value: t.features.rewardsByAction.sound },
              { label: 'Text to speech', value: t.features.rewardsByAction.tts },
              { label: 'Chat message', value: t.features.rewardsByAction.chat },
              { label: 'Discord message', value: t.features.rewardsByAction.discord },
            ].sort((a, b) => b.value - a.value),
          ),
          { figure: formatExact(t.features.rewards), sub: 'What a redemption triggers' },
        ),
      ),
      h('h2', { class: 'section-title' }, 'Channel currency'),
      h(
        'div',
        { class: 'tiles' },
        tile(
          'Channels with a currency',
          t.economy.enabled,
          `${formatExact(t.economy.economies)} have set one up`,
        ),
        tile('Viewer wallets', t.economy.wallets),
        tile('Active viewers, 7 days', t.economy.activeWallets7d, 'Wallets that changed'),
        tile('Active viewers, 30 days', t.economy.activeWallets30d, 'Wallets that changed'),
        tile('Transactions, 7 days', t.economy.transactions7d),
        tile('Transactions, 30 days', t.economy.transactions30d),
      ),
      h(
        'div',
        { class: 'grid-2' },
        card(
          'Transactions by type, last 30 days',
          barList(
            t.economy.transactionsByType30d.map((row) => ({ label: humanize(row.type), value: row.count })),
            { empty: 'No currency activity in the last 30 days.' },
          ),
        ),
        card(
          'New Twitch channels',
          lineChart({
            dates: t.points.map((p) => p.date),
            series: [
              { name: 'Channels linked', color: SERIES.primary, values: t.points.map((p) => p.runningTotal) },
            ],
          }),
          {
            figure: formatCount(t.points.at(-1)?.runningTotal ?? 0),
            sub: `Running total of channels linked in the last ${t.points.length} days`,
          },
        ),
      ),
    ]),
    card(
      'Channels',
      [
        h(
          'div',
          { class: 'toolbar' },
          searchBox('channels', 'Search channels by name', loadChannels),
          select(
            'Filter by status',
            state.channels.status,
            [
              ['', 'All statuses'],
              ['connected', 'Connected'],
              ['pending', 'Pending'],
              ['error', 'Error'],
              ['disconnected', 'Disconnected'],
            ],
            async (value) => {
              state.channels.status = value;
              await loadChannels();
              render();
            },
          ),
        ),
        state.channels.error
          ? problem(state.channels.error)
          : table(
              [
                { label: 'Channel', class: 'name', cell: (c) => c.broadcasterLogin },
                { label: 'Status', cell: (c) => statusPill(c.status) },
                { label: 'Discord server', cell: (c) => c.guildName ?? 'None' },
                { label: 'Commands', num: true, cell: (c) => formatExact(c.commands) },
                { label: 'Timers', num: true, cell: (c) => formatExact(c.timers) },
                { label: 'Rewards', num: true, cell: (c) => formatExact(c.rewards) },
                { label: 'Bridge', cell: (c) => (c.bridgeEnabled ? 'On' : 'Off') },
                { label: 'Last connected', class: 'dim', cell: (c) => formatRelative(c.lastConnectedAt) },
                { label: 'Linked', class: 'dim', cell: (c) => formatRelative(c.linkedAt) },
                { label: 'Last error', class: 'wrap', cell: (c) => c.lastError ?? '' },
              ],
              state.channels.items,
              state.channels.query || state.channels.status
                ? 'No channels match those filters.'
                : 'No Twitch channels are linked yet.',
            ),
        loadMore('channels', loadChannels),
      ],
      { sub: 'Newest first.' },
    ),
  ];
}

function viewIntegrations() {
  return [
    section(state.data.integrations, (d) => [
      h(
        'div',
        { class: 'tiles' },
        tile(
          'Connections',
          d.totals.total,
          `Across ${formatExact(d.providers.length)} ${d.providers.length === 1 ? 'service' : 'services'}`,
        ),
        tile('Connected', d.totals.status.connected),
        tile('Failing', d.totals.status.error),
        tile('Pending', d.totals.status.pending, 'Started but not finished'),
        tile('Disconnected', d.totals.status.disconnected),
      ),
      h(
        'div',
        { class: 'grid-2' },
        card('All connections', statusBar(d.totals.status), {
          figure: formatExact(d.totals.total),
          sub: 'Every server integration, by connection state',
        }),
        card(
          'Connections by service',
          barList(
            d.providers.map((p) => ({ label: humanize(p.provider, { titleCase: true }), value: p.total })),
            { empty: 'No server has connected an integration yet.' },
          ),
        ),
      ),
      card(
        'By service',
        table(
          [
            { label: 'Service', class: 'name', cell: (p) => humanize(p.provider, { titleCase: true }) },
            { label: 'Total', num: true, cell: (p) => formatExact(p.total) },
            { label: 'Connected', num: true, cell: (p) => formatExact(p.status.connected) },
            { label: 'Failing', num: true, cell: (p) => formatExact(p.status.error) },
            { label: 'Pending', num: true, cell: (p) => formatExact(p.status.pending) },
            { label: 'Disconnected', num: true, cell: (p) => formatExact(p.status.disconnected) },
          ],
          d.providers,
          'No server has connected an integration yet.',
        ),
      ),
    ]),
  ];
}

function viewHealth() {
  const { overview } = state.data;
  return [
    section(overview, (o) =>
      h(
        'div',
        { class: 'tiles' },
        tile('Open developer reports', o.reports.open, `${formatExact(o.reports.handled)} handled so far`),
        tile('Enforcer flags waiting', o.activity.enforcerPending),
        tile('Open tickets', o.activity.ticketsOpen, 'Across every server'),
      ),
    ),
    card(
      'Recent errors',
      [
        h(
          'div',
          { class: 'toolbar' },
          select(
            'Filter by source',
            state.errors.source,
            [
              ['', 'All sources'],
              ['integration', 'Integrations'],
              ['job', 'Scheduled jobs'],
              ['webhook', 'Webhooks'],
              ['data-request', 'Data requests'],
            ],
            async (value) => {
              state.errors.source = value;
              await loadErrors();
              render();
            },
          ),
        ),
        state.errors.error
          ? problem(state.errors.error)
          : table(
              [
                { label: 'When', class: 'dim', cell: (e) => formatRelative(e.occurredAt) },
                { label: 'Source', cell: (e) => humanize(e.source) },
                { label: 'Server', cell: (e) => e.guildName ?? '—' },
                { label: 'What happened', class: 'wrap', cell: (e) => e.message },
              ],
              state.errors.items,
              state.errors.source
                ? 'No errors from that source.'
                : 'No errors recorded. Everything is running cleanly.',
            ),
        loadMore('errors', loadErrors),
      ],
      { sub: 'Newest first, from integrations, scheduled jobs, webhooks, and data requests.' },
    ),
  ];
}

const VIEW_BUILDERS = {
  overview: viewOverview,
  discord: viewDiscord,
  twitch: viewTwitch,
  integrations: viewIntegrations,
  health: viewHealth,
};

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function renderSignIn() {
  const apiInput = h('input', {
    class: 'input',
    id: 'api-url',
    type: 'url',
    value: state.settings.apiUrl,
    spellcheck: false,
  });
  const message = h(
    'div',
    { class: 'notice error', role: 'alert', hidden: !state.signInError },
    state.signInError?.message ?? '',
  );
  const button = h('button', { class: 'btn btn-primary' }, 'Sign in with Discord');

  const fail = (text) => {
    message.textContent = text;
    message.hidden = false;
    button.disabled = false;
  };
  button.addEventListener('click', async () => {
    button.disabled = true;
    message.hidden = true;
    const saved = await saveSettings({ apiUrl: apiInput.value });
    if (!saved.ok) return fail(saved.message);
    const result = await window.pavisie.signIn();
    if (!result.ok)
      return result.code === 'cancelled' ? ((button.disabled = false), undefined) : fail(result.message);
    const app = await window.pavisie.getState();
    if (!app.user) return fail(app.authError?.message ?? 'Sign-in did not complete. Try again.');
    state.user = app.user;
    state.signInError = null;
    scheduleAutoRefresh();
    refresh();
  });

  clear(root).append(
    h(
      'main',
      { class: 'signin' },
      h(
        'div',
        { class: 'signin-card' },
        h('img', { src: 'logo.png', alt: '' }),
        h('h1', {}, 'Pavisie Dev'),
        h(
          'p',
          {},
          'Discord and Twitch connections and usage for the whole Pavisie project. Sign in with the Discord account that owns the bot.',
        ),
        h('div', { class: 'field' }, h('label', { for: 'api-url' }, 'Pavisie API address'), apiInput),
        message,
        button,
        h(
          'button',
          {
            class: 'btn-link',
            onClick: () => {
              state.sample = true;
              state.signInError = null;
              scheduleAutoRefresh();
              refresh();
            },
          },
          'Preview with sample data',
        ),
      ),
    ),
  );
}

function renderShell() {
  // Rebuilding the page must not steal the cursor from a search box mid-typing.
  const active = document.activeElement?.getAttribute?.('data-keep-focus');
  const caret = active ? document.activeElement.selectionStart : null;
  const scrollTop = root.querySelector('.content')?.scrollTop ?? 0;
  const problems = attentionCount();

  const exportButton = h('button', { class: 'btn', disabled: state.loading || !state.updatedAt }, 'Export');
  exportButton.addEventListener('click', async () => {
    const snapshot = {
      exportedAt: new Date().toISOString(),
      sampleData: state.sample,
      apiUrl: state.sample ? null : state.settings.apiUrl,
      rangeDays: state.settings.rangeDays,
      ...Object.fromEntries(
        Object.entries(state.data).map(([key, result]) => [
          key,
          result.ok ? result.data : { error: result.message },
        ]),
      ),
      servers: state.guilds.items,
      twitchChannels: state.channels.items,
      errors: state.errors.items,
    };
    const result = await window.pavisie.exportSnapshot(snapshot);
    if (result.ok) exportButton.textContent = 'Exported';
  });

  const content = h(
    'div',
    { class: state.loading ? 'content loading' : 'content' },
    VIEW_BUILDERS[state.view](),
  );

  clear(root).append(
    h(
      'div',
      { class: 'shell' },
      h(
        'nav',
        { class: 'sidebar', 'aria-label': 'Sections' },
        h('div', { class: 'brand' }, h('img', { src: 'logo.png', alt: '' }), 'Pavisie Dev'),
        VIEWS.map((view) =>
          h(
            'button',
            {
              class: 'nav-btn',
              'aria-current': state.view === view.id ? 'page' : null,
              onClick: () => {
                state.view = view.id;
                render();
                root.querySelector('.content').scrollTop = 0;
              },
            },
            view.label,
            view.id === 'health' && problems
              ? h(
                  'span',
                  { class: 'badge', title: `${problems} ${problems === 1 ? 'problem' : 'problems'}` },
                  problems,
                )
              : null,
          ),
        ),
        h(
          'div',
          { class: 'sidebar-foot' },
          h(
            'div',
            { class: 'who' },
            state.sample
              ? 'Sample data'
              : `Signed in as ${state.user?.globalName ?? state.user?.username ?? ''}`,
          ),
          state.sample
            ? null
            : h(
                'div',
                { class: 'who', title: state.settings.apiUrl },
                state.settings.apiUrl.replace(/^https?:\/\//, ''),
              ),
          h('button', { class: 'btn', onClick: leave }, state.sample ? 'Exit preview' : 'Sign out'),
          h('div', {}, `Version ${state.version}`),
        ),
      ),
      h(
        'div',
        { class: 'main' },
        state.sample
          ? h(
              'div',
              { class: 'banner', role: 'status' },
              'Sample data. These are made-up numbers, not your real stats.',
              h('button', { class: 'btn', onClick: leave }, 'Exit preview'),
            )
          : null,
        h(
          'header',
          { class: 'topbar' },
          h('h1', {}, VIEWS.find((view) => view.id === state.view).label),
          h(
            'span',
            { class: 'updated' },
            state.loading
              ? 'Refreshing…'
              : state.updatedAt
                ? `Updated ${state.updatedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                : '',
          ),
          select(
            'Time range',
            state.settings.rangeDays,
            RANGES.map((days) => [days, `Last ${days} days`]),
            async (value) => {
              await saveSettings({ rangeDays: Number(value) });
              refresh();
            },
          ),
          h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              checked: state.settings.autoRefresh,
              onChange: async (event) => {
                await saveSettings({ autoRefresh: event.target.checked });
                scheduleAutoRefresh();
              },
            }),
            'Refresh every minute',
          ),
          h('button', { class: 'btn', disabled: state.loading, onClick: refresh }, 'Refresh'),
          exportButton,
        ),
        content,
      ),
    ),
  );

  content.scrollTop = scrollTop;
  if (active) {
    const input = root.querySelector(`[data-keep-focus="${active}"]`);
    input?.focus();
    if (caret !== null) input?.setSelectionRange(caret, caret);
  }
}

async function leave() {
  clearInterval(refreshTimer);
  if (!state.sample) await window.pavisie.signOut();
  Object.assign(state, {
    sample: false,
    user: null,
    data: {},
    updatedAt: null,
    signInError: null,
    view: 'overview',
  });
  for (const key of ['guilds', 'channels', 'errors'])
    Object.assign(state[key], { items: [], nextCursor: null, error: null, query: '' });
  render();
}

function render() {
  if (state.user || state.sample) renderShell();
  else renderSignIn();
}

async function start() {
  const app = await window.pavisie.getState();
  state.settings = app.settings;
  state.version = app.version;
  state.user = app.user;
  // "Signed out" on first launch is the normal starting point, not an error worth showing.
  state.signInError = app.authError && app.authError.code !== 'signed_out' ? app.authError : null;
  render();
  if (state.user) {
    scheduleAutoRefresh();
    refresh();
  }
}

start();
