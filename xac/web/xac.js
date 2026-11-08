/* XAC web client - no frameworks, no network calls beyond this computer. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const H = { 'Content-Type': 'application/json', 'X-XAC': '1' };
  const EMPTY_TPL = $('empty').cloneNode(true);
  const state = { convs: [], current: null, activeId: null, busy: false, abort: null, status: null };

  const STARTERS = [
    ['Incident response', 'Walk me through triaging a suspected ransomware infection on a Windows workstation.'],
    ['Hardening', 'Give me a hardened sshd_config for an internet-facing Ubuntu server and explain each setting.'],
    ['Detection', 'Write a Sigma rule to detect suspicious LSASS memory access, and explain false positives.'],
    ['Learning path', 'Build me a 12-week plan to go from IT support to SOC analyst, with a home lab.'],
  ];

  // ------------------------------------------------------------------ api
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, { headers: H, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }
  async function stream(path, body, onEvent, signal) {
    const res = await fetch('/api' + path, { method: 'POST', headers: H, body: JSON.stringify(body || {}), signal });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || res.statusText);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onEvent(JSON.parse(line));
      }
    }
  }

  // ------------------------------------------------------------- markdown
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${esc(codes[+n])}</code>`);
  }
  function md(src) {
    const out = [];
    const lines = src.replace(/\r/g, '').split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = line.match(/^\s*```\s*([\w+#.-]*)/);
      if (fence) {
        const buf = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        const lang = fence[1] || 'text';
        out.push(`<div class="code"><div class="code-head"><span>${esc(lang)}</span><button type="button" data-copy>Copy</button></div><pre><code>${esc(buf.join('\n'))}</code></pre></div>`);
        continue;
      }
      const h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) { const n = Math.min(3, h[1].length); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
        const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = row(line);
        i += 2;
        const body = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
        out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
        continue;
      }
      const li = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)/);
      if (li) {
        const ordered = /\d/.test(li[1]);
        const items = [];
        while (i < lines.length) {
          const m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.*)/);
          if (m) { items.push(m[2]); i++; } else if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; } else break;
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
        continue;
      }
      if (!line.trim()) { i++; continue; }
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])) buf.push(lines[i++]);
      if (!buf.length) buf.push(lines[i++]);
      out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
    return out.join('');
  }

  // ------------------------------------------------------------ rendering
  const gb = (n) => (n == null ? '—' : `${(+n).toFixed(1)} GB`);
  const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`);

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  function renderConvs() {
    const list = $('convList');
    list.textContent = '';
    if (!state.convs.length) {
      const p = document.createElement('div');
      p.className = 'muted';
      p.style.padding = '8px 4px';
      p.textContent = 'No chats yet.';
      list.appendChild(p);
    }
    for (const c of state.convs) {
      const active = c.id === state.activeId;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'conv' + (state.current && c.id === state.current.id ? ' selected' : '') + (active ? ' is-active' : '');
      b.title = active ? 'Active — loaded in XAC\'s memory' : 'Put away — saved to disk, resumes when you talk in it';
      b.innerHTML = `<span class="dot${active ? ' active' : ''}"></span><span class="conv-title"></span><span class="conv-state">${active ? 'active' : 'stored'}</span><span class="conv-del" role="button" aria-label="Delete chat" title="Delete">✕</span>`;
      b.querySelector('.conv-title').textContent = c.title;
      b.addEventListener('click', (e) => {
        if (e.target.classList.contains('conv-del')) return deleteConv(c);
        openConv(c.id);
        $('sidebar').classList.remove('open');
      });
      list.appendChild(b);
    }
  }

  function setMeter(ctx) {
    if (!ctx || !ctx.history_budget) {
      $('ctxText').textContent = '—';
      $('ctxFill').style.width = '0';
      return;
    }
    const pct = Math.round(ctx.fill * 100);
    const cond = ctx.condense_count ? ` · condensed ×${ctx.condense_count}` : '';
    $('ctxText').textContent = `${fmtK(ctx.history_tokens)} / ${fmtK(ctx.history_budget)} tokens (${pct}%)${cond}`;
    $('ctxFill').style.width = `${Math.max(2, pct)}%`;
    $('ctxMeter').title = `This chat has ${gb(ctx.context_gb)} of memory (${ctx.num_ctx.toLocaleString()} tokens). ` +
      'Older messages are auto-condensed into a summary at 70% so the chat can keep going.';
  }

  function msgEl(role) {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.innerHTML = role === 'assistant'
      ? '<div class="avatar"><img src="logo.svg" alt=""></div><div class="bubble"><div class="who">XAC</div><div class="body"></div><div class="meta"></div></div>'
      : '<div class="avatar">YOU</div><div class="bubble"><div class="body"></div></div>';
    $('messages').appendChild(el);
    return el;
  }

  function addReasoning(el, text, live) {
    let d = el.querySelector('details.reasoning');
    if (!d) {
      d = document.createElement('details');
      d.className = 'reasoning';
      d.innerHTML = '<summary>Reasoning</summary><div class="think"></div>';
      el.querySelector('.body').before(d);
    }
    d.classList.toggle('thinking-live', !!live);
    d.querySelector('summary').textContent = live ? 'Thinking…' : 'Reasoning';
    d.querySelector('.think').textContent = text;
    return d;
  }

  function divider(text, red) {
    const d = document.createElement('div');
    d.className = 'divider' + (red ? ' red' : '');
    d.textContent = text;
    $('messages').appendChild(d);
  }

  function addMeta(el, items, withRegen) {
    const meta = el.querySelector('.meta');
    meta.textContent = '';
    for (const it of items.filter(Boolean)) {
      const s = document.createElement('span');
      s.textContent = it;
      meta.appendChild(s);
    }
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => navigator.clipboard.writeText(el.dataset.raw || '').then(() => toast('Copied')));
    meta.appendChild(copy);
    if (withRegen) {
      const r = document.createElement('button');
      r.type = 'button';
      r.textContent = 'Regenerate';
      r.addEventListener('click', () => send('', true));
      meta.appendChild(r);
    }
  }

  function renderMessages(data) {
    const box = $('messages');
    box.textContent = '';
    const msgs = data.messages;
    if (!msgs.length) {
      box.appendChild(emptyState());
      return;
    }
    const upto = data.conversation.summary_upto || 0;
    let shownDivider = false;
    msgs.forEach((m, idx) => {
      if (upto && !shownDivider && m.id > upto) {
        divider('Above: condensed into XAC\'s summary');
        shownDivider = true;
      }
      const el = msgEl(m.role);
      el.dataset.raw = m.content;
      if (m.role === 'assistant') {
        if (m.thinking) addReasoning(el, m.thinking, false);
        el.querySelector('.body').innerHTML = md(m.content);
        addMeta(el, [], idx === msgs.length - 1);
      } else {
        el.querySelector('.body').textContent = m.content;
      }
    });
    box.scrollTop = box.scrollHeight;
  }

  function emptyState() {
    const node = EMPTY_TPL.cloneNode(true);
    node.id = 'empty';
    const s = node.querySelector('.starters');
    s.textContent = '';
    for (const [title, prompt] of STARTERS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'starter';
      b.innerHTML = '<b></b><span></span>';
      b.querySelector('b').textContent = title;
      b.querySelector('span').textContent = prompt;
      b.addEventListener('click', () => { $('input').value = prompt; send(); });
      s.appendChild(b);
    }
    return node;
  }

  // -------------------------------------------------------------- actions
  async function loadConvs() {
    const data = await api('/conversations');
    state.convs = data.conversations;
    state.activeId = data.active_id;
    renderConvs();
  }

  async function openConv(id) {
    const data = await api(`/conversations/${id}`);
    state.current = data.conversation;
    renderMessages(data);
    setMeter(data.context);
    renderConvs();
    $('input').focus();
  }

  async function newConv() {
    if (state.busy) return;
    const c = await api('/conversations', { method: 'POST' });
    await loadConvs();
    await openConv(c.id);
  }

  async function deleteConv(c) {
    if (!confirm(`Delete "${c.title}"? This removes it from disk.`)) return;
    await api(`/conversations/${c.id}`, { method: 'DELETE' });
    if (state.current && state.current.id === c.id) {
      state.current = null;
      $('messages').textContent = '';
      $('messages').appendChild(emptyState());
      setMeter(null);
    }
    loadConvs();
  }

  function setBusy(b) {
    state.busy = b;
    $('sendBtn').disabled = b;
    $('stopBtn').classList.toggle('hidden', !b);
    $('condenseBtn').disabled = b;
    $('parkBtn').disabled = b;
  }

  async function send(textArg, regenerate = false) {
    if (state.busy) return;
    const input = $('input');
    const text = (textArg ?? input.value).trim();
    if (!text && !regenerate) return;
    if (!state.current) {
      const c = await api('/conversations', { method: 'POST' });
      state.current = c;
    }
    const cid = state.current.id;
    const empty = $('messages').querySelector('#empty');
    if (empty) empty.remove();
    if (regenerate) {
      const last = [...$('messages').querySelectorAll('.msg.assistant')].pop();
      if (last) last.remove();
    } else {
      const u = msgEl('user');
      u.querySelector('.body').textContent = text;
      input.value = '';
      autosize();
    }

    const el = msgEl('assistant');
    const body = el.querySelector('.body');
    body.classList.add('cursor');
    let content = '';
    let thinking = '';
    let pending = false;
    const box = $('messages');
    const paint = () => {
      pending = false;
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
      if (thinking) addReasoning(el, thinking, !content);
      body.innerHTML = md(content);
      if (nearBottom) box.scrollTop = box.scrollHeight;
    };
    const schedule = () => { if (!pending) { pending = true; requestAnimationFrame(paint); } };

    setBusy(true);
    state.abort = new AbortController();
    $('statusHint').textContent = 'XAC is thinking…';
    try {
      await stream(`/conversations/${cid}/chat`, { message: text, think: $('thinkToggle').checked, regenerate }, (ev) => {
        switch (ev.type) {
          case 'resumed':
            el.before(Object.assign(document.createElement('div'), { className: 'divider red', textContent: 'Chat resumed from storage' }));
            state.activeId = cid;
            renderConvs();
            break;
          case 'condensing':
            $('statusHint').textContent = 'Condensing older context so the chat can continue…';
            break;
          case 'condensed':
            toast('Older messages condensed into XAC\'s memory');
            setMeter(ev);
            break;
          case 'context':
            state.activeId = cid;
            setMeter(ev);
            break;
          case 'thinking':
            thinking += ev.delta;
            schedule();
            break;
          case 'content':
            content += ev.delta;
            $('statusHint').textContent = 'XAC is answering…';
            schedule();
            break;
          case 'memory_saved':
            content = `Saved to my long-term notes: **${ev.content}**`;
            schedule();
            break;
          case 'error':
            content += `\n\n> ⚠ ${ev.message}`;
            schedule();
            break;
          case 'done':
            el.dataset.raw = content;
            paint();
            addMeta(el, [ev.tokens_per_sec && `${ev.tokens_per_sec} tok/s`, ev.reply_tokens && `${ev.reply_tokens} tokens`], true);
            if (ev.history_budget) setMeter(ev);
            break;
        }
      }, state.abort.signal);
    } catch (e) {
      if (e.name !== 'AbortError') {
        content += `\n\n> ⚠ ${e.message}`;
        paint();
      }
    } finally {
      body.classList.remove('cursor');
      if (thinking) addReasoning(el, thinking, false);
      setBusy(false);
      $('statusHint').textContent = '';
      state.abort = null;
      loadConvs();
      // The title and auto-condense finish in the background; refresh shortly after.
      setTimeout(() => { loadConvs(); refreshMeter(); }, 6000);
    }
  }

  async function refreshMeter() {
    if (!state.current) return;
    try { setMeter((await api(`/conversations/${state.current.id}`)).context); } catch { /* ignore */ }
  }

  // -------------------------------------------------------------- status
  async function loadStatus() {
    const s = await api('/status');
    state.status = s;
    const p = s.plan;
    const mode = { gpu: 'GPU', hybrid: 'GPU+RAM', cpu: 'CPU' }[p.mode];
    $('modelChip').innerHTML = '';
    $('modelChip').append(Object.assign(document.createElement('b'), { textContent: 'XAC' }), ` · ${p.label} · ${mode}`);
    $('modelChip').title = `${p.weights_gb} GB parameters, ${p.context_gb} GB chat memory (${p.num_ctx.toLocaleString()} tokens), ` +
      `${p.num_gpu}/${p.total_layers} layers on GPU`;
    $('thinkToggle').checked = s.settings.think && p.thinking;
    $('thinkToggle').disabled = !p.thinking;
    return s;
  }

  function budgetHTML(s) {
    const p = s.plan;
    const hw = s.hardware;
    const used = p.gpu_use.weights + p.gpu_use.kv_cache + p.gpu_use.compute;
    const total = Math.max(p.gpu_budget_gb, used, 0.01);
    const w = (x) => `${(100 * x / total).toFixed(1)}%`;
    const gpus = hw.gpus.map((g) => `${g.name} (${g.vram_gb.toFixed(1)} GB)`).join(', ') || 'No supported GPU';
    const ram = p.ram_use.weights + p.ram_use.kv_cache + p.ram_use.compute;
    const rows = [
      ['Hardware', `${hw.ram_gb.toFixed(1)} GB RAM · ${hw.cpu_threads} threads`],
      ['GPU', gpus],
      ['Model', `${p.label} [${p.model}]`],
      ['Parameters', `${gb(p.weights_gb)} (floor ${p.floors.weights_gb} GB)`],
      ['Memory per conversation', `${gb(p.context_gb)} = ${p.num_ctx.toLocaleString()} tokens (floor ${p.floors.context_gb} GB)`],
      ['Layers on GPU', `${p.num_gpu} / ${p.total_layers} (${p.mode})`],
      ['VRAM in use', `${used.toFixed(1)} / ${p.gpu_budget_gb.toFixed(1)} GB`],
      ['Shared to system RAM', `${ram.toFixed(1)} / ${p.ram_budget_gb.toFixed(1)} GB`],
      ['Chat memory format', `${p.kv_type}${p.flash_attention ? ' + flash attention' : ''}`],
    ];
    const div = document.createElement('div');
    div.className = 'budget';
    div.innerHTML = `<div class="stack"><div class="seg-w"></div><div class="seg-kv"></div><div class="seg-c"></div></div>
      <div class="legend"><span><i class="seg-w"></i>Parameters</span><span><i class="seg-kv"></i>Chat memory</span><span><i class="seg-c"></i>Compute</span><span><i class="seg-free"></i>Free VRAM</span></div>`;
    for (const [k, v] of rows) {
      const r = document.createElement('div');
      r.className = 'budget-row';
      r.append(Object.assign(document.createElement('span'), { textContent: k }), Object.assign(document.createElement('span'), { textContent: v }));
      div.appendChild(r);
    }
    const why = document.createElement('p');
    why.className = 'muted';
    why.textContent = p.reason;
    div.appendChild(why);
    for (const warn of p.warnings) div.appendChild(Object.assign(document.createElement('div'), { className: 'warn', textContent: warn }));
    for (const note of hw.notes) div.appendChild(Object.assign(document.createElement('div'), { className: 'muted', textContent: note }));
    // Inline style attributes are blocked by XAC's strict CSP; CSSOM assignments are allowed.
    div.querySelectorAll('.stack div').forEach((seg, i) => {
      seg.style.width = w([p.gpu_use.weights, p.gpu_use.kv_cache, p.gpu_use.compute][i]);
    });
    return div;
  }

  async function openSettings() {
    const s = await loadStatus();
    $('budgetView').textContent = '';
    $('budgetView').appendChild(budgetHTML(s));
    const sel = $('sModel');
    sel.length = 1;
    for (const m of s.catalog) sel.add(new Option(`${m.label} — ${m.weights_gb} GB`, m.tag));
    sel.value = s.settings.model || '';
    $('sProfile').value = s.settings.profile;
    $('sMinParams').value = s.settings.min_params_gb;
    $('sMinCtx').value = s.settings.min_context_gb;
    $('sPark').value = s.settings.park_after_min;
    $('sCondense').checked = s.settings.auto_condense;
    $('settingsMsg').textContent = '';
    $('settingsPanel').showModal();
  }

  async function saveSettings(e) {
    e.preventDefault();
    $('settingsMsg').textContent = 'Re-budgeting memory…';
    const r = await api('/settings', {
      method: 'POST',
      body: JSON.stringify({
        profile: $('sProfile').value,
        model: $('sModel').value || null,
        min_params_gb: +$('sMinParams').value,
        min_context_gb: +$('sMinCtx').value,
        park_after_min: +$('sPark').value,
        auto_condense: $('sCondense').checked,
      }),
    });
    const s = await loadStatus();
    $('budgetView').textContent = '';
    $('budgetView').appendChild(budgetHTML(s));
    $('settingsMsg').textContent = `Now using ${r.plan.label} with ${r.plan.context_gb} GB per conversation.`;
    if (r.needs_pull) {
      $('settingsPanel').close();
      await pullModel();
    }
    refreshMeter();
  }

  async function pullModel() {
    $('pullOverlay').classList.remove('hidden');
    try {
      await stream('/pull', {}, (ev) => {
        if (ev.type === 'progress') {
          const pct = ev.total ? (100 * (ev.completed || 0)) / ev.total : 0;
          $('pullText').textContent = `${ev.status || ''}${ev.total ? ` — ${pct.toFixed(1)}%` : ''}`;
          $('pullFill').style.width = `${pct}%`;
        } else if (ev.type === 'error') {
          throw new Error(ev.message);
        }
      });
      toast('Model ready');
    } catch (e) {
      toast(`Download failed: ${e.message}`);
    } finally {
      $('pullOverlay').classList.add('hidden');
      loadStatus();
    }
  }

  async function openNotes() {
    const { memories } = await api('/memories');
    const ul = $('notesList');
    ul.textContent = '';
    if (!memories.length) ul.appendChild(Object.assign(document.createElement('li'), { textContent: 'No notes yet.' }));
    for (const m of memories) {
      const li = document.createElement('li');
      li.append(Object.assign(document.createElement('span'), { textContent: m.content }));
      const del = Object.assign(document.createElement('button'), { type: 'button', textContent: '✕', title: 'Forget' });
      del.addEventListener('click', async () => { await api(`/memories/${m.id}`, { method: 'DELETE' }); openNotes(); });
      li.append(del);
      ul.appendChild(li);
    }
    if (!$('notesPanel').open) $('notesPanel').showModal();
  }

  // ---------------------------------------------------------------- wiring
  function autosize() {
    const t = $('input');
    t.style.height = 'auto';
    t.style.height = `${Math.min(240, t.scrollHeight)}px`;
  }

  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $('input').addEventListener('input', autosize);
  $('stopBtn').addEventListener('click', () => state.abort && state.abort.abort());
  $('newChat').addEventListener('click', newConv);
  $('toggleSidebar').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  $('openSettings').addEventListener('click', openSettings);
  $('saveSettings').addEventListener('click', saveSettings);
  $('openNotes').addEventListener('click', openNotes);
  $('addNote').addEventListener('click', async (e) => {
    e.preventDefault();
    const v = $('noteInput').value.trim();
    if (!v) return;
    await api('/memories', { method: 'POST', body: JSON.stringify({ content: v }) });
    $('noteInput').value = '';
    openNotes();
  });
  $('condenseBtn').addEventListener('click', async () => {
    if (!state.current || state.busy) return;
    $('statusHint').textContent = 'Condensing…';
    setBusy(true);
    try {
      const r = await api(`/conversations/${state.current.id}/condense`, { method: 'POST' });
      toast(r.condensed ? 'Condensed older messages into XAC\'s summary' : 'Not enough history to condense yet');
      await openConv(state.current.id);
    } finally {
      setBusy(false);
      $('statusHint').textContent = '';
    }
  });
  $('parkBtn').addEventListener('click', async () => {
    if (!state.current) return;
    await api(`/conversations/${state.current.id}/park`, { method: 'POST' });
    toast('Chat put away — memory freed. Send a message to resume it.');
    await loadConvs();
    refreshMeter();
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    navigator.clipboard.writeText(b.closest('.code').querySelector('code').textContent).then(() => {
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = 'Copy'; }, 1200);
    });
  });

  (async function init() {
    $('empty').replaceWith(emptyState());
    try {
      await loadStatus();
      await loadConvs();
      if (state.convs.length) await openConv(state.convs[0].id);
    } catch (e) {
      $('modelChip').textContent = 'XAC offline';
      toast(e.message);
    }
    // Keep active/stored badges honest (idle chats get put away by the server).
    setInterval(loadConvs, 30000);
  })();
})();
