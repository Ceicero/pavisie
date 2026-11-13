import { h } from './dom.js';
import { formatCount, formatDay, formatExact, formatShare, niceTicks } from './format.js';

// Series colors: the first two slots of a palette checked for colorblind separation on this dark surface.
// Status colors are a separate, reserved set and always appear with a written label.
export const SERIES = { primary: '#3987e5', secondary: '#d95926' };
export const STATUS = {
  connected: { color: '#0ca30c', label: 'Connected' },
  pending: { color: '#fab219', label: 'Pending' },
  error: { color: '#d03b3b', label: 'Error' },
  disconnected: { color: '#898781', label: 'Disconnected' },
};

/** The one shared tooltip. Values lead, names follow; it only ever repeats numbers that are also in a table. */
let tooltipEl = null;
function tooltip() {
  if (!tooltipEl) {
    tooltipEl = h('div', { class: 'tooltip', role: 'status', hidden: true });
    document.body.append(tooltipEl);
  }
  return tooltipEl;
}
function showTooltip(title, rows, clientX, clientY) {
  const el = tooltip();
  el.replaceChildren(
    h('div', { class: 'tooltip-title' }, title),
    ...rows.map((row) =>
      h(
        'div',
        { class: 'tooltip-row' },
        row.color ? h('span', { class: 'key-line', style: { background: row.color } }) : null,
        h('strong', {}, row.value),
        h('span', {}, row.name),
      ),
    ),
  );
  el.hidden = false;
  const box = el.getBoundingClientRect();
  const left = clientX + 14 + box.width > window.innerWidth ? clientX - 14 - box.width : clientX + 14;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, Math.min(clientY + 14, window.innerHeight - box.height - 8))}px`;
}
function hideTooltip() {
  if (tooltipEl) tooltipEl.hidden = true;
}

function legend(series) {
  return h(
    'div',
    { class: 'legend' },
    series.map((s) =>
      h(
        'span',
        { class: 'legend-item' },
        h('span', { class: 'key-line', style: { background: s.color } }),
        s.name,
      ),
    ),
  );
}

/**
 * A daily line chart: one y-axis from zero, 2px lines, a crosshair that snaps to the nearest day, and a tooltip
 * that lists every series for that day. Two or more series get a legend; one series is named by its card title.
 */
export function lineChart({ dates, series, height = 200, compact = false }) {
  // Drawn at the card's real pixel width and redrawn when that changes, so text and line weights stay the
  // same size in a narrow card and a full-width one.
  const holder = h('div', { class: 'chart-plot', style: { height: `${height}px` } });
  let drawnWidth = 0;
  const draw = (width) => {
    if (width < 120 || Math.abs(width - drawnWidth) < 2) return;
    drawnWidth = width;
    hideTooltip();
    holder.replaceChildren(drawLineChart({ dates, series, height, compact, width }));
  };
  new ResizeObserver((entries) => draw(Math.floor(entries[0].contentRect.width))).observe(holder);
  return h('div', { class: 'chart' }, series.length > 1 ? legend(series) : null, holder);
}

function drawLineChart({ dates, series, height, compact, width }) {
  const pad = { top: 12, right: 14, bottom: 24, left: compact ? 34 : 44 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const count = dates.length;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const ticks = niceTicks(max, compact ? 2 : 4);
  const top = ticks[ticks.length - 1];
  const x = (i) => pad.left + (count <= 1 ? plotW / 2 : (i / (count - 1)) * plotW);
  const y = (v) => pad.top + plotH - (v / top) * plotH;

  const svg = h('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'chart-svg', role: 'img' });
  svg.setAttribute(
    'aria-label',
    `${series.map((s) => s.name).join(' and ')} per day, ${formatDay(dates[0])} to ${formatDay(dates[count - 1])}`,
  );

  for (const tick of ticks) {
    svg.append(
      h('line', {
        x1: pad.left,
        x2: width - pad.right,
        y1: y(tick),
        y2: y(tick),
        class: tick === 0 ? 'axis-base' : 'grid',
      }),
      h('text', { x: pad.left - 8, y: y(tick) + 4, class: 'tick', 'text-anchor': 'end' }, formatCount(tick)),
    );
  }
  const labelIndexes = count <= 2 ? [...Array(count).keys()] : [0, Math.floor((count - 1) / 2), count - 1];
  for (const i of labelIndexes) {
    const anchor = i === 0 ? 'start' : i === count - 1 ? 'end' : 'middle';
    svg.append(
      h('text', { x: x(i), y: height - 6, class: 'tick', 'text-anchor': anchor }, formatDay(dates[i])),
    );
  }

  for (const s of series) {
    const d = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    if (series.length === 1 && count > 1) {
      const base = y(0).toFixed(1);
      svg.append(
        h('path', {
          d: `${d} L${x(count - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z`,
          fill: s.color,
          opacity: 0.1,
        }),
      );
    }
    svg.append(
      h('path', {
        d,
        fill: 'none',
        stroke: s.color,
        'stroke-width': 2,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
      }),
    );
    if (count === 1)
      svg.append(h('circle', { cx: x(0), cy: y(s.values[0]), r: 4, fill: s.color, class: 'dot' }));
  }

  // Hover layer: the pointer only has to be nearest to a day, never on the 2px line itself.
  const cross = h('line', { y1: pad.top, y2: pad.top + plotH, class: 'crosshair', visibility: 'hidden' });
  const dots = series.map((s) => h('circle', { r: 4, fill: s.color, class: 'dot', visibility: 'hidden' }));
  const hit = h('rect', {
    x: pad.left,
    y: pad.top,
    width: plotW,
    height: plotH,
    fill: 'transparent',
    tabindex: 0,
    class: 'hit',
  });
  svg.append(cross, ...dots, hit);

  let focusIndex = count - 1;
  const point = (i, clientX, clientY) => {
    focusIndex = i;
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.setAttribute('visibility', 'visible');
    dots.forEach((dot, n) => {
      dot.setAttribute('cx', x(i));
      dot.setAttribute('cy', y(series[n].values[i]));
      dot.setAttribute('visibility', 'visible');
    });
    showTooltip(
      formatDay(dates[i]),
      series.map((s) => ({ color: s.color, value: formatExact(s.values[i]), name: s.name })),
      clientX,
      clientY,
    );
  };
  const leave = () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((dot) => dot.setAttribute('visibility', 'hidden'));
    hideTooltip();
  };
  const atFocus = () => {
    const box = svg.getBoundingClientRect();
    point(focusIndex, box.left + (x(focusIndex) / width) * box.width, box.top + box.height / 3);
  };
  hit.addEventListener('pointermove', (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const i = count <= 1 ? 0 : Math.round(((px - pad.left) / plotW) * (count - 1));
    point(Math.max(0, Math.min(count - 1, i)), event.clientX, event.clientY);
  });
  hit.addEventListener('pointerleave', leave);
  hit.addEventListener('focus', atFocus);
  hit.addEventListener('blur', leave);
  hit.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    focusIndex = Math.max(0, Math.min(count - 1, focusIndex + (event.key === 'ArrowLeft' ? -1 : 1)));
    atFocus();
  });

  return svg;
}

/** Horizontal bars for a short ranked list: name on the left, a thin bar, the exact value at its tip. */
export function barList(rows, { color = SERIES.primary, empty = 'Nothing to show yet.' } = {}) {
  if (!rows.length) return h('p', { class: 'empty' }, empty);
  const max = Math.max(1, ...rows.map((row) => row.value));
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return h(
    'div',
    { class: 'bar-list' },
    rows.map((row) => {
      const bar = h('div', {
        class: 'bar',
        tabIndex: 0,
        style: { width: `${Math.max(row.value > 0 ? 1 : 0, (row.value / max) * 100)}%`, background: color },
      });
      const show = (event) => {
        const box = bar.getBoundingClientRect();
        showTooltip(
          row.label,
          [{ color, value: formatExact(row.value), name: `${formatShare(row.value, total)} of total` }],
          event.clientX ?? box.right,
          event.clientY ?? box.top,
        );
      };
      bar.addEventListener('pointermove', show);
      bar.addEventListener('pointerleave', hideTooltip);
      bar.addEventListener('focus', show);
      bar.addEventListener('blur', hideTooltip);
      return h(
        'div',
        { class: 'bar-row' },
        h('span', { class: 'bar-label' }, row.label),
        h('div', { class: 'bar-track' }, bar),
        h('span', { class: 'bar-value' }, formatExact(row.value)),
      );
    }),
  );
}

/**
 * One whole split by connection status: a thin segmented bar plus a legend that spells out every status and its
 * count, so the state never depends on telling the colors apart.
 */
export function statusBar(counts) {
  const order = ['connected', 'pending', 'error', 'disconnected'];
  const total = order.reduce((sum, key) => sum + (counts?.[key] ?? 0), 0);
  const summary = order.map((key) => `${counts?.[key] ?? 0} ${STATUS[key].label.toLowerCase()}`).join(', ');
  return h(
    'div',
    { class: 'status-bar' },
    h(
      'div',
      { class: 'segments', role: 'img', 'aria-label': `${total} total: ${summary}` },
      total === 0
        ? h('div', { class: 'segment empty-segment', style: { flexGrow: 1 } })
        : order
            .filter((key) => (counts?.[key] ?? 0) > 0)
            .map((key) =>
              h('div', { class: 'segment', style: { flexGrow: counts[key], background: STATUS[key].color } }),
            ),
    ),
    h(
      'div',
      { class: 'legend' },
      order.map((key) =>
        h(
          'span',
          { class: 'legend-item' },
          h('span', { class: 'key-dot', style: { background: STATUS[key].color } }),
          h('strong', {}, formatExact(counts?.[key] ?? 0)),
          STATUS[key].label,
        ),
      ),
    ),
  );
}

/** A status word with its reserved color dot — the word carries the meaning, the dot is a quick visual cue. */
export function statusPill(status) {
  const known = STATUS[status] ?? { color: '#898781', label: '—' };
  return h(
    'span',
    { class: 'pill' },
    h('span', { class: 'key-dot', style: { background: known.color } }),
    known.label,
  );
}
