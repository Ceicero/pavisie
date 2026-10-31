// CareerCrumbs UI. Renders views as HTML strings, handles events by delegation.
(function () {
  "use strict";
  const C = window.CC;
  const $ = (s, el) => (el || document).querySelector(s);

  // ---------- state ----------
  let ws = C.emptyWorkspace();
  let mode = "loading"; // loading | example | cloud | local
  let syncState = "idle"; // idle | saving | saved | error
  let route = "home";
  const ui = { winQ: "", winComp: "", jobFilter: "All", projFilter: "Open", draftKind: "", sheetOpen: false, pendingRender: false };
  let db = null;
  let sample = null;
  let downloads = null;

  // ---------- icons (stroke paths, 24px grid) ----------
  const P = {
    home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
    wins: "M6 3h12v5a6 6 0 0 1-12 0zM6 5H3v2a4 4 0 0 0 4 4M18 5h3v2a4 4 0 0 1-4 4M12 14v4M8 21h8M9 18h6",
    metrics: "M3 3v18h18M7 15l4-4 3 3 6-7",
    path: "M4 20h4v-6H4zM10 20h4V9h-4zM16 20h4V4h-4z",
    more: "M4 6h16M4 12h16M4 18h16",
    projects: "M3 7h18v13H3zM8 7V4h8v3M3 12h18",
    team: "M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 20v-2a4 4 0 0 0-3-3.9M16 2.1a4 4 0 0 1 0 7.8",
    people: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
    jobs: "M20 7H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1zM16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2",
    drafts: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5",
    review: "M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 15l2 2 4-4",
    backup: "M12 3v12M7 10l5 5 5-5M4 21h16",
    plus: "M12 5v14M5 12h14",
    chev: "M9 6l6 6-6 6",
    close: "M6 6l12 12M18 6 6 18",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6",
    edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
    shift: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
    solve: "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z",
    learn: "M2 7l10-4 10 4-10 4zM6 9v5c0 2 3 3.5 6 3.5s6-1.5 6-3.5V9M22 7v6",
    interview: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM8 9h8M8 13h5",
    tools: "M4 3h16v18H4zM8 7h8M8 11h2M14 11h2M8 15h2M14 15h2M8 19h2M14 19h2",
    insights: "M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4",
    coach: "M12 3c4.97 0 9 3.58 9 8s-4.03 8-9 8c-1.2 0-2.35-.2-3.4-.58L3 20l1.6-4.2A7.6 7.6 0 0 1 3 11c0-4.42 4.03-8 9-8zM8.5 11h.01M12 11h.01M15.5 11h.01",
    search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.35-4.35",
    calendar: "M8 2v4M16 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
    undo: "M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8",
    schedule: "M3 4h18v17H3zM3 9h18M8 2v4M16 2v4M8 13h2M14 13h2M8 17h2",
    feedback: "M7 8h10M7 12h6M21 12a9 9 0 0 1-13.4 7.9L3 21l1.1-4.6A9 9 0 1 1 21 12z",
  };
  const icon = (n) => n === "coach" ? ruhv("ruhv-icon") : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + P[n] + '"/></svg>';
  // Ruhv, the CareerCrumbs mouse. Solid shape in currentColor; eye and smile are cut-outs.
  const RUHV_PATHS =
    '<ellipse cx="176" cy="152" rx="17" ry="22" transform="rotate(-14 176 152)"/><circle cx="219" cy="159" r="15"/><circle cx="272" cy="197" r="6"/>' +
    '<path fill-rule="evenodd" d="M150 287 C148 246 152 206 166 182 C172 170 186 164 204 166 C222 168 240 174 254 184 L268 193 L271 202 C259 206 248 213 240 221 C230 232 231 250 252 285 C222 293 182 293 150 287 Z M226 187 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 Z M233 206 Q242 217 252 207 Q242 213 233 206 Z"/>';
  const ruhv = (cls, label) => '<svg class="' + (cls || "ruhv") + '" viewBox="140 124 144 172" fill="currentColor"' + (label ? ' role="img" aria-label="' + label + '"' : ' aria-hidden="true"') + ">" + RUHV_PATHS + "</svg>";
  const MARK = ruhv("brand-mark");

  const NAV = [
    ["home", "Home", "Track"],
    ["wins", "Wins", "Track"],
    ["metrics", "Numbers", "Track"],
    ["path", "Promotion", "Track"],
    ["shift", "Shift log", "Track"],
    ["team", "Team", "Lead"],
    ["schedule", "Schedule", "Lead"],
    ["projects", "Projects", "Lead"],
    ["solve", "Problem solving", "Lead"],
    ["tools", "Labor & impact", "Lead"],
    ["people", "Visibility", "Grow"],
    ["feedback", "Feedback & 1:1", "Grow"],
    ["learn", "Learning", "Grow"],
    ["interview", "Interview prep", "Grow"],
    ["coach", "Ask Ruhv", "Grow"],
    ["jobs", "Jobs", "Grow"],
    ["drafts", "Drafts", "Grow"],
    ["insights", "Insights", "Look back"],
    ["review", "Weekly review", "Look back"],
    ["backup", "Profile & data", "Look back"],
  ];
  const GROUP_LABEL = { Track: "Track", Lead: "Lead the floor", Grow: "Grow & get the job", "Look back": "Look back" };
  const TABS = ["home", "wins", "metrics", "path"];

  // ---------- utils ----------
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const t0 = () => C.today();
  const byId = (arr, id) => arr.find((x) => x.id === id);
  const sortDesc = (arr, k) => arr.slice().sort((a, b) => (String(a[k] || "") < String(b[k] || "") ? 1 : -1));
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const greeting = () => {
    const h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  };
  const fieldText = (name, label, val, o) => {
    o = o || {};
    const tag = o.area
      ? '<textarea class="textarea" id="f-' + name + '" name="' + name + '" rows="' + (o.rows || 3) + '"' + (o.req ? " required" : "") + ' placeholder="' + esc(o.ph || "") + '">' + esc(val) + "</textarea>"
      : '<input class="input" id="f-' + name + '" name="' + name + '" type="' + (o.type || "text") + '" value="' + esc(val) + '"' + (o.req ? " required" : "") + (o.step ? ' step="' + o.step + '"' : "") + ' placeholder="' + esc(o.ph || "") + '"' + (o.mode ? ' inputmode="' + o.mode + '"' : "") + ">";
    return '<label class="field" for="f-' + name + '"><span>' + esc(label) + "</span>" + tag + (o.hint ? "<small>" + esc(o.hint) + "</small>" : "") + "</label>";
  };
  const fieldSelect = (name, label, val, opts) =>
    '<label class="field" for="f-' + name + '"><span>' + esc(label) + '</span><select class="select" id="f-' + name + '" name="' + name + '">' +
    opts.map((o) => {
      const [v, l] = Array.isArray(o) ? o : [o, o];
      return '<option value="' + esc(v) + '"' + (String(v) === String(val) ? " selected" : "") + ">" + esc(l) + "</option>";
    }).join("") + "</select></label>";

  // ---------- persistence ----------
  // One db document per area keeps every write small and well under the 256 KiB cap.
  const MODULES = {
    profile: ["profile"],
    wins: ["wins", "winSeq"],
    kpis: ["kpis"],
    path: ["competencies", "plan"],
    projects: ["projects"],
    team: ["team", "stations"],
    people: ["people"],
    jobs: ["jobs"],
    drafts: ["drafts"],
    reviews: ["reviews"],
    shifts: ["shifts"],
    problems: ["problems"],
    learning: ["learning"],
    interview: ["interview"],
    tools: ["toolInputs"],
    coach: ["coach"],
    feedback: ["feedback"],
    schedule: ["schedule"],
    priorities: ["priorities"],
  };
  const KEY_TO_MOD = {};
  for (const [m, keys] of Object.entries(MODULES)) for (const k of keys) KEY_TO_MOD[k] = m;
  const LS_KEY = "careercrumbs:ws";
  const dirty = new Set();
  let flushTimer = null;
  let flushing = false;
  let warnedExample = false;

  function save(...keys) {
    if (mode === "example") {
      if (!warnedExample) {
        warnedExample = true;
        toast("Example data isn't saved. Start your workspace to keep changes.", "Start", () => startWorkspace(false));
      }
      render();
      return;
    }
    for (const k of keys) dirty.add(KEY_TO_MOD[k] || k);
    setSync("saving");
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 500);
    render();
  }
  // Same as save() but leaves the screen alone (live calculators, streaming chat).
  function persist(...keys) {
    if (mode === "example") return;
    for (const k of keys) dirty.add(KEY_TO_MOD[k] || k);
    setSync("saving");
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 500);
  }
  async function flush() {
    if (flushing) {
      flushTimer = setTimeout(flush, 300);
      return;
    }
    flushing = true;
    try {
      if (mode === "cloud" && db) {
        while (dirty.size) {
          const m = dirty.values().next().value;
          dirty.delete(m);
          const body = {};
          for (const k of MODULES[m]) body[k] = ws[k];
          body.savedAt = new Date().toISOString();
          await db.doc("ws/" + m).set(body);
        }
      } else {
        dirty.clear();
        try {
          localStorage.setItem(LS_KEY, JSON.stringify(ws));
        } catch (e) {
          throw { code: "local" };
        }
      }
      setSync("saved");
    } catch (e) {
      setSync("error");
      const msg = e && e.code === "quota_exceeded" ? "Storage is full. Delete old drafts or export a backup." : e && e.code === "local" ? "This browser won't save. Export a backup to keep your work." : "Couldn't save. Your changes are kept on screen; try again shortly.";
      toast(msg);
      for (const m of Object.keys(MODULES)) dirty.add(m);
    } finally {
      flushing = false;
    }
  }
  async function saveAllNow() {
    for (const m of Object.keys(MODULES)) dirty.add(m);
    setSync("saving");
    await flush();
  }
  function setSync(s) {
    syncState = s;
    document.querySelectorAll(".sync").forEach((el) => {
      el.dataset.s = mode === "example" ? "example" : s;
      el.innerHTML = '<i></i><span class="sync-t">' + esc(syncLabel()) + "</span>";
      el.title = syncLabel();
    });
  }
  function syncLabel() {
    if (mode === "example") return "Examples · not saved";
    if (mode === "loading") return "Loading";
    const where = mode === "cloud" ? "Saved to your account" : "Saved on this device";
    return syncState === "saving" ? "Saving…" : syncState === "error" ? "Not saved" : where;
  }

  async function boot() {
    applyTheme();
    window.addEventListener("hashchange", onHash);
    onHash(true);
    render();
    const claude = window.claude;
    if (claude && claude.use) {
      const [d, s, dl] = await Promise.all([claude.use("db").catch(() => null), claude.use("sample").catch(() => null), claude.use("downloads").catch(() => null)]);
      db = d;
      sample = s;
      downloads = dl;
    }
    if (db) {
      try {
        const snap = await db.collection("ws").get();
        if (snap.empty) {
          ws = C.normalize(C.exampleWorkspace());
          mode = "example";
        } else {
          ws = C.normalize(assemble(snap.docs));
          mode = "cloud";
        }
        listen();
      } catch (e) {
        db = null;
      }
    }
    if (!db) {
      let local = null;
      try {
        local = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      } catch (e) {}
      if (local) {
        ws = C.normalize(local);
        mode = "local";
      } else {
        ws = C.normalize(C.exampleWorkspace());
        mode = "example";
      }
    }
    setSync("saved");
    render();
  }
  function assemble(docs) {
    const out = {};
    for (const d of docs) {
      const body = d.data() || {};
      for (const k of MODULES[d.id] || []) if (k in body) out[k] = body[k];
    }
    return out;
  }
  // Live updates from the same account on another device.
  function listen() {
    db.collection("ws").onSnapshot(
      (snap) => {
        if (mode !== "cloud" || snap.metadata.hasPendingWrites) return;
        let changed = false;
        for (const ch of snap.docChanges()) {
          if (ch.type === "removed" || dirty.has(ch.doc.id) || !MODULES[ch.doc.id]) continue;
          const body = ch.doc.data() || {};
          for (const k of MODULES[ch.doc.id]) {
            if (k in body && JSON.stringify(body[k]) !== JSON.stringify(ws[k])) {
              ws[k] = body[k];
              changed = true;
            }
          }
        }
        if (changed) {
          ws = C.normalize(ws);
          if (ui.sheetOpen) ui.pendingRender = true;
          else render();
        }
      },
      () => {}
    );
  }
  async function startWorkspace(keepExamples) {
    const prev = ws;
    ws = keepExamples ? C.normalize(prev) : C.emptyWorkspace();
    if (keepExamples) ws.profile.site = "";
    mode = db ? "cloud" : "local";
    warnedExample = false;
    closeSheet();
    render();
    await saveAllNow();
    toast(keepExamples ? "Workspace started from the examples. Rename or delete them anytime." : "Your workspace is ready. Start by filling in your profile.");
    if (!keepExamples) {
      if (A.onboard) A.onboard();
      else go("backup");
    }
  }

  // ---------- routing ----------
  function onHash(initial) {
    const h = (location.hash || "").replace(/^#/, "");
    const next = NAV.some(([r]) => r === h) ? h : "home";
    if (next !== route || initial === true) {
      route = next;
      if (initial !== true) {
        render();
        window.scrollTo(0, 0);
      }
    }
  }
  function go(r) {
    if (location.hash === "#" + r) onHash();
    else location.hash = r;
  }

  // ---------- render ----------
  function render() {
    const app = $("#app");
    if (!app) return;
    const navLinks = NAV.filter(([r]) => VIEWS[r]).map(([r, l, g], i, arr) => (i > 0 && arr[i - 1][2] !== g ? '<div class="eyebrow rail-sep">' + esc(GROUP_LABEL[g]) + "</div>" : "") + '<a href="#' + r + '"' + (route === r ? ' aria-current="page"' : "") + ">" + icon(r) + esc(l) + "</a>").join("");
    const quick = '<button class="iconbtn" data-act="search" aria-label="Search everything">' + icon("search") + '</button><button class="iconbtn" data-act="capture" aria-label="Quick capture">' + icon("plus") + "</button>";
    const tabs =
      TABS.map((r) => {
        const l = NAV.find((n) => n[0] === r)[1];
        return '<a class="tab" href="#' + r + '"' + (route === r ? ' aria-current="page"' : "") + ">" + icon(r) + "<span>" + esc(l) + "</span></a>";
      }).join("") +
      '<button class="tab" type="button" data-act="more"' + (TABS.includes(route) ? "" : ' aria-current="page"') + ">" + icon("more") + "<span>More</span></button>";
    const title = (NAV.find((n) => n[0] === route) || ["", ""])[1];
    const body = mode === "loading" ? '<div class="loading">' + ruhv("ruhv-hero") + "<span>Opening your workspace…</span></div>" : VIEWS[route]();
    const scrollY = window.scrollY;
    app.innerHTML =
      '<nav class="rail" aria-label="Sections"><a class="brand" href="#home">' + MARK + "CareerCrumbs</a>" + '<div class="row rail-quick">' + quick + "</div>" + navLinks + '<span class="sync"></span></nav>' +
      '<main class="main"><header class="topbar"><a class="brand" href="#home">' + MARK + '<span class="sr">CareerCrumbs</span></a><span class="eyebrow">' + esc(title) + '</span><span class="sync"></span><span class="row top-quick">' + quick + "</span></header>" +
      (mode === "example" ? exampleBanner() : "") + withRuhv(body) + "</main>" +
      '<nav class="tabbar" aria-label="Main">' + tabs + "</nav>";
    window.scrollTo(0, scrollY);
    setSync(syncState);
  }
  function exampleBanner() {
    return '<div class="view" style="padding-top:0;margin-bottom:12px"><div class="banner"><p><b>You\'re looking at example data.</b> It shows how a supervisor might use CareerCrumbs. Nothing is saved until you start your own workspace.</p><div class="row"><button class="btn sm" data-act="start-blank">Start fresh</button><button class="btn sm ghost" data-act="start-keep">Keep examples</button></div></div></div>';
  }
  const head = (eyebrow, title, right) => '<div class="view-head"><div><span class="eyebrow">' + esc(eyebrow) + "</span><h1>" + esc(title) + "</h1></div>" + (right ? '<div class="row">' + right + "</div>" : "") + "</div>";

  // Empty states carry a small Ruhv, like the original app.
  const EMPTY_RE = /<div class="empty"><b>/g;
  const withRuhv = (html) => html.replace(EMPTY_RE, '<div class="empty">' + ruhv("ruhv-empty") + "<b>");

  // ---------- HOME ----------
  function readinessCard(compact) {
    const r = C.readiness(ws);
    const p = ws.profile;
    const weeksLeft = p.targetDate ? Math.max(0, Math.ceil(C.daysBetween(t0(), p.targetDate) / 7)) : null;
    const segs = ws.competencies
      .map((c) => {
        const tg = Number(c.target) || 1;
        const pct = Math.min(100, Math.round(((Number(c.rating) || 0) / tg) * 100));
        return '<div class="seg' + (pct >= 100 ? " met" : "") + '" title="' + esc(c.name + ": " + C.RATING_LABELS[c.rating || 0]) + '"><i style="height:' + pct + '%"></i></div>';
      })
      .join("");
    return (
      '<section class="card ready" aria-label="Promotion readiness"><div class="ready-top"><div class="stack-s"><span class="eyebrow">Ready for ' + esc(p.targetRole || "your next role") + '</span><div class="ready-pct mono">' + r.pct + '<small>%</small></div></div><div class="stack-s" style="text-align:right">' +
      (weeksLeft !== null ? '<span class="mono"><b>' + weeksLeft + "</b> weeks</span><span class=\"muted small\">to " + esc(C.fmtDateY(p.targetDate)) + "</span>" : '<button class="linkbtn" data-act="edit-profile">Set a target date</button>') +
      '</div></div><div class="segs" role="img" aria-label="' + r.atTarget + " of " + r.total + ' competencies at target">' + segs + "</div>" +
      '<div class="seg-key"><span><i style="background:var(--ink)"></i>' + r.atTarget + " of " + r.total + ' at target</span><span><i style="background:var(--brown)"></i>Working on it</span><span>' + r.evidenced + " with evidence</span></div>" +
      (compact ? '<div class="row"><a class="btn sm ghost" href="#path">Open promotion path ' + icon("chev") + "</a></div>" : "") +
      "</section>"
    );
  }
  function winsRhythm() {
    const data = C.winsByWeek(ws, 12);
    const max = Math.max(2, ...data.map((d) => d.count));
    const W = 320, H = 80, bw = W / data.length;
    const bars = data
      .map((d, i) => {
        const h = Math.round((d.count / max) * (H - 18));
        return '<rect x="' + (i * bw + 3).toFixed(1) + '" y="' + (H - 14 - h) + '" width="' + (bw - 6).toFixed(1) + '" height="' + Math.max(h, d.count ? 2 : 1) + '" rx="2" fill="' + (i === data.length - 1 ? "var(--brown)" : d.count ? "var(--ink)" : "var(--line)") + '"><title>' + d.count + " wins, week of " + C.fmtDate(d.week) + "</title></rect>";
      })
      .join("");
    const labels = [0, 4, 8, 11].map((i) => '<text x="' + (i === 0 ? 2 : i === 11 ? W - 2 : i * bw + bw / 2).toFixed(1) + '" y="' + (H - 2) + '" text-anchor="' + (i === 0 ? "start" : i === 11 ? "end" : "middle") + '" font-size="9" font-family="var(--mono)" fill="var(--muted)">' + C.fmtDate(data[i].week) + "</text>").join("");
    return '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Wins logged per week, last 12 weeks">' + bars + labels + "</svg>";
  }
  const VIEWS = {};
  VIEWS.home = function () {
    const p = ws.profile;
    const items = C.agenda(ws).slice(0, 8);
    const st = C.weekStats(ws);
    const recent = sortDesc(ws.wins, "date").slice(0, 3);
    const line = st.wins7 ? "Logged " + plural(st.wins7, "win") + " this week. That's the habit that gets people promoted." : "A win from this week, even a small one, is worth two minutes.";
    return (
      '<div class="view">' +
      head(C.fmtDateY(t0()) + (p.site ? " · " + p.site : ""), greeting() + (p.name ? ", " + p.name.split(" ")[0] : "")) +
      '<div class="row"><button class="btn brown" data-act="new-win">' + icon("plus") + 'Log a win</button><button class="btn ghost" data-act="log-week">Log numbers</button><button class="btn ghost" data-act="gen-update">Weekly update</button></div>' +
      readinessCard(true) +
      FX.homeTop.map((f) => f()).join("") +
      '<section class="stack"><div class="row between"><h2>Today</h2><span class="muted small">' + plural(items.length, "item") + "</span></div>" +
      (items.length
        ? '<div class="agenda">' + items.map((it) => '<button class="' + it.tone + '" data-act="goto" data-r="' + it.route + '"><span class="bar"></span><span><b>' + esc(it.title) + "</b><small>" + esc(it.sub) + "</small></span>" + icon("chev") + "</button>").join("") + "</div>"
        : '<div class="empty"><b>All clear</b><span>No follow-ups, overdue 1:1s or blocked projects. Good time to log a win or plan next week.</span></div>') +
      "</section>" +
      '<section class="stack"><h2>This week</h2><div class="tiles">' +
      '<div class="tile"><span class="eyebrow">Wins · 7d</span><b>' + st.wins7 + '</b></div><div class="tile"><span class="eyebrow">Wins · 30d</span><b>' + st.wins30 + "</b></div>" +
      '<div class="tile"><span class="eyebrow">On target</span><b>' + st.onTarget + '<span class="muted small"> / ' + st.withTarget + '</span></b></div><div class="tile"><span class="eyebrow">Active projects</span><b>' + st.activeProjects + "</b></div></div>" +
      '<div class="card stack-s"><div class="row between"><span class="eyebrow">Wins per week</span><span class="muted small">' + esc(line) + "</span></div>" + winsRhythm() + "</div></section>" +
      FX.homeBottom.map((f) => f()).join("") +
      (recent.length ? '<section class="stack"><div class="row between"><h2>Latest wins</h2><a class="linkbtn" href="#wins">All wins</a></div><div class="grid2">' + recent.map(winTicket).join("") + "</div></section>" : "") +
      "</div>"
    );
  };

  // ---------- WINS ----------
  function winTicket(w) {
    const m = C.metricPhrase(w.metric);
    const comps = (w.competencies || []).map((id) => byId(ws.competencies, id)).filter(Boolean);
    return (
      '<article class="ticket"><div class="ticket-head"><b>WIN-' + String(w.n || 0).padStart(4, "0") + "</b><span>" + esc(C.fmtDateY(w.date)) + "</span></div><h3>" + esc(w.title) + "</h3>" +
      (w.result ? '<p class="result">' + esc(w.result) + "</p>" : "") +
      (m ? '<div class="metric">' + esc(m) + "</div>" : "") +
      (comps.length || w.onResume ? '<div class="row">' + comps.map((c) => '<span class="pill brown">' + esc(c.name) + "</span>").join("") + (w.onResume ? '<span class="pill ink">On résumé</span>' : "") + "</div>" : "") +
      '<div class="tear"></div><div class="acts"><button class="btn sm ghost" data-act="edit-win" data-id="' + w.id + '">' + icon("edit") + 'Edit</button><button class="btn sm ghost" data-act="bullet" data-id="' + w.id + '">Résumé bullet</button></div></article>'
    );
  }
  VIEWS.wins = function () {
    const q = ui.winQ.toLowerCase();
    const list = sortDesc(ws.wins, "date").filter((w) => (!ui.winComp || (w.competencies || []).includes(ui.winComp)) && (!q || [w.title, w.situation, w.action, w.result].join(" ").toLowerCase().includes(q)));
    const counts = C.evidenceCounts(ws);
    return (
      '<div class="view">' +
      head(plural(ws.wins.length, "win") + " logged", "Wins", '<button class="btn ghost" data-act="brag">Brag doc</button><button class="btn brown" data-act="new-win">' + icon("plus") + "Log a win</button>") +
      '<p class="muted">Your evidence file. Every win is proof for your promotion case, your résumé and your weekly update. Log it the day it happens, while the numbers are fresh.</p>' +
      '<div class="fields2"><label class="field" for="win-q"><span class="sr">Search wins</span><input class="input" id="win-q" type="search" placeholder="Search wins" value="' + esc(ui.winQ) + '" data-bind="winQ"></label>' +
      '<label class="field" for="win-comp"><span class="sr">Filter by competency</span><select class="select" id="win-comp" data-bind="winComp"><option value="">All competencies</option>' +
      ws.competencies.map((c) => '<option value="' + c.id + '"' + (ui.winComp === c.id ? " selected" : "") + ">" + esc(c.name) + " (" + (counts[c.id] || 0) + ")</option>").join("") + "</select></label></div>" +
      (list.length ? '<div class="grid2">' + list.map(winTicket).join("") + "</div>" : ws.wins.length ? '<div class="empty"><b>No matches</b><span>Try a different search or competency.</span></div>' : '<div class="empty"><b>No wins yet</b><span>Think about the last shift. Did you fix something, coach someone, or hit a number? That counts.</span><button class="btn brown" data-act="new-win">Log your first win</button></div>') +
      "</div>"
    );
  };
  function winForm(w, prefill) {
    w = w || Object.assign({ date: t0(), metric: {}, competencies: [] }, prefill || {});
    const m = w.metric || {};
    return (
      '<form data-form="win" data-id="' + esc(w.id || "") + '">' +
      fieldText("title", "What happened?", w.title, { req: true, ph: "e.g. Cut INF misses on the frozen aisle" }) +
      fieldText("date", "Date", w.date, { type: "date" }) +
      fieldText("situation", "Situation", w.situation, { area: true, rows: 2, ph: "What was the problem or opportunity?" }) +
      fieldText("action", "What you did", w.action, { area: true, rows: 2, ph: "Start with a verb: led, trained, rebuilt, fixed…" }) +
      fieldText("result", "Result", w.result, { area: true, rows: 2, ph: "What changed because of it?" }) +
      '<fieldset class="stack-s" style="border:0;padding:0;margin:0"><legend class="field"><span>Measured change <span class="muted small">(optional, your real numbers only)</span></span></legend><div class="fields2">' +
      fieldText("mlabel", "Metric", m.label, { ph: "e.g. INF rate" }) + fieldText("mbefore", "Before", m.before, { mode: "decimal" }) + fieldText("mafter", "After", m.after, { mode: "decimal" }) +
      fieldSelect("munit", "Unit", m.unit || "", [["", "count"], ["%", "%"], ["$", "$"], ["min", "min"], ["UPH", "UPH"], ["hrs", "hrs"]]) + "</div></fieldset>" +
      '<div class="field"><span>What it shows</span><div class="togglechips">' + ws.competencies.map((c) => '<label><input type="checkbox" name="comp" value="' + c.id + '"' + ((w.competencies || []).includes(c.id) ? " checked" : "") + "><span>" + esc(c.name) + "</span></label>").join("") + "</div></div>" +
      '<div class="sheet-foot">' + (w.id ? '<button type="button" class="btn danger sm" data-act="ask-del" data-kind="win" data-id="' + w.id + '">Delete</button>' : "") + '<span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">Save win</button></div>' +
      '<div data-confirm></div></form>'
    );
  }

  // ---------- METRICS ----------
  function sparkSvg(k, weeks, big) {
    const series = C.kpiSeries(k, weeks);
    const W = big ? 600 : 240, H = big ? 180 : 56, pad = big ? 16 : 6;
    const t = C.num(k.target);
    const sp = C.sparkPoints(series, W, H, pad, t);
    let out = "";
    if (big && sp.segments.length) {
      for (const v of [sp.min, (sp.min + sp.max) / 2, sp.max]) {
        const y = sp.y(v).toFixed(1);
        out += '<line x1="0" x2="' + W + '" y1="' + y + '" y2="' + y + '" stroke="var(--line)" stroke-width="1"/><text x="0" y="' + (y - 4) + '" font-size="11" font-family="var(--mono)" fill="var(--muted)">' + esc(C.fmtNum(v, k.unit)) + "</text>";
      }
    }
    if (t !== null && sp.segments.length) {
      const y = sp.y(t).toFixed(1);
      out += '<line x1="0" x2="' + W + '" y1="' + y + '" y2="' + y + '" stroke="var(--muted)" stroke-dasharray="4 4" stroke-width="1"/>';
      if (big) out += '<text x="' + W + '" y="' + (y - 4) + '" text-anchor="end" font-size="11" font-family="var(--mono)" fill="var(--muted)">target ' + esc(C.fmtNum(t, k.unit)) + "</text>";
    }
    for (const seg of sp.segments) {
      const pts = seg.map((p) => p.join(",")).join(" ");
      if (seg.length > 1) out += '<polygon points="' + seg[0][0] + "," + H + " " + pts + " " + seg[seg.length - 1][0] + "," + H + '" fill="var(--brown)" fill-opacity="0.10"/>';
      out += '<polyline points="' + pts + '" fill="none" stroke="var(--brown)" stroke-width="' + (big ? 2.5 : 2) + '" stroke-linejoin="round" stroke-linecap="round"/>';
    }
    const last = sp.segments.length ? sp.segments[sp.segments.length - 1].slice(-1)[0] : null;
    if (last) out += '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="' + (big ? 5 : 3.5) + '" fill="var(--ink)" stroke="var(--surface)" stroke-width="2"/>';
    if (big) out += [0, Math.floor(weeks / 2), weeks - 1].map((i) => '<text x="' + ((i * W) / (weeks - 1)).toFixed(1) + '" y="' + (H + 14) + '" text-anchor="' + (i === 0 ? "start" : i === weeks - 1 ? "end" : "middle") + '" font-size="11" font-family="var(--mono)" fill="var(--muted)">' + C.fmtDate(series[i].week) + "</text>").join("");
    if (!sp.segments.length) out += '<text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle" font-size="12" fill="var(--muted)">No entries yet</text>';
    return '<svg class="' + (big ? "chart" : "spark") + '" viewBox="0 0 ' + W + " " + (big ? H + 20 : H) + '" preserveAspectRatio="' + (big ? "xMidYMid meet" : "none") + '" role="img" aria-label="' + esc(k.name) + ' trend">' + out + "</svg>";
  }
  const STATE_PILL = { on: ["solid", "On target"], near: ["warn", "Close"], off: ["bad", "Off target"], logged: ["", "No target"], none: ["", "Not logged"] };
  VIEWS.metrics = function () {
    const wk = C.weekOf(t0());
    return (
      '<div class="view">' +
      head("Week of " + C.fmtDate(wk), "Numbers", '<button class="btn ghost" data-act="new-kpi">' + icon("plus") + 'Add metric</button><button class="btn brown" data-act="log-week">Log this week</button>') +
      '<p class="muted">Track the numbers your building is judged on. Log once a week from your site dashboard. A supervisor who can show their trend lines gets taken seriously.</p>' +
      (ws.kpis.length
        ? '<div class="grid2">' +
          ws.kpis.map((k) => {
            const s = C.kpiStatus(k);
            const [cls, label] = STATE_PILL[s.state];
            const tr = s.trend > 0 ? '<span class="trend-up mono small">▲ better</span>' : s.trend < 0 ? '<span class="trend-down mono small">▼ worse</span>' : "";
            return '<button class="card kpi" data-act="kpi" data-id="' + k.id + '"><div class="row between"><span class="eyebrow">' + esc(k.name) + '</span><span class="pill ' + cls + '">' + label + '</span></div><div class="row between"><span class="kpi-val">' + esc(s.value === null ? "—" : C.fmtNum(s.value, k.unit)) + "</span>" + tr + "</div>" + sparkSvg(k, 12) + '<span class="muted small mono">' + (s.target !== null ? "Target " + esc(C.fmtNum(s.target, k.unit)) + " · " : "") + (k.better === "lower" ? "lower is better" : "higher is better") + "</span></button>";
          }).join("") + "</div>"
        : '<div class="empty"><b>Pick the numbers you own</b><span>Start with two or three. You can add more later.</span><div class="togglechips">' + C.KPI_PRESETS.map((p, i) => '<button class="chip" data-act="add-preset" data-i="' + i + '">' + esc(p.name) + "</button>").join("") + "</div></div>") +
      "</div>"
    );
  };
  function kpiForm(k) {
    k = k || { better: "higher", unit: "" };
    return (
      '<form data-form="kpi" data-id="' + esc(k.id || "") + '">' +
      fieldText("name", "Metric name", k.name, { req: true, ph: "e.g. Units per hour" }) +
      '<div class="fields2">' + fieldText("unit", "Unit", k.unit, { ph: "%, $, min, UPH" }) + fieldText("target", "Target", k.target == null ? "" : k.target, { mode: "decimal" }) + fieldSelect("better", "Better is", k.better, [["higher", "Higher"], ["lower", "Lower"]]) + "</div>" +
      (k.id ? "" : '<div class="field"><span>Or start from a common one</span><div class="togglechips">' + C.KPI_PRESETS.map((p, i) => '<button type="button" class="chip" data-act="fill-preset" data-i="' + i + '">' + esc(p.name) + "</button>").join("") + "</div></div>") +
      '<div class="sheet-foot">' + (k.id ? '<button type="button" class="btn danger sm" data-act="ask-del" data-kind="kpi" data-id="' + k.id + '">Delete metric</button>' : "") + '<span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">Save</button></div><div data-confirm></div></form>'
    );
  }
  function logWeekForm(week) {
    return (
      '<form data-form="logweek">' +
      fieldText("week", "Week starting (Monday)", week, { type: "date", hint: "Any day works; it's filed under that week's Monday." }) +
      ws.kpis.map((k) => {
        const e = (k.entries || []).find((x) => x.week === C.weekOf(week));
        return fieldText("k_" + k.id, k.name + (k.unit ? " (" + k.unit + ")" : ""), e ? e.value : "", { mode: "decimal", ph: k.target != null ? "target " + k.target : "" });
      }).join("") +
      '<div class="sheet-foot"><span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">Save numbers</button></div></form>'
    );
  }

  // ---------- PROMOTION PATH ----------
  VIEWS.path = function () {
    const p = ws.profile;
    const ev = C.evidenceCounts(ws);
    const phases = [["30", "First 30 days"], ["60", "Days 31–60"], ["90", "Days 61–90"]];
    return (
      '<div class="view">' +
      head(p.role + " → " + p.targetRole, "Promotion path", '<button class="btn ghost" data-act="edit-profile">Edit target</button><button class="btn brown" data-act="gen-case">Build my case</button>') +
      readinessCard(false) +
      '<section class="card"><div class="row between"><h2>Competencies</h2><span class="muted small">Rate yourself honestly · ◆ marks the target</span></div>' +
      ws.competencies.map((c) => {
        const gap = (Number(c.target) || 0) - (Number(c.rating) || 0);
        return '<div class="comp"><div class="row between"><div class="stack-s" style="flex:1 1 220px"><h3>' + esc(c.name) + '</h3><span class="muted small">' + esc(c.desc || "") + '</span></div><div class="row">' +
          '<button class="pill ' + (ev[c.id] ? "brown" : "bad") + '" style="border:0;cursor:pointer" data-act="comp-wins" data-id="' + c.id + '">' + plural(ev[c.id] || 0, "win") + "</button>" +
          (gap > 0 ? '<span class="pill warn">Gap ' + gap + "</span>" : '<span class="pill solid">At target</span>') + "</div></div>" +
          '<div class="rating" role="group" aria-label="' + esc(c.name) + ' rating">' + C.RATING_LABELS.map((l, i) => '<button type="button" data-act="rate" data-id="' + c.id + '" data-v="' + i + '" aria-pressed="' + (Number(c.rating) === i) + '" class="' + (Number(c.target) === i ? "target" : "") + '" title="' + esc(l) + '">' + i + "</button>").join("") + "</div>" +
          '<div class="row between small muted"><span>' + esc(C.RATING_LABELS[c.rating || 0]) + '</span><label class="row" for="tg-' + c.id + '">Target <select class="select" style="min-height:32px;width:auto;padding:2px 8px" id="tg-' + c.id + '" data-act-change="target" data-id="' + c.id + '">' + [1, 2, 3, 4].map((v) => '<option value="' + v + '"' + (Number(c.target) === v ? " selected" : "") + ">" + v + " · " + C.RATING_LABELS[v] + "</option>").join("") + "</select></label></div></div>";
      }).join("") +
      '<div class="row" style="padding-top:12px"><button class="btn sm ghost" data-act="edit-comps">Edit competency list</button></div></section>' +
      '<section class="card stack"><div class="row between"><h2>30 / 60 / 90 plan</h2>' + (sample ? '<button class="btn sm ghost" data-act="ai-plan">' + ruhv("ruhv-btn") + "Ask Ruhv for next steps</button>" : "") + "</div>" +
      '<p class="muted small">Small, specific moves your manager can see. Ask them what "ready" looks like, then put it here.</p>' +
      phases.map(([ph, label]) => {
        const items = ws.plan.filter((s) => s.phase === ph);
        return '<div class="plan-phase"><span class="eyebrow">' + label + "</span>" +
          (items.length ? items.map((s) => '<div class="plan-item' + (s.done ? " done" : "") + '"><input type="checkbox" class="check" style="width:20px;height:20px;accent-color:var(--brown)" aria-label="Done" data-act-change="plan-done" data-id="' + s.id + '"' + (s.done ? " checked" : "") + '><span class="t">' + esc(s.text) + (s.due ? ' <span class="muted small mono">· ' + esc(C.fmtDate(s.due)) + "</span>" : "") + '</span><button class="iconbtn" aria-label="Remove step" data-act="plan-del" data-id="' + s.id + '">' + icon("close") + "</button></div>").join("") : '<span class="muted small">Nothing here yet.</span>') +
          '<form class="row" data-form="plan" data-phase="' + ph + '"><input class="input" style="flex:1 1 200px" name="text" placeholder="Add a step" aria-label="New step for ' + label + '" required><input class="input" style="width:auto;flex:0 1 160px" type="date" name="due" aria-label="Due date"><button class="btn sm ghost">Add</button></form></div>';
      }).join("") +
      "</section></div>"
    );
  };
  function profileForm() {
    const p = ws.profile;
    return (
      '<form data-form="profile">' + fieldText("name", "Your name", p.name) +
      '<div class="fields2">' + fieldText("role", "Current role", p.role) + fieldText("company", "Company", p.company) + "</div>" +
      fieldText("site", "Site / building", p.site, { ph: "e.g. your DashMart location" }) +
      '<div class="fields2">' + fieldText("targetRole", "Target role", p.targetRole) + fieldText("targetDate", "Target date", p.targetDate, { type: "date" }) + "</div>" +
      fieldText("why", "Why you want it", p.why, { area: true, rows: 2, hint: "Goes into your promotion case summary." }) +
      '<div class="sheet-foot"><span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">Save</button></div></form>'
    );
  }

  // ---------- PROJECTS ----------
  VIEWS.projects = function () {
    const f = ui.projFilter;
    const filters = ["Open", ...C.PROJECT_STATUSES];
    const count = (s) => ws.projects.filter((p) => (s === "Open" ? p.status !== "Done" : p.status === s)).length;
    const list = ws.projects.filter((p) => (f === "Open" ? p.status !== "Done" : p.status === f)).sort((a, b) => String(a.due || "9999") < String(b.due || "9999") ? -1 : 1);
    const tone = { Active: "brown", Blocked: "bad", Done: "solid", Idea: "" };
    return (
      '<div class="view">' + head(count("Active") + " active", "Projects", '<button class="btn brown" data-act="new-project">' + icon("plus") + "New project</button>") +
      '<p class="muted">Projects are where supervisors show they think beyond the shift. Write the impact in business terms (UPH, INF, shrink, dasher wait) so it carries into your promotion case.</p>' +
      '<div class="chips" role="group" aria-label="Filter projects">' + filters.map((s) => '<button class="chip" data-act="proj-filter" data-v="' + s + '" aria-pressed="' + (f === s) + '">' + s + '<span class="n">' + count(s) + "</span></button>").join("") + "</div>" +
      (list.length
        ? '<div class="grid2">' + list.map((p) => {
            const ms = p.milestones || [];
            const done = ms.filter((m) => m.done).length;
            return '<article class="card stack"><div class="row between"><span class="pill ' + tone[p.status] + '">' + esc(p.status) + "</span>" + (p.due ? '<span class="mono small ' + (p.status !== "Done" && C.daysBetween(t0(), p.due) < 0 ? "trend-down" : "muted") + '">Due ' + esc(C.fmtDate(p.due)) + "</span>" : "") + "</div><h3>" + esc(p.title) + "</h3>" +
              (p.status === "Blocked" && p.blocker ? '<p class="small" style="color:var(--bad)">Blocked: ' + esc(p.blocker) + "</p>" : "") +
              (p.status === "Done" && p.result ? '<p class="small">' + esc(p.result) + "</p>" : p.impact ? '<p class="small muted">' + esc(p.impact) + "</p>" : "") +
              (p.nextAction && p.status !== "Done" ? '<p class="small"><b>Next:</b> ' + esc(p.nextAction) + "</p>" : "") +
              (ms.length ? '<div class="stack-s"><div class="progress"><i style="width:' + Math.round((done / ms.length) * 100) + '%"></i></div><div class="ms">' + ms.map((m, i) => '<label><input type="checkbox" data-act-change="ms" data-id="' + p.id + '" data-i="' + i + '"' + (m.done ? " checked" : "") + "><span>" + esc(m.text) + "</span></label>").join("") + "</div></div>" : "") +
              '<div class="row"><button class="btn sm ghost" data-act="edit-project" data-id="' + p.id + '">' + icon("edit") + "Edit</button>" + (p.status === "Done" ? '<button class="btn sm ghost" data-act="proj-win" data-id="' + p.id + '">Log as a win</button>' : "") + "</div></article>";
          }).join("") + "</div>"
        : '<div class="empty"><b>' + (ws.projects.length ? "Nothing in " + esc(f) : "No projects yet") + "</b><span>A slotting change, a training program or a fix for a recurring miss all count.</span><button class=\"btn brown\" data-act=\"new-project\">Add a project</button></div>") +
      "</div>"
    );
  };
  function projectForm(p) {
    p = p || { status: "Active", milestones: [] };
    return (
      '<form data-form="project" data-id="' + esc(p.id || "") + '">' + fieldText("title", "Project", p.title, { req: true }) +
      '<div class="fields2">' + fieldSelect("status", "Status", p.status, C.PROJECT_STATUSES) + fieldText("due", "Due", p.due, { type: "date" }) + "</div>" +
      fieldText("impact", "Expected impact", p.impact, { area: true, rows: 2, ph: "Which number does this move, and why does it matter?" }) +
      fieldText("nextAction", "Next action", p.nextAction, { ph: "The very next physical step" }) +
      fieldText("blocker", "Blocker (if blocked)", p.blocker) +
      fieldText("stakeholders", "Stakeholders", p.stakeholders, { ph: "Who needs to know or approve?" }) +
      fieldText("milestones", "Milestones", (p.milestones || []).map((m) => (m.done ? "[x] " : "") + m.text).join("\n"), { area: true, rows: 3, hint: "One per line. Start a line with [x] to mark it done." }) +
      fieldText("result", "Result (when done)", p.result, { area: true, rows: 2 }) +
      '<div class="sheet-foot">' + (p.id ? '<button type="button" class="btn danger sm" data-act="ask-del" data-kind="project" data-id="' + p.id + '">Delete</button>' : "") + '<span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">Save</button></div><div data-confirm></div></form>'
    );
  }

  // ---------- TEAM ----------
  VIEWS.team = function () {
    const cov = C.coverage(ws);
    return (
      '<div class="view">' + head(plural(ws.team.length, "person") .replace("persons", "people"), "Team", '<button class="btn brown" data-act="new-member">' + icon("plus") + "Add person</button>") +
      '<p class="muted">Leading people is the biggest jump from supervisor to manager. Log 1:1s, recognition and coaching here so you can show how your team grew under you.</p>' +
      (ws.team.length
        ? '<div class="grid2">' + ws.team.map((m) => {
            const d = C.oneOnOneDue(m, null, 14);
            const rec = sortDesc((m.notes || []).filter((n) => n.type === "Recognition"), "date")[0];
            return '<article class="card stack"><div class="row between"><div class="stack-s"><h3>' + esc(m.name) + '</h3><span class="muted small">' + esc([m.role, m.shift ? m.shift + " shift" : ""].filter(Boolean).join(" · ")) + '</span></div><span class="row">' + ((m.onboarding || []).length && !(m.onboarding || []).every((x) => x.done) ? '<span class="pill brown">New hire</span>' : "") + '<span class="pill ' + (d.due ? "warn" : "") + '">' + esc(d.label) + "</span></span></div>" +
              (m.growth ? '<p class="small"><b>Growing toward:</b> ' + esc(m.growth) + "</p>" : "") +
              (rec ? '<p class="small muted">Last recognised ' + esc(C.fmtDate(rec.date)) + ": " + esc(rec.text) + "</p>" : "") +
              '<div class="row"><button class="btn sm brown" data-act="note" data-id="' + m.id + '">Log note</button><button class="btn sm ghost" data-act="agenda" data-id="' + m.id + '">1:1 agenda</button><button class="btn sm ghost" data-act="kudos" data-id="' + m.id + '">Shout-out</button><button class="btn sm ghost" data-act="member" data-id="' + m.id + '">History</button></div></article>';
          }).join("") + "</div>"
        : '<div class="empty"><b>Add your team</b><span>Start with the people you schedule and coach. Only you can see this.</span><button class="btn brown" data-act="new-member">Add a person</button></div>') +
      '<section class="card stack"><div class="row between"><h2>Cross-training</h2><button class="btn sm ghost" data-act="edit-stations">Edit stations</button></div><p class="muted small">Tap a cell to step through: — → Training → Certified → Trainer. Stations with fewer than 2 certified people are a risk when someone calls out.</p>' +
      (ws.team.length
        ? '<div class="scroll-x"><table class="matrix"><thead><tr><th>Person</th>' + ws.stations.map((s) => "<th>" + esc(s) + "</th>").join("") + "</tr></thead><tbody>" +
          ws.team.map((m) => "<tr><td>" + esc(m.name) + "</td>" + ws.stations.map((s) => {
            const l = (m.training || {})[s] || 0;
            return '<td><button class="lvl" data-act="lvl" data-id="' + m.id + '" data-s="' + esc(s) + '" data-l="' + l + '" aria-label="' + esc(m.name + ", " + s + ": " + C.TRAIN_LEVELS[l]) + '">' + ["—", "TRN", "CRT", "TRN+"][l] + "</button></td>";
          }).join("") + "</tr>").join("") +
          "</tbody><tfoot><tr><td>Certified</td>" + ws.stations.map((s) => '<td><span class="pill ' + (cov[s] < 2 ? "bad" : "solid") + '">' + cov[s] + "</span></td>").join("") + "</tr></tfoot></table></div>"
        : '<span class="muted small">Add people to see the matrix.</span>') +
      "</section></div>"
    );
  };
  function memberForm(m) {
    m = m || {};
    return (
      '<form data-form="member" data-id="' + esc(m.id || "") + '">' + fieldText("name", "Name", m.name, { req: true }) +
      '<div class="fields2">' + fieldText("role", "Role", m.role, { ph: "Picker, packer, lead…" }) + fieldSelect("shift", "Shift", m.shift || "", [["", "—"], "AM", "PM", "Overnight", "Weekend"]) + "</div>" +
      fieldText("growth", "Growth goal", m.growth, { ph: "What are they working toward?" }) +
      '<div class="sheet-foot">' + (m.id ? '<button type="button" class="btn danger sm" data-act="ask-del" data-kind="member" data-id="' + m.id + '">Remove</button>' : "") + '<span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">Save</button></div><div data-confirm></div></form>'
    );
  }
  function noteForm(m) {
    return (
      '<form data-form="note" data-id="' + m.id + '"><p class="muted">For ' + esc(m.name) + "</p>" +
      '<div class="fields2">' + fieldSelect("type", "Type", "1:1", ["1:1", "Recognition", "Coaching", "Feedback"]) + fieldText("date", "Date", t0(), { type: "date" }) + "</div>" +
      fieldText("text", "Note", "", { area: true, req: true, rows: 3, ph: "What was said, agreed or noticed? Be specific." }) +
      '<div class="sheet-foot"><span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">Save note</button></div></form>'
    );
  }

  // ---------- VISIBILITY ----------
  VIEWS.people = function () {
    const list = ws.people.slice().sort((a, b) => {
      const da = C.touchDue(a), dbb = C.touchDue(b);
      return (da.days === null ? -999 : da.days) - (dbb.days === null ? -999 : dbb.days);
    });
    return (
      '<div class="view">' + head("Who knows your work", "Visibility", '<button class="btn ghost" data-act="gen-update">Weekly update</button><button class="btn brown" data-act="new-person">' + icon("plus") + "Add person</button>") +
      '<p class="muted">Promotions are decided by people who see your work. Keep a steady rhythm with your manager, your skip-level and a mentor. CareerCrumbs tells you when you\'re due.</p>' +
      (list.length
        ? '<div class="grid2">' + list.map((p) => {
            const d = C.touchDue(p);
            const last = sortDesc(p.touches || [], "date")[0];
            return '<article class="card stack"><div class="row between"><div class="stack-s"><h3>' + esc(p.name) + '</h3><span class="muted small">' + esc([p.relation, p.role].filter(Boolean).join(" · ")) + '</span></div><span class="pill ' + (d.due ? (d.days !== null && d.days < 0 ? "bad" : "warn") : "") + '">' + esc(d.label) + "</span></div>" +
              (last ? '<p class="small muted">Last: ' + esc(last.kind) + " · " + esc(C.fmtDate(last.date)) + (last.note ? " · " + esc(last.note) : "") + "</p>" : "") +
              (p.notes ? '<p class="small">' + esc(p.notes) + "</p>" : "") +
              '<div class="row"><button class="btn sm brown" data-act="touch" data-id="' + p.id + '">Log touchpoint</button><button class="btn sm ghost" data-act="edit-person" data-id="' + p.id + '">' + icon("edit") + "Edit</button></div></article>";
          }).join("") + "</div>"
        : '<div class="empty"><b>Map the people who matter</b><span>Start with your manager, your skip-level and one mentor.</span><button class="btn brown" data-act="new-person">Add your manager</button></div>') +
      "</div>"
    );
  };
  function personForm(p) {
    p = p || { relation: "Manager", cadenceDays: 7 };
    return (
      '<form data-form="person" data-id="' + esc(p.id || "") + '">' + fieldText("name", "Name", p.name, { req: true }) +
      '<div class="fields2">' + fieldSelect("relation", "Relationship", p.relation, C.RELATIONS) + fieldText("role", "Their role", p.role) + "</div>" +
      fieldSelect("cadenceDays", "Touch base every", p.cadenceDays, [[7, "Week"], [14, "2 weeks"], [21, "3 weeks"], [30, "Month"], [60, "2 months"], [90, "Quarter"]]) +
      fieldText("notes", "What they care about", p.notes, { area: true, rows: 2, ph: "So your updates land with them" }) +
      '<div class="sheet-foot">' + (p.id ? '<button type="button" class="btn danger sm" data-act="ask-del" data-kind="person" data-id="' + p.id + '">Remove</button>' : "") + '<span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">Save</button></div><div data-confirm></div></form>'
    );
  }
  function touchForm(p) {
    return (
      '<form data-form="touch" data-id="' + p.id + '"><p class="muted">With ' + esc(p.name) + "</p>" +
      '<div class="fields2">' + fieldSelect("kind", "How", "Weekly update", ["Weekly update", "1:1", "Meeting", "Site walk", "Message", "Hallway chat", "Shared a win"]) + fieldText("date", "Date", t0(), { type: "date" }) + "</div>" +
      fieldText("note", "Note", "", { ph: "What did you share or learn?" }) +
      '<div class="sheet-foot"><span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">Log it</button></div></form>'
    );
  }

  // ---------- JOBS ----------
  VIEWS.jobs = function () {
    const f = ui.jobFilter;
    const statuses = ["All", ...C.JOB_STATUSES];
    const count = (s) => (s === "All" ? ws.jobs.length : ws.jobs.filter((j) => j.status === s).length);
    const list = ws.jobs.filter((j) => f === "All" || j.status === f).sort((a, b) => String(a.followUpAt || "9999") < String(b.followUpAt || "9999") ? -1 : 1);
    return (
      '<div class="view">' + head("Internal and outside openings", "Jobs", '<button class="btn brown" data-act="new-job">' + icon("plus") + "Add opening</button>") +
      '<div class="chips" role="group" aria-label="Filter by stage">' + statuses.map((s) => '<button class="chip" data-act="job-filter" data-v="' + s + '" aria-pressed="' + (f === s) + '">' + s + '<span class="n">' + count(s) + "</span></button>").join("") + "</div>" +
      (list.length
        ? '<div class="grid2">' + list.map((j) => {
            const b = C.followUpBadge(j);
            return '<article class="card stack"><div class="row between"><span class="eyebrow">' + esc(j.company) + (j.internal ? " · internal" : "") + '</span><label class="sr" for="js-' + j.id + '">Stage</label><select class="select" style="min-height:32px;width:auto;padding:2px 8px" id="js-' + j.id + '" data-act-change="job-status" data-id="' + j.id + '">' + C.JOB_STATUSES.map((s) => "<option" + (s === j.status ? " selected" : "") + ">" + s + "</option>").join("") + "</select></div><h3>" + esc(j.title) + "</h3>" +
              (j.nextStep ? '<p class="small"><b>Next:</b> ' + esc(j.nextStep) + "</p>" : "") +
              (b ? '<span class="pill ' + b.tone + '" style="justify-self:start">' + esc(b.text) + "</span>" : "") +
              '<div class="row"><button class="btn sm ghost" data-act="edit-job" data-id="' + j.id + '">' + icon("edit") + "Details</button>" + (j.link ? '<a class="btn sm ghost" href="' + esc(j.link) + '" target="_blank" rel="noopener">Open listing</a>' : "") + "</div></article>";
          }).join("") + "</div>"
        : '<div class="empty"><b>' + (ws.jobs.length ? "Nothing at this stage" : "No openings tracked") + "</b><span>Track internal postings like Ops Manager or Site Lead, and outside roles you're curious about.</span><button class=\"btn brown\" data-act=\"new-job\">Add an opening</button></div>") +
      "</div>"
    );
  };
  function jobForm(j) {
    j = j || { status: "Saved", internal: true, company: ws.profile.company || "" };
    return (
      '<form data-form="job" data-id="' + esc(j.id || "") + '">' + fieldText("title", "Role", j.title, { req: true }) +
      '<div class="fields2">' + fieldText("company", "Company", j.company) + fieldSelect("status", "Stage", j.status, C.JOB_STATUSES) + "</div>" +
      '<label class="check"><input type="checkbox" name="internal"' + (j.internal ? " checked" : "") + "> Internal opening</label>" +
      fieldText("link", "Listing link", j.link, { type: "url", ph: "https://" }) +
      '<div class="fields2">' + fieldText("nextStep", "Next step", j.nextStep) + fieldText("followUpAt", "Follow up on", j.followUpAt, { type: "date" }) + "</div>" +
      fieldText("notes", "Notes", j.notes, { area: true, rows: 3 }) +
      (j.history && j.history.length ? '<div class="stack-s"><span class="eyebrow">Timeline</span><div class="timeline">' + j.history.slice().reverse().map((h) => "<div><b>" + esc(h.status) + '</b> <span class="muted small mono">' + esc(C.fmtDateY(h.at.slice(0, 10))) + "</span></div>").join("") + "</div></div>" : "") +
      '<div class="sheet-foot">' + (j.id ? '<button type="button" class="btn danger sm" data-act="ask-del" data-kind="job" data-id="' + j.id + '">Delete</button>' : "") + '<span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">Save</button></div><div data-confirm></div></form>'
    );
  }

  // ---------- DRAFTS ----------
  VIEWS.drafts = function () {
    const k = ui.draftKind;
    const kinds = Object.keys(C.DRAFT_KINDS);
    const list = sortDesc(ws.drafts, "updated").filter((d) => !k || d.kind === k);
    return (
      '<div class="view">' + head(plural(ws.drafts.length, "draft"), "Drafts", '<button class="btn brown" data-act="new-draft">' + icon("plus") + "New</button>") +
      '<p class="muted">Updates, promotion cases and 1:1 agendas built from your own data. They start as templates; edit them to sound like you.' + (sample ? " Ruhv can polish the wording." : "") + "</p>" +
      '<div class="chips" role="group" aria-label="Filter drafts"><button class="chip" data-act="draft-kind" data-v="" aria-pressed="' + !k + '">All<span class="n">' + ws.drafts.length + "</span></button>" + kinds.map((x) => '<button class="chip" data-act="draft-kind" data-v="' + x + '" aria-pressed="' + (k === x) + '">' + esc(C.DRAFT_KINDS[x]) + '<span class="n">' + ws.drafts.filter((d) => d.kind === x).length + "</span></button>").join("") + "</div>" +
      (list.length
        ? '<div class="list">' + list.map((d) => '<button class="li" data-act="open-draft" data-id="' + d.id + '"><span class="row between"><b>' + esc(d.title) + '</b><span class="pill">' + esc(C.DRAFT_KINDS[d.kind] || "Other") + '</span></span><span class="muted small">' + esc((d.body || "").replace(/\s+/g, " ").slice(0, 110)) + '</span><span class="mono small muted">Edited ' + esc(C.fmtDateY((d.updated || "").slice(0, 10))) + "</span></button>").join("") + "</div>"
        : '<div class="empty"><b>No drafts yet</b><span>Generate a weekly update or your promotion case to start.</span><div class="row"><button class="btn brown" data-act="gen-update">Weekly update</button><button class="btn ghost" data-act="gen-case">Promotion case</button></div></div>') +
      "</div>"
    );
  };
  function addDraft(kind, title, body) {
    const now = new Date().toISOString();
    const d = { id: C.uid("d"), kind, title, body, created: now, updated: now };
    ws.drafts.unshift(d);
    if (ws.drafts.length > 200) ws.drafts.length = 200;
    save("drafts");
    return d;
  }
  function draftEditor(d) {
    return (
      '<div class="sheet-body" data-draft="' + d.id + '">' +
      fieldText("dtitle", "Title", d.title) +
      '<label class="field" for="f-dbody"><span class="row between"><span>Text</span><span class="muted small mono" data-count>' + (d.body || "").length + ' chars</span></span><textarea class="textarea" id="f-dbody" rows="14" style="font-family:var(--mono);font-size:0.88rem">' + esc(d.body) + "</textarea><small>Saves as you type.</small></label>" +
      '<div data-ai></div>' +
      '<div class="sheet-foot"><button class="btn danger sm" data-act="ask-del" data-kind="draft" data-id="' + d.id + '">Delete</button><span class="grow"></span>' +
      (sample ? '<button class="btn sm ghost" data-act="ai-polish" data-id="' + d.id + '">' + ruhv("ruhv-btn") + "Polish with Ruhv</button>" : "") +
      '<button class="btn sm ghost" data-act="download-draft" data-id="' + d.id + '">Save file</button><button class="btn sm brown" data-act="copy-draft">' + icon("copy") + "Copy</button></div><div data-confirm></div></div>"
    );
  }
  function openDraft(d) {
    openSheet(esc(C.DRAFT_KINDS[d.kind] || "Draft"), draftEditor(d));
  }

  // ---------- WEEKLY REVIEW ----------
  VIEWS.review = function () {
    const wk = C.weekOf(t0());
    const cur = ws.reviews.find((r) => r.week === wk) || {};
    const st = C.weekStats(ws);
    const past = sortDesc(ws.reviews.filter((r) => r.week !== wk), "week");
    return (
      '<div class="view">' + head("Week of " + C.fmtDate(wk), "Weekly review") +
      '<p class="muted">Ten minutes at the end of your week. No scores and no streaks. Just notice what worked and choose a focus.</p>' +
      '<div class="tiles"><div class="tile"><span class="eyebrow">Wins</span><b>' + st.wins7 + '</b></div><div class="tile"><span class="eyebrow">On target</span><b>' + st.onTarget + "/" + st.withTarget + '</b></div><div class="tile"><span class="eyebrow">Plan steps done</span><b>' + ws.plan.filter((s) => s.done).length + "/" + ws.plan.length + '</b></div><div class="tile"><span class="eyebrow">1:1s this week</span><b>' + ws.team.reduce((s, m) => s + (m.notes || []).filter((n) => n.type === "1:1" && n.date >= wk).length, 0) + "</b></div></div>" +
      '<form class="card stack" data-form="review" data-week="' + wk + '">' +
      fieldText("wentWell", "What went well?", cur.wentWell, { area: true, rows: 2 }) +
      fieldText("stuck", "What got stuck, and what would unstick it?", cur.stuck, { area: true, rows: 2 }) +
      fieldText("nextFocus", "One focus for next week", cur.nextFocus, { area: true, rows: 2 }) +
      '<div class="field"><span>Energy this week</span><div class="rating" role="radiogroup" aria-label="Energy">' + [1, 2, 3, 4, 5].map((v) => '<label style="display:contents"><input class="sr" type="radio" name="energy" value="' + v + '"' + (Number(cur.energy) === v ? " checked" : "") + '><button type="button" data-act="energy" data-v="' + v + '" aria-pressed="' + (Number(cur.energy) === v) + '">' + v + "</button></label>").join("") + '</div><small>1 = running on empty · 5 = full tank</small></div>' +
      '<div class="row"><button class="btn brown">Save review</button><button type="button" class="btn ghost" data-act="gen-update">Turn into a weekly update</button></div></form>' +
      (past.length ? '<section class="stack"><h2>Past weeks</h2><div class="list">' + past.map((r) => '<div class="li" style="cursor:default"><span class="row between"><b>Week of ' + esc(C.fmtDateY(r.week)) + '</b><span class="mono small muted">energy ' + esc(r.energy || "—") + "/5</span></span>" + (r.wentWell ? '<span class="small">✓ ' + esc(r.wentWell) + "</span>" : "") + (r.nextFocus ? '<span class="small muted">→ ' + esc(r.nextFocus) + "</span>" : "") + "</div>").join("") + "</div></section>" : "") +
      "</div>"
    );
  };

  // ---------- PROFILE & DATA ----------
  VIEWS.backup = function () {
    let theme = "system";
    try { theme = localStorage.getItem("careercrumbs:theme") || "system"; } catch (e) {}
    const where = mode === "cloud" ? "Your workspace is saved to your claude.ai account. It's private to you and follows you to any device where you open this page." : mode === "local" ? "Your workspace is saved in this browser only. Export a backup regularly." : "You're viewing examples. Start your workspace to save anything.";
    return (
      '<div class="view">' + head("Settings for you", "Profile & data") +
      '<section class="card stack"><h2>Profile</h2>' + profileForm().replace('<div class="sheet-foot"><span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button>', '<div class="row">') + "</section>" +
      '<section class="card stack"><h2>Look</h2><div class="chips" role="group" aria-label="Theme">' + [["system", "Match device"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => '<button class="chip" data-act="theme" data-v="' + v + '" aria-pressed="' + (theme === v) + '">' + l + "</button>").join("") + "</div></section>" +
      '<section class="card stack"><h2>Your data</h2><p class="muted">' + esc(where) + "</p>" +
      '<div class="row"><button class="btn ghost" data-act="export">Export backup (.json)</button><label class="btn ghost" for="import-file">Import backup</label><input class="sr" id="import-file" type="file" accept="application/json,.json"><button class="btn ghost" data-act="brag">Brag doc</button></div>' +
      '<div data-import></div>' +
      '<div class="row" style="padding-top:8px;border-top:1px solid var(--line)"><button class="btn danger sm" data-act="ask-erase">Erase everything</button></div><div data-erase></div></section>' +
      '<p class="muted small">CareerCrumbs keeps your notes private. Nothing here is sent to DashMart, DoorDash or anyone else. Ruhv only sees what you choose to send when you tap an Ask Ruhv button.</p>' +
      "</div>"
    );
  };

  // ---------- sheets & toasts ----------
  function openSheet(title, body) {
    ui.sheetOpen = true;
    let host = $("#sheet");
    host.innerHTML = '<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(title) + '"><div class="sheet-grip"></div><div class="sheet-head"><h2>' + title + '</h2><button class="iconbtn" data-act="close" aria-label="Close">' + icon("close") + "</button></div>" + body + "</div></div>";
    host.hidden = false;
    document.body.style.overflow = "hidden";
    const first = host.querySelector("input:not([type=hidden]):not(.sr), textarea, select");
    if (first && window.matchMedia("(min-width: 700px)").matches) first.focus();
  }
  function closeSheet() {
    const host = $("#sheet");
    if (!host) return;
    host.innerHTML = "";
    host.hidden = true;
    document.body.style.overflow = "";
    ui.sheetOpen = false;
    if (aiAbort) aiAbort.abort();
    ui.pendingRender = false;
    render();
  }
  let toastTimer = null;
  function toast(msg, actLabel, actFn) {
    const host = $("#toast");
    host.innerHTML = '<div class="toast" role="status"><span>' + esc(msg) + "</span>" + (actLabel ? '<button type="button">' + esc(actLabel) + "</button>" : "") + "</div>";
    host.hidden = false;
    if (actLabel) host.querySelector("button").onclick = () => { host.hidden = true; actFn(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (host.hidden = true), actLabel ? 7000 : 3200);
  }
  function confirmIn(container, msg, label, fn) {
    const el = $(container);
    if (!el) return;
    el.innerHTML = '<div class="confirm"><p>' + esc(msg) + '</p><button type="button" class="btn sm ghost" data-act="cancel-confirm">Keep</button><button type="button" class="btn sm danger" data-confirm-go>' + esc(label) + "</button></div>";
    el.querySelector("[data-confirm-go]").onclick = fn;
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied");
      return true;
    } catch (e) {
      const ta = $("#f-dbody") || $("#bullet-text");
      if (ta) { ta.focus(); ta.select(); }
      toast("Copy didn't work here. The text is selected so you can copy it.");
      return false;
    }
  }
  async function saveFile(filename, data) {
    if (!downloads) {
      toast("Saving files isn't available here. Use Copy instead.");
      return;
    }
    try {
      await downloads.save({ filename, data });
      toast("Saved " + filename);
    } catch (e) {
      if (e && e.code !== "declined") toast("Couldn't save the file. Try Copy instead.");
    }
  }

  // ---------- Ask Ruhv (Claude, only on request) ----------
  let aiAbort = null;
  function aiBox(html) {
    const el = $("[data-ai]");
    if (el) el.innerHTML = html;
  }
  async function aiPolish(d) {
    if (!sample) return;
    const body = $("#f-dbody").value;
    aiAbort = new AbortController();
    aiBox('<div class="stack-s"><span class="ai-note">Ruhv is rewriting…</span><div class="out" data-ai-out>Thinking…</div></div>');
    const prompt =
      "You are Ruhv, a calm, practical career coach inside CareerCrumbs, an app for a warehouse supervisor at DashMart (DoorDash's own convenience and grocery stores) who wants a promotion to " + (ws.profile.targetRole || "operations manager") + ".\n\n" +
      "Rewrite the draft below (" + (C.DRAFT_KINDS[d.kind] || "draft") + ") so it is clear, confident and concise, in plain workplace English. Rules: keep every fact and number exactly as written; never add numbers, results or claims that aren't in the draft; keep [bracketed placeholders] as they are; keep the same sections; no emojis; no preamble — return only the rewritten text.\n\nDRAFT:\n" + body;
    try {
      const res = await sample(prompt, { signal: aiAbort.signal, modelTier: "default", cache: false, onText: ({ text }) => { const o = $("[data-ai-out]"); if (o) o.textContent = text; } });
      aiBox('<div class="stack-s"><span class="ai-note">Written by Ruhv (Claude). Check facts before you send it.</span><div class="out" data-ai-out>' + esc(res.text) + '</div><div class="row"><button class="btn sm brown" data-act="ai-use">Use this version</button><button class="btn sm ghost" data-act="ai-dismiss">Keep mine</button></div></div>');
      ui.aiText = res.text;
    } catch (e) {
      if (e && e.name === "AbortError") return;
      aiBox('<p class="small muted">' + (e && e.code === "rate_limited" ? "Ruhv needs a short break. Try again in a minute." : e && e.code === "not_granted" ? "Ruhv isn't switched on for this page." : "Ruhv couldn't answer just now.") + "</p>");
    }
  }
  async function aiPlan() {
    if (!sample) return;
    const r = C.readiness(ws);
    const gaps = r.gaps.slice(0, 4).map((g) => g.c.name + " (rated " + (g.c.rating || 0) + "/4, target " + g.c.target + ", " + g.ev + " wins logged)").join("; ");
    const existing = ws.plan.map((s) => s.text).join("; ");
    openSheet("Ruhv's suggestions", '<div class="sheet-body"><span class="ai-note">Asking Ruhv…</span><div data-ai></div></div>');
    aiAbort = new AbortController();
    try {
      const out = await sample.json(
        "You are Ruhv, a practical career coach for a " + ws.profile.role + " at DashMart (DoorDash's own convenience and grocery stores) working toward " + ws.profile.targetRole + ". Biggest gaps: " + (gaps || "none recorded") + ". Plan steps they already have: " + (existing || "none") + ".\n" +
        "Suggest 5 concrete, observable actions they can take in the next 90 days that would close these gaps and be visible to their manager. Each must be specific to running a dark-store warehouse shift (picking, INF, dasher handoff, inventory, labor, safety, team development). Don't repeat existing steps. Return JSON: [{\"text\": string (max 110 chars, starts with a verb), \"phase\": \"30\"|\"60\"|\"90\", \"why\": string (max 90 chars)}]",
        { signal: aiAbort.signal, modelTier: "default" }
      );
      const list = Array.isArray(out) ? out.filter((x) => x && x.text).slice(0, 6) : [];
      ui.aiPlan = list;
      $(".sheet-body").innerHTML = '<span class="ai-note">Written by Ruhv (Claude). Add the ones that fit.</span>' + (list.length ? '<div class="list">' + list.map((x, i) => '<div class="li" style="cursor:default"><span class="row between"><b>' + esc(x.text) + '</b><span class="pill">' + esc(x.phase || "30") + ' days</span></span><span class="small muted">' + esc(x.why || "") + '</span><span><button class="btn sm ghost" data-act="ai-plan-add" data-i="' + i + '">Add to plan</button></span></div>').join("") + "</div>" : '<p class="muted">No suggestions came back. Try again.</p>');
    } catch (e) {
      if (e && e.name === "AbortError") return;
      const b = $(".sheet-body");
      if (b) b.innerHTML = '<p class="muted">' + (e && e.code === "rate_limited" ? "Ruhv needs a short break. Try again in a minute." : "Ruhv couldn't answer just now.") + "</p>";
    }
  }

  // ---------- actions ----------
  function bulletSheet(w) {
    openSheet("Résumé bullet", '<div class="sheet-body"><span class="ai-note">Template · edit it to sound like you</span><label class="field" for="bullet-text"><span>Bullet</span><textarea class="textarea" id="bullet-text" rows="4">' + esc(C.bulletFromWin(w)) + '</textarea><small>Built from your own words and numbers. Placeholders in [brackets] mean something is missing.</small></label><div class="sheet-foot"><span class="grow"></span><button class="btn ghost" data-act="bullet-copy">' + icon("copy") + 'Copy</button><button class="btn brown" data-act="bullet-save" data-id="' + w.id + '">Add to résumé bullets</button></div></div>');
  }
  function bragSheet() {
    openSheet("Brag doc", '<div class="sheet-body"><p class="muted">Every win in a date range, written up with situation, action and result. Bring it to your review or promotion conversation.</p><div class="chips">' + [[30, "Last 30 days"], [90, "Last 90 days"], [182, "Last 6 months"], [365, "Last year"]].map(([n, l]) => '<button class="chip" data-act="brag-go" data-n="' + n + '">' + l + "</button>").join("") + "</div></div>");
  }

  const A = {
    more() {
      const groups = ["Track", "Lead", "Grow", "Look back"];
      openSheet("More", '<div class="stack">' + groups.map((g) => {
        const items = NAV.filter(([r, , gg]) => gg === g && !TABS.includes(r) && VIEWS[r]);
        return items.length ? '<div class="stack-s"><span class="eyebrow">' + esc(GROUP_LABEL[g]) + '</span><div class="more-grid">' + items.map(([r, l]) => '<a class="more-tile" href="#' + r + '" data-act="close-nav"' + (route === r ? ' aria-current="page"' : "") + ">" + icon(r) + "<span>" + esc(l) + "</span></a>").join("") + "</div></div>" : "";
      }).join("") + "</div>");
    },
    "close-nav"() { closeSheet(); },
    close() { closeSheet(); },
    scrim(el, ev) { if (ev.target === el) closeSheet(); },
    goto(el) { go(el.dataset.r); },
    "start-blank"() { startWorkspace(false); },
    "start-keep"() { startWorkspace(true); },
    "cancel-confirm"(el) { el.closest(".confirm").parentElement.innerHTML = ""; },

    "new-win"() { openSheet("Log a win", winForm()); },
    "edit-win"(el) { openSheet("Edit win", winForm(byId(ws.wins, el.dataset.id))); },
    bullet(el) { bulletSheet(byId(ws.wins, el.dataset.id)); },
    "bullet-copy"() { copyText($("#bullet-text").value); },
    "bullet-save"(el) {
      const text = $("#bullet-text").value.trim();
      if (!text) return;
      let d = ws.drafts.find((x) => x.kind === "bullet");
      if (!d) d = addDraft("bullet", "Résumé bullets", "");
      const line = "• " + text;
      if (!(d.body || "").split("\n").includes(line)) d.body = (d.body ? d.body + "\n" : "") + line;
      d.updated = new Date().toISOString();
      const w = byId(ws.wins, el.dataset.id);
      if (w) w.onResume = true;
      closeSheet();
      save("drafts", "wins");
      toast("Added to your résumé bullets", "Open", () => { go("drafts"); openDraft(d); });
    },
    brag() { bragSheet(); },
    "brag-go"(el) {
      const n = Number(el.dataset.n);
      const d = addDraft("brag", "Brag doc · last " + n + " days", C.bragDoc(ws, C.addDays(t0(), -n + 1), t0()));
      closeSheet();
      go("drafts");
      openDraft(d);
    },
    "comp-wins"(el) { ui.winComp = el.dataset.id; ui.winQ = ""; go("wins"); },

    "new-kpi"() { openSheet("Add metric", kpiForm()); },
    "add-preset"(el) {
      const p = C.KPI_PRESETS[el.dataset.i];
      ws.kpis.push({ id: C.uid("k"), name: p.name, unit: p.unit, better: p.better, target: null, entries: [] });
      save("kpis");
      toast("Added " + p.name + ". Tap it to set a target.");
    },
    "fill-preset"(el) {
      const p = C.KPI_PRESETS[el.dataset.i];
      const f = el.closest("form");
      f.name.value = p.name;
      f.unit.value = p.unit;
      f.better.value = p.better;
      f.target.focus();
    },
    kpi(el) {
      const k = byId(ws.kpis, el.dataset.id);
      const rows = (k.entries || []).slice().sort((a, b) => (a.week < b.week ? 1 : -1));
      openSheet(esc(k.name), '<div class="sheet-body">' + sparkSvg(k, 26, true) +
        (rows.length ? '<div class="scroll-x"><table class="matrix" style="width:100%"><thead><tr><th>Week of</th><th>Value</th><th>Note</th><th></th></tr></thead><tbody>' + rows.map((e) => '<tr><td class="mono">' + esc(C.fmtDateY(e.week)) + '</td><td class="mono">' + esc(C.fmtNum(C.num(e.value), k.unit)) + '</td><td style="white-space:normal;text-align:left">' + esc(e.note || "") + '</td><td><button class="iconbtn" aria-label="Delete entry" data-act="kpi-del-entry" data-id="' + k.id + '" data-w="' + e.week + '">' + icon("close") + "</button></td></tr>").join("") + "</tbody></table></div>" : '<p class="muted">No entries yet.</p>') +
        '<div class="row"><button class="btn sm ghost" data-act="kpi-paste" data-id="' + k.id + '">Paste history from a spreadsheet</button></div>' +
        "<h3>Settings</h3>" + kpiForm(k) + "</div>");
    },
    "kpi-del-entry"(el) {
      const k = byId(ws.kpis, el.dataset.id);
      k.entries = k.entries.filter((e) => e.week !== el.dataset.w);
      save("kpis");
      A.kpi(el);
    },
    "log-week"() {
      if (!ws.kpis.length) {
        go("metrics");
        toast("Pick the metrics you own first.");
        return;
      }
      openSheet("Log the numbers", logWeekForm(C.weekOf(t0())));
    },

    "edit-profile"() { openSheet("Your target", profileForm()); },
    rate(el) {
      const c = byId(ws.competencies, el.dataset.id);
      c.rating = Number(el.dataset.v);
      save("competencies");
    },
    "edit-comps"() {
      openSheet("Competencies", '<form data-form="comps">' + fieldText("list", "One per line: name | what good looks like", ws.competencies.map((c) => c.name + " | " + (c.desc || "")).join("\n"), { area: true, rows: 12, hint: "Use your company's leveling guide if you have one. Ratings stay with names you keep." }) + '<div class="sheet-foot"><button type="button" class="btn ghost sm" data-act="comps-reset">Reset to defaults</button><span class="grow"></span><button class="btn brown">Save</button></div></form>');
    },
    "comps-reset"() { $("#f-list").value = C.COMPETENCY_PRESET.map(([n, d]) => n + " | " + d).join("\n"); },
    "plan-del"(el) { ws.plan = ws.plan.filter((s) => s.id !== el.dataset.id); save("plan"); },
    "ai-plan"() { aiPlan(); },
    "ai-plan-add"(el) {
      const x = ui.aiPlan[el.dataset.i];
      ws.plan.push({ id: C.uid("p"), phase: ["30", "60", "90"].includes(String(x.phase)) ? String(x.phase) : "30", text: x.text, done: false });
      el.disabled = true;
      el.textContent = "Added";
      save("plan");
    },
    "gen-case"() {
      const d = addDraft("case", "Promotion case · " + C.fmtDateY(t0()), C.promotionCase(ws));
      go("drafts");
      openDraft(d);
    },
    "gen-update"() {
      const d = addDraft("update", "Weekly update · " + C.fmtDate(C.addDays(t0(), -6)) + "–" + C.fmtDate(t0()), C.weeklyUpdate(ws));
      go("drafts");
      openDraft(d);
    },

    "new-project"() { openSheet("New project", projectForm()); },
    "edit-project"(el) { openSheet("Edit project", projectForm(byId(ws.projects, el.dataset.id))); },
    "proj-filter"(el) { ui.projFilter = el.dataset.v; render(); },
    "proj-win"(el) {
      const p = byId(ws.projects, el.dataset.id);
      openSheet("Log a win", winForm(null, { title: p.title, action: p.title, result: p.result || "", situation: p.impact || "" }));
    },

    "new-member"() { openSheet("Add a person", memberForm()); },
    member(el) {
      const m = byId(ws.team, el.dataset.id);
      const notes = sortDesc(m.notes || [], "date");
      openSheet(esc(m.name), '<div class="sheet-body">' + (notes.length ? '<div class="timeline">' + notes.map((n) => '<div><span class="pill ' + (n.type === "Recognition" ? "brown" : "") + '">' + esc(n.type) + '</span> <span class="mono small muted">' + esc(C.fmtDateY(n.date)) + '</span><p>' + esc(n.text) + '</p><button class="linkbtn small" data-act="note-del" data-id="' + m.id + '" data-n="' + n.id + '">Delete</button></div>').join("") + "</div>" : '<p class="muted">No notes yet.</p>') + "<h3>Details</h3>" + memberForm(m) + "</div>");
    },
    "note-del"(el) {
      const m = byId(ws.team, el.dataset.id);
      m.notes = m.notes.filter((n) => n.id !== el.dataset.n);
      save("team");
      A.member(el);
    },
    note(el) { openSheet("Log a note", noteForm(byId(ws.team, el.dataset.id))); },
    agenda(el) {
      const m = byId(ws.team, el.dataset.id);
      const d = addDraft("oneonone", "1:1 · " + m.name + " · " + C.fmtDate(t0()), C.oneOnOneAgenda(m, ws));
      go("drafts");
      openDraft(d);
    },
    lvl(el) {
      const m = byId(ws.team, el.dataset.id);
      m.training = Object.assign({}, m.training);
      m.training[el.dataset.s] = ((m.training[el.dataset.s] || 0) + 1) % 4;
      save("team");
    },
    "edit-stations"() {
      openSheet("Stations", '<form data-form="stations">' + fieldText("list", "One station per line", ws.stations.join("\n"), { area: true, rows: 8, hint: "Training levels stay with stations you keep." }) + '<div class="sheet-foot"><span class="grow"></span><button class="btn brown">Save</button></div></form>');
    },

    "new-person"() { openSheet("Add a person", personForm()); },
    "edit-person"(el) { openSheet("Edit", personForm(byId(ws.people, el.dataset.id))); },
    touch(el) { openSheet("Log a touchpoint", touchForm(byId(ws.people, el.dataset.id))); },

    "new-job"() { openSheet("Add an opening", jobForm()); },
    "edit-job"(el) { openSheet("Opening", jobForm(byId(ws.jobs, el.dataset.id))); },
    "job-filter"(el) { ui.jobFilter = el.dataset.v; render(); },

    "new-draft"() {
      openSheet("New draft", '<div class="list">' + [["gen-update", "Weekly update", "From this week's wins, numbers and projects"], ["gen-case", "Promotion case", "Your evidence, competency by competency"], ["brag", "Brag doc", "Every win in a date range"], ["blank-draft", "Blank", "Start from nothing"]].map(([a, t, s]) => '<button class="li" data-act="' + a + '"><b>' + t + '</b><span class="muted small">' + s + "</span></button>").join("") + "</div>");
    },
    "blank-draft"() {
      const d = addDraft("other", "Untitled draft", "");
      go("drafts");
      openDraft(d);
    },
    "draft-kind"(el) { ui.draftKind = el.dataset.v; render(); },
    "open-draft"(el) { openDraft(byId(ws.drafts, el.dataset.id)); },
    "copy-draft"() { copyText($("#f-dbody").value); },
    "download-draft"(el) {
      const d = byId(ws.drafts, el.dataset.id);
      saveFile((d.title || "draft").replace(/[^\w\- ·.]+/g, "").replace(/\s+/g, "-").slice(0, 60) + ".md", $("#f-dbody").value);
    },
    "ai-polish"(el) { aiPolish(byId(ws.drafts, el.dataset.id)); },
    "ai-use"() {
      const ta = $("#f-dbody");
      ta.value = ui.aiText || ta.value;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      aiBox("");
      toast("Draft updated");
    },
    "ai-dismiss"() { aiBox(""); },

    energy(el) {
      const f = el.closest("form");
      f.querySelectorAll("[data-act=energy]").forEach((b) => b.setAttribute("aria-pressed", String(b === el)));
      f.querySelector('input[name=energy][value="' + el.dataset.v + '"]').checked = true;
    },

    theme(el) {
      try { localStorage.setItem("careercrumbs:theme", el.dataset.v); } catch (e) {}
      applyTheme();
      render();
    },
    export() {
      saveFile("careercrumbs-backup-" + t0() + ".json", JSON.stringify(Object.assign({ app: "CareerCrumbs", exported: new Date().toISOString() }, ws), null, 2));
    },
    "ask-erase"() {
      confirmIn("[data-erase]", "This deletes every win, number, note and draft. Export a backup first if you might want it.", "Erase everything", async () => {
        ws = C.emptyWorkspace();
        if (mode === "example") mode = db ? "cloud" : "local";
        await saveAllNow();
        render();
        toast("Workspace erased");
      });
    },
    "ask-del"(el) {
      const kind = el.dataset.kind, id = el.dataset.id;
      const map = Object.assign({ win: ["wins", "this win"], kpi: ["kpis", "this metric and all its entries"], project: ["projects", "this project"], member: ["team", "this person and their notes"], person: ["people", "this person"], job: ["jobs", "this opening"], draft: ["drafts", "this draft"] }, FX.deletable || {});
      const [key, what] = map[kind];
      const host = el.closest(".sheet").querySelector("[data-confirm]");
      host.setAttribute("data-confirm-host", "1");
      confirmIn("[data-confirm-host]", "Delete " + what + "?", "Delete", () => {
        const idx = ws[key].findIndex((x) => x.id === id);
        const removed = ws[key][idx];
        ws[key] = ws[key].filter((x) => x.id !== id);
        closeSheet();
        save(key);
        toast("Deleted", "Undo", () => {
          ws[key].splice(Math.min(idx, ws[key].length), 0, removed);
          save(key);
          toast("Restored");
        });
      });
    },
  };

  // change handlers for inline selects/checkboxes
  const CH = {
    target(el) {
      byId(ws.competencies, el.dataset.id).target = Number(el.value);
      save("competencies");
    },
    "plan-done"(el) {
      byId(ws.plan, el.dataset.id).done = el.checked;
      save("plan");
      if (el.checked) toast("Step done. Worth mentioning in your next update.");
    },
    ms(el) {
      const p = byId(ws.projects, el.dataset.id);
      p.milestones[el.dataset.i].done = el.checked;
      p.updated = new Date().toISOString();
      save("projects");
    },
    "job-status"(el) {
      const i = ws.jobs.findIndex((j) => j.id === el.dataset.id);
      ws.jobs[i] = C.setJobStatus(ws.jobs[i], el.value);
      save("jobs");
    },
  };

  // form submit handlers
  const val = (f, n) => (f.elements[n] ? String(f.elements[n].value || "").trim() : "");
  const F = {
    win(f) {
      const id = f.dataset.id;
      const data = {
        title: val(f, "title"), date: val(f, "date") || t0(), situation: val(f, "situation"), action: val(f, "action"), result: val(f, "result"),
        metric: val(f, "mlabel") ? { label: val(f, "mlabel"), before: val(f, "mbefore"), after: val(f, "mafter"), unit: val(f, "munit") } : null,
        competencies: [...f.querySelectorAll("input[name=comp]:checked")].map((i) => i.value),
        updated: new Date().toISOString(),
      };
      if (id) Object.assign(byId(ws.wins, id), data);
      else {
        ws.winSeq = (ws.winSeq || 0) + 1;
        ws.wins.push(Object.assign({ id: C.uid("w"), n: ws.winSeq, created: data.updated }, data));
      }
      closeSheet();
      save("wins", "winSeq");
      toast(id ? "Win updated" : "Win logged. That's another crumb on the trail.");
    },
    kpi(f) {
      const id = f.dataset.id;
      const data = { name: val(f, "name"), unit: val(f, "unit"), target: C.num(val(f, "target")), better: val(f, "better") };
      if (id) Object.assign(byId(ws.kpis, id), data);
      else ws.kpis.push(Object.assign({ id: C.uid("k"), entries: [] }, data));
      closeSheet();
      save("kpis");
    },
    logweek(f) {
      const wk = C.weekOf(val(f, "week") || t0());
      let n = 0;
      for (const k of ws.kpis) {
        const v = val(f, "k_" + k.id);
        const others = (k.entries || []).filter((e) => e.week !== wk);
        if (v !== "" && C.num(v) !== null) {
          others.push({ week: wk, value: C.num(v), loggedAt: t0() });
          n++;
        }
        k.entries = others.sort((a, b) => (a.week < b.week ? -1 : 1)).slice(-156);
      }
      closeSheet();
      save("kpis");
      toast("Logged " + plural(n, "number") + " for the week of " + C.fmtDate(wk));
    },
    profile(f) {
      for (const k of ["name", "role", "company", "site", "targetRole", "targetDate", "why"]) ws.profile[k] = val(f, k);
      if (f.closest(".sheet")) closeSheet();
      save("profile");
      toast("Profile saved");
    },
    comps(f) {
      const prev = ws.competencies;
      ws.competencies = val(f, "list").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 20).map((l, i) => {
        const [name, desc] = l.split("|").map((s) => s.trim());
        const old = prev.find((c) => c.name.toLowerCase() === name.toLowerCase());
        return old ? Object.assign({}, old, { name, desc: desc || "" }) : { id: C.uid("c"), name, desc: desc || "", rating: 0, target: 3, notes: "" };
      });
      closeSheet();
      save("competencies");
    },
    plan(f) {
      ws.plan.push({ id: C.uid("p"), phase: f.dataset.phase, text: val(f, "text"), due: val(f, "due"), done: false });
      save("plan");
    },
    project(f) {
      const id = f.dataset.id;
      const old = id ? byId(ws.projects, id) : null;
      const prevMs = (old && old.milestones) || [];
      const milestones = val(f, "milestones").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        const done = /^\[x\]\s*/i.test(l);
        const text = l.replace(/^\[[x ]?\]\s*/i, "");
        const was = prevMs.find((m) => m.text === text);
        return { text, done: done || (was ? was.done && !/^\[ \]/.test(l) : false) };
      });
      const data = { title: val(f, "title"), status: val(f, "status"), due: val(f, "due"), impact: val(f, "impact"), nextAction: val(f, "nextAction"), blocker: val(f, "blocker"), stakeholders: val(f, "stakeholders"), result: val(f, "result"), milestones, updated: new Date().toISOString() };
      const becameDone = data.status === "Done" && (!old || old.status !== "Done");
      if (old) Object.assign(old, data);
      else ws.projects.push(Object.assign({ id: C.uid("pr"), created: data.updated }, data));
      closeSheet();
      save("projects");
      if (becameDone) {
        const p = old || ws.projects[ws.projects.length - 1];
        toast("Project done. Log it as a win?", "Log win", () => A["proj-win"]({ dataset: { id: p.id } }));
      }
    },
    member(f) {
      const id = f.dataset.id;
      const data = { name: val(f, "name"), role: val(f, "role"), shift: val(f, "shift"), growth: val(f, "growth") };
      if (id) Object.assign(byId(ws.team, id), data);
      else ws.team.push(Object.assign({ id: C.uid("t"), notes: [], training: {} }, data));
      closeSheet();
      save("team");
    },
    note(f) {
      const m = byId(ws.team, f.dataset.id);
      m.notes = (m.notes || []).concat([{ id: C.uid("n"), type: val(f, "type"), date: val(f, "date") || t0(), text: val(f, "text") }]);
      closeSheet();
      save("team");
      toast(val(f, "type") === "Recognition" ? "Recognition logged. Did you also tell them?" : "Note saved");
    },
    stations(f) {
      ws.stations = [...new Set(val(f, "list").split("\n").map((s) => s.trim()).filter(Boolean))].slice(0, 16);
      closeSheet();
      save("stations");
    },
    person(f) {
      const id = f.dataset.id;
      const data = { name: val(f, "name"), relation: val(f, "relation"), role: val(f, "role"), cadenceDays: Number(val(f, "cadenceDays")) || 14, notes: val(f, "notes") };
      if (id) Object.assign(byId(ws.people, id), data);
      else ws.people.push(Object.assign({ id: C.uid("s"), touches: [] }, data));
      closeSheet();
      save("people");
    },
    touch(f) {
      const p = byId(ws.people, f.dataset.id);
      p.touches = (p.touches || []).concat([{ date: val(f, "date") || t0(), kind: val(f, "kind"), note: val(f, "note") }]).slice(-100);
      closeSheet();
      save("people");
      toast("Touchpoint logged with " + p.name);
    },
    job(f) {
      const id = f.dataset.id;
      const data = { title: val(f, "title"), company: val(f, "company"), internal: f.elements.internal.checked, link: val(f, "link"), nextStep: val(f, "nextStep"), followUpAt: val(f, "followUpAt"), notes: val(f, "notes") };
      const status = val(f, "status");
      if (id) {
        const i = ws.jobs.findIndex((j) => j.id === id);
        let j = Object.assign({}, ws.jobs[i], data);
        if (status !== j.status) j = C.setJobStatus(j, status);
        ws.jobs[i] = j;
      } else ws.jobs.push(C.setJobStatus(Object.assign({ id: C.uid("j"), created: t0(), history: [] }, data), status));
      closeSheet();
      save("jobs");
    },
    review(f) {
      const wk = f.dataset.week;
      const data = { week: wk, wentWell: val(f, "wentWell"), stuck: val(f, "stuck"), nextFocus: val(f, "nextFocus"), energy: Number((f.querySelector("input[name=energy]:checked") || {}).value) || null };
      const i = ws.reviews.findIndex((r) => r.week === wk);
      if (i >= 0) Object.assign(ws.reviews[i], data);
      else ws.reviews.push(Object.assign({ id: C.uid("r"), created: t0() }, data));
      save("reviews");
      toast("Review saved. Have a good weekend.");
    },
  };

  // ---------- feature modules (src/features.js) ----------
  const FX = {};
  const api = {
    get ws() { return ws; },
    get sample() { return sample; },
    get downloads() { return downloads; },
    get route() { return route; },
    get mode() { return mode; },
    ui, esc, icon, ruhv, fieldText, fieldSelect, head, plural, byId, sortDesc, t0,
    save, persist, render, go, openSheet, closeSheet, toast, confirmIn, copyText, saveFile,
    addDraft, openDraft, winForm, winTicket, readinessCard, sparkSvg,
    actions: A, changes: CH, forms: F, views: VIEWS,
  };
  FX.homeTop = [];
  FX.homeBottom = [];
  FX.deletable = {};
  for (const install of window.CCFeatureList || []) {
    const r = install(api) || {};
    if (r.homeTop) FX.homeTop.push(r.homeTop);
    if (r.homeBottom) FX.homeBottom.push(r.homeBottom);
    Object.assign(FX.deletable, r.deletable || {});
  }

  // ---------- wiring ----------
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-act]");
    if (!el || !A[el.dataset.act]) return;
    if (el.tagName === "A" && el.dataset.act !== "close-nav") ev.preventDefault();
    A[el.dataset.act](el, ev);
  });
  document.addEventListener("change", (ev) => {
    const el = ev.target;
    if (el.dataset && el.dataset.actChange && CH[el.dataset.actChange]) CH[el.dataset.actChange](el);
    if (el.id === "import-file" && el.files && el.files[0]) importFile(el.files[0]);
  });
  document.addEventListener("submit", (ev) => {
    const f = ev.target;
    if (!f.dataset || !F[f.dataset.form]) return;
    ev.preventDefault();
    F[f.dataset.form](f);
  });
  let draftTimer = null;
  document.addEventListener("input", (ev) => {
    const el = ev.target;
    if (el.dataset && el.dataset.bind) {
      ui[el.dataset.bind] = el.value;
      const pos = el.selectionStart;
      render();
      const again = document.getElementById(el.id);
      if (again) {
        again.focus();
        if (pos != null && again.setSelectionRange) again.setSelectionRange(pos, pos);
      }
      return;
    }
    const host = el.closest && el.closest("[data-draft]");
    if (host) {
      const d = byId(ws.drafts, host.dataset.draft);
      if (!d) return;
      if (el.id === "f-dbody") {
        d.body = el.value;
        host.querySelector("[data-count]").textContent = el.value.length + " chars";
      }
      if (el.id === "f-dtitle") d.title = el.value || "Untitled draft";
      d.updated = new Date().toISOString();
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => {
        if (mode === "example") return;
        dirty.add("drafts");
        setSync("saving");
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, 100);
        ui.pendingRender = true;
      }, 700);
    }
  });
  document.addEventListener("change", (ev) => {
    if (ev.target.dataset && ev.target.dataset.bind) {
      ui[ev.target.dataset.bind] = ev.target.value;
      render();
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && ui.sheetOpen) closeSheet();
  });

  function importFile(file) {
    const r = new FileReader();
    r.onload = () => {
      let data;
      try {
        data = JSON.parse(r.result);
      } catch (e) {
        toast("That file isn't a CareerCrumbs backup (it isn't valid JSON).");
        return;
      }
      const next = C.normalize(data);
      const summary = plural(next.wins.length, "win") + ", " + plural(next.kpis.length, "metric") + ", " + plural(next.drafts.length, "draft");
      $("[data-import]").innerHTML = '<div class="confirm"><p>Replace everything with this backup (' + esc(summary) + ")?</p><button type=\"button\" class=\"btn sm ghost\" data-act=\"cancel-confirm\">Cancel</button><button type=\"button\" class=\"btn sm danger\" data-confirm-go>Replace</button></div>";
      $("[data-import] [data-confirm-go]").onclick = async () => {
        ws = next;
        if (mode === "example") mode = db ? "cloud" : "local";
        await saveAllNow();
        render();
        toast("Backup restored");
      };
    };
    r.readAsText(file);
  }
  function applyTheme() {
    let t = "system";
    try { t = localStorage.getItem("careercrumbs:theme") || "system"; } catch (e) {}
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  }

  boot();
})();
