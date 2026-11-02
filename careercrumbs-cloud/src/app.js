// CareerCrumbs UI: Home, Jobs, Interview, Stories, Me. Renders HTML strings, handles events by delegation.
(function () {
  "use strict";
  const C = window.CC;
  const $ = (s, el) => (el || document).querySelector(s);

  // ---------- state ----------
  let ws = C.emptyWorkspace();
  let mode = "loading"; // loading | local
  let syncState = "idle";
  let route = "home";
  const ui = { jobFilter: "Active", pack: "all", prepJob: null, sheetOpen: false };

  // ---------- Ruhv & icons ----------
  // Ruhv, the CareerCrumbs mouse: one solid shape in currentColor; the eye and smile are cut-outs.
  const RUHV =
    '<ellipse cx="176" cy="152" rx="17" ry="22" transform="rotate(-14 176 152)"/><circle cx="219" cy="159" r="15"/><circle cx="272" cy="197" r="6"/>' +
    '<path fill-rule="evenodd" d="M150 287 C148 246 152 206 166 182 C172 170 186 164 204 166 C222 168 240 174 254 184 L268 193 L271 202 C259 206 248 213 240 221 C230 232 231 250 252 285 C222 293 182 293 150 287 Z M226 187 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 Z M233 206 Q242 217 252 207 Q242 213 233 206 Z"/>';
  const ruhv = (cls) => '<svg class="' + cls + '" viewBox="140 124 144 172" fill="currentColor" aria-hidden="true">' + RUHV + "</svg>";
  const P = {
    home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
    jobs: "M20 7H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1zM16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2",
    interview: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM8 9h8M8 13h5",
    stories: "M4 4h11l5 5v11H4zM15 4v5h5M8 13h8M8 17h5",
    me: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
    plus: "M12 5v14M5 12h14",
    chev: "M9 6l6 6-6 6",
    close: "M6 6l12 12M18 6 6 18",
    copy: "M9 9h11v11H9zM5 15H4V4h11v1",
    edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
    play: "M7 4l13 8-13 8z",
    bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  };
  const icon = (n) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + P[n] + '"/></svg>';
  const NAV = [["home", "Home"], ["jobs", "Jobs"], ["interview", "Interview"], ["stories", "Stories"], ["me", "Me"]];
  const TABS = ["home", "jobs", "interview", "stories"];

  // ---------- small helpers ----------
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const t0 = () => C.today();
  const byId = (arr, id) => arr.find((x) => x.id === id);
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const qById = (id) => C.bankFor(ws).find((q) => q.id === id);
  const field = (name, label, val, o) => {
    o = o || {};
    const attrs = ' id="f-' + name + '" name="' + name + '"' + (o.req ? " required" : "") + ' placeholder="' + esc(o.ph || "") + '"';
    const tag = o.area ? '<textarea class="textarea"' + attrs + ' rows="' + (o.rows || 3) + '">' + esc(val) + "</textarea>" : '<input class="input"' + attrs + ' type="' + (o.type || "text") + '" value="' + esc(val) + '">';
    return '<label class="field" for="f-' + name + '"><span>' + esc(label) + "</span>" + tag + (o.hint ? "<small>" + esc(o.hint) + "</small>" : "") + "</label>";
  };
  const select = (name, label, val, opts) =>
    '<label class="field" for="f-' + name + '"><span>' + esc(label) + '</span><select class="select" id="f-' + name + '" name="' + name + '">' +
    opts.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return '<option value="' + esc(v) + '"' + (String(v) === String(val) ? " selected" : "") + ">" + esc(l) + "</option>"; }).join("") + "</select></label>";
  const head = (eyebrow, title, right) => '<div class="view-head"><div><span class="eyebrow">' + esc(eyebrow) + "</span><h1>" + esc(title) + "</h1></div>" + (right ? '<div class="row">' + right + "</div>" : "") + "</div>";
  const foot = (delKind, id, label) => '<div class="sheet-foot">' + (id ? '<button type="button" class="btn danger sm" data-act="ask-del" data-kind="' + esc(delKind) + '" data-id="' + esc(id) + '">Delete</button>' : "") + '<span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">' + (label || "Save") + '</button></div><div data-confirm></div>';
  const jobOptions = () => [["", "Any job"]].concat(ws.jobs.filter((j) => j.status !== "Closed").map((j) => [j.id, j.title + " · " + j.company]));
  const STATUS_PILL = { none: ["", "Not started"], draft: ["warn", "Draft"], ready: ["solid", "Ready"] };

  // ---------- persistence ----------
  // Everything lives in this device's storage under one key.
  const LS_KEY = "careercrumbs:v2";
  const dirty = new Set();
  let flushTimer = null, flushing = false;

  // Everything saves on its own; there is no account or setup step.
  function persist(...keys) {
    if (!keys.includes("profile") || keys.length > 1) ws.profile.changesSinceExport = (ws.profile.changesSinceExport || 0) + 1;
    dirty.add("ws");
    setSync("saving");
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 500);
  }
  function save(...keys) {
    persist(...keys);
    render();
  }
  async function flush() {
    if (flushing) return void (flushTimer = setTimeout(flush, 300));
    flushing = true;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(ws));
      dirty.clear();
      setSync("saved");
    } catch (e) {
      // Browsers throw a DOMException named QuotaExceededError (code 22).
      // Changes stay marked unsaved, so the next edit or leaving the app tries again.
      setSync("error");
      const full = e && (e.name === "QuotaExceededError" || e.code === 22);
      if (full) {
        ws.interview.practice = ws.interview.practice.slice(-100);
        toast("Your phone's storage for CareerCrumbs is full. Export a backup, then delete old jobs.", "Export", () => A.export());
      } else toast("Couldn't save just now. Your changes are still on screen and we'll try again.");
    } finally {
      flushing = false;
    }
  }
  function setSync(s) {
    syncState = s;
    const label = mode === "loading" ? "Loading" : s === "saving" ? "Saving…" : s === "error" ? "Not saved" : "Saved on this device";
    document.querySelectorAll(".sync").forEach((el) => {
      el.dataset.s = s;
      el.title = label;
      el.innerHTML = '<i></i><span class="sync-t">' + esc(label) + "</span>";
    });
  }
  async function boot() {
    applyTheme();
    window.addEventListener("hashchange", onHash);
    onHash(true);
    render();
    let loaded = null;
    let corrupt = false;
    let raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) {}
    if (raw) {
      try {
        loaded = JSON.parse(raw);
      } catch (e) {
        // Keep the unreadable copy instead of overwriting it on the next save.
        corrupt = true;
        try { localStorage.setItem(LS_KEY + ":corrupt-" + t0(), raw); } catch (e2) {}
      }
    }
    // Ask the browser not to evict this site's storage when space runs low.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    ws = C.normalize(loaded || {});
    mode = "local";
    setSync("saved");
    render();
    if (corrupt) toast("Some saved data couldn't be read. A copy was kept on this device; import a backup if you have one.");
    // Home-screen shortcuts open the app with ?go=practice or ?go=new-job.
    const go = new URLSearchParams(location.search).get("go");
    if (go === "practice" || go === "new-job") {
      history.replaceState(history.state, "", location.pathname + location.hash);
      curHref = location.href;
      A[go]();
    }
    registerOffline();
  }
  // Standalone website only: cache the app for offline use and offer new versions.
  function registerOffline() {
    if (native || !("serviceWorker" in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register("sw.js").then((reg) => {
      const offer = (w) => toast("A new version of CareerCrumbs is ready.", "Update", () => w.postMessage("skip-waiting"));
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w && w.addEventListener("statechange", () => w.state === "installed" && navigator.serviceWorker.controller && offer(w));
      });
    }).catch(() => {});
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloaded) return;
      reloaded = true;
      saveNow();
      location.reload();
    });
  }
  // Android can close the app any time it's in the background, so write pending changes right away.
  function saveNow() {
    if (!dirty.size) return;
    clearTimeout(flushTimer);
    flush();
  }
  document.addEventListener("visibilitychange", () => document.hidden && saveNow());
  window.addEventListener("pagehide", saveNow);

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
    const title = NAV.find((n) => n[0] === route)[1];
    let body;
    try {
      body = mode === "loading" ? '<div class="loading">' + ruhv("ruhv-hero") + "<span>Opening CareerCrumbs…</span></div>" : V[route]();
    } catch (e) {
      body = recoveryScreen(e);
    }
    const y = window.scrollY;
    const focusKey = keyOf(document.activeElement);
    app.innerHTML =
      '<nav class="rail" aria-label="Sections"><a class="brand" href="#home">' + ruhv("brand-mark") + "CareerCrumbs</a>" +
      NAV.map(([r, l]) => '<a href="#' + r + '"' + (route === r ? ' aria-current="page"' : "") + ">" + icon(r) + esc(l) + "</a>").join("") + '<span class="sync"></span></nav>' +
      '<main class="main"><header class="topbar"><a class="brand" href="#home" aria-label="CareerCrumbs home">' + ruhv("brand-mark") + '</a><span class="eyebrow">' + esc(title) + '</span><span class="sync"></span><a class="iconbtn top-me" href="#me" aria-label="Me and my data"' + (route === "me" ? ' aria-current="page"' : "") + ">" + icon("me") + "</a></header>" +
      body.replace(/<div class="empty"><b>/g, '<div class="empty">' + ruhv("ruhv-empty") + "<b>") + "</main>" +
      '<nav class="tabbar" aria-label="Main">' + TABS.map((r) => '<a class="tab" href="#' + r + '"' + (route === r ? ' aria-current="page"' : "") + ">" + icon(r) + "<span>" + esc(NAV.find((n) => n[0] === r)[1]) + "</span></a>").join("") + "</nav>";
    window.scrollTo(0, y);
    setSync(syncState);
    if (focusKey && !ui.sheetOpen) refocus(focusKey);
  }
  // Re-rendering replaces the page, so put keyboard focus back on the same control.
  function keyOf(el) {
    if (!el || el === document.body || !app().contains(el)) return null;
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.dataset && el.dataset.act) return '[data-act="' + CSS.escape(el.dataset.act) + '"]' + (el.dataset.id ? '[data-id="' + CSS.escape(el.dataset.id) + '"]' : "") + (el.dataset.v ? '[data-v="' + CSS.escape(el.dataset.v) + '"]' : "");
    return null;
  }
  function refocus(sel) {
    const el = $(sel);
    if (el) el.focus({ preventScroll: true });
  }
  const app = () => $("#app");
  function recoveryScreen(e) {
    return '<div class="view"><section class="card stack"><h2>Something went wrong showing this page</h2><p class="muted">Your data is still saved on this device. Save a copy, then try again. If it keeps happening, reset the app and import your copy.</p><p class="small muted mono">' + esc(String(e && e.message || e)) + '</p><div class="row"><button class="btn brown" data-act="export-raw">Save my data</button><button class="btn ghost" data-act="retry">Try again</button><button class="btn danger" data-act="ask-reset">Reset the app</button></div><div data-reset></div></section></div>';
  }
  const V = {};

  // ---------- HOME ----------
  V.home = function () {
    const p = ws.profile;
    const nx = C.nextInterview(ws);
    const items = C.todo(ws);
    const qs = C.bankFor(ws, ["common", "behavioral"].concat(p.packs || []));
    const r = C.readiness(ws, qs);
    const nextQ = qs.find((q) => q.pack !== "ask" && C.status(ws, q.id) === "none");
    const count = (s) => ws.jobs.filter((j) => j.status === s).length;
    const h = new Date().getHours();
    const fresh = C.isFresh(ws);
    if (fresh) {
      return (
        '<div class="view">' + head("No sign-up, nothing to set up", "Let's get you hired") +
        '<section class="card dark welcome">' + ruhv("ruhv-welcome") + "<p>Pick any place to start. Everything saves as you go, and you can come back anytime.</p></section>" +
        '<div class="starts">' +
        '<button class="start" data-act="answer" data-id="c1"><span><span class="eyebrow">About 2 minutes</span><b>Answer “Tell me about yourself”</b><small>Almost every interview starts with it. We show you an example first.</small></span>' + icon("chev") + "</button>" +
        '<button class="start" data-act="new-job"><span><span class="eyebrow">30 seconds</span><b>Add a job you applied for</b><small>Just the title and company. We\'ll remind you to follow up.</small></span>' + icon("chev") + "</button>" +
        '<button class="start" data-act="practice"><span><span class="eyebrow">5 minutes</span><b>Practise 5 interview questions</b><small>Say your answers out loud with a timer.</small></span>' + icon("chev") + "</button>" +
        "</div></div>"
      );
    }
    return (
      '<div class="view">' + head(C.fmtDateY(t0()) + (p.targetRole ? " · going for " + p.targetRole : ""), (h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening") + (p.name ? ", " + C.firstName(p.name) : "")) +
      (nx
        ? '<section class="card dark stack"><span class="eyebrow">Next interview · ' + esc(C.relDays(nx.interviewAt)) + "</span><h2>" + esc(nx.title) + "</h2><p>" + esc(nx.company) + " · " + esc(C.fmtWhen(nx.interviewAt)) + (nx.contact ? " · with " + esc(nx.contact) : "") + '</p><div class="row"><button class="btn brown" data-act="prep" data-id="' + esc(nx.id) + '">Prepare for it</button><button class="btn ghost" data-act="cheat" data-id="' + esc(nx.id) + '">Cheat sheet</button></div></section>'
        : '<section class="card dark stack"><span class="eyebrow">No interview booked yet</span><h2>Get ready before the call comes</h2><p>Most people only practise after they get the interview. Write your answers now and you\'ll walk in calm.</p><div class="row"><button class="btn brown" data-act="practice">Practise 5 questions</button></div></section>') +
      (backupDue() ? '<button class="next-q nudge" data-act="export"><span><span class="eyebrow">10 seconds</span><b>Back up your work</b><small class="muted">' + (ws.profile.lastExport ? "Last backup " + esc(C.relDays(ws.profile.lastExport)) : "Your answers live only on this device. Save a copy somewhere safe.") + "</small></span>" + icon("chev") + "</button>" : "") +
      (items.length ? '<section class="stack"><h2>To do</h2><div class="agenda">' + items.map((it) => '<button class="' + it.tone + '" data-act="' + it.act + '" data-id="' + it.job + '"><span class="bar"></span><span><b>' + esc(it.title) + "</b><small>" + esc(it.sub) + "</small></span>" + icon("chev") + "</button>").join("") + "</div></section>" : "") +
      '<section class="card stack"><div class="row between"><h2>Your answers</h2><span class="mono small muted">' + r.ready + " ready · " + r.draft + " drafts · " + r.total + ' questions</span></div><div class="progress big"><i style="width:' + r.pct + '%"></i></div>' +
      (nextQ ? '<button class="next-q" data-act="answer" data-id="' + esc(nextQ.id) + '"><span><span class="eyebrow">Write next</span><b>' + esc(nextQ.q) + "</b></span>" + icon("chev") + "</button>" : "<p>Every question has an answer. Keep practising out loud.</p>") + "</section>" +
      '<section class="stack"><div class="row between"><h2>Applications</h2><a class="linkbtn" href="#jobs">All jobs</a></div><div class="tiles">' +
      C.STATUSES.slice(0, 4).map((s) => '<button class="tile" data-act="job-filter" data-v="' + s + '"><span class="eyebrow">' + s + "</span><b>" + count(s) + "</b></button>").join("") + "</div></section>" +
      '<div class="row"><button class="btn ghost" data-act="new-job">' + icon("plus") + 'Add a job</button><button class="btn ghost" data-act="new-story">' + icon("plus") + "Add a story</button></div>" +
      "</div>"
    );
  };

  // Remind people to back up when their data only lives on this device.
  function backupDue() {
    const changes = ws.profile.changesSinceExport || 0;
    if (!ws.profile.lastExport) return changes >= 15;
    return changes >= 20 || (changes > 0 && C.daysBetween(ws.profile.lastExport, t0()) >= 14);
  }

  // ---------- JOBS ----------
  V.jobs = function () {
    const f = ui.jobFilter;
    const filters = ["Active"].concat(C.STATUSES);
    const match = (j, s) => (s === "Active" ? j.status !== "Closed" : j.status === s);
    const list = C.jobOrder(ws.jobs.filter((j) => match(j, f)));
    return (
      '<div class="view">' + head(plural(ws.jobs.filter((j) => j.status !== "Closed").length, "active application"), "Jobs", '<button class="btn brown" data-act="new-job">' + icon("plus") + "Add a job</button>") +
      '<div class="chips" role="group" aria-label="Filter jobs">' + filters.map((s) => '<button class="chip" data-act="job-filter" data-v="' + s + '" aria-pressed="' + (f === s) + '">' + s + '<span class="n">' + ws.jobs.filter((j) => match(j, s)).length + "</span></button>").join("") + "</div>" +
      (list.length
        ? '<div class="grid2">' + list.map((j) => {
            const b = C.jobBadge(j);
            const posted = ws.interview.custom.filter((c) => c.jobId === j.id).length;
            return '<article class="card stack"><div class="row between"><span class="eyebrow">' + esc(j.company) + '</span><label class="sr" for="js-' + esc(j.id) + '">Stage</label><select class="select compact" id="js-' + esc(j.id) + '" data-change="job-status" data-id="' + esc(j.id) + '">' + C.STATUSES.map((s) => "<option" + (s === j.status ? " selected" : "") + ">" + s + "</option>").join("") + "</select></div><h3>" + esc(j.title) + "</h3>" +
              (b ? '<span class="pill ' + b.tone + '" style="justify-self:start">' + esc(b.text) + "</span>" : "") +
              (j.notes ? '<p class="small muted">' + esc(j.notes) + "</p>" : "") +
              '<div class="row"><button class="btn sm ' + (j.status === "Interview" ? "brown" : "ghost") + '" data-act="prep" data-id="' + esc(j.id) + '">Prep' + (posted ? " · " + posted : "") + '</button><button class="btn sm ghost" data-act="messages" data-id="' + esc(j.id) + '">Messages</button>' + (C.reminderEvents([j]).length ? '<button class="btn sm ghost" data-act="reminders" data-id="' + esc(j.id) + '" aria-label="Add check-in reminders to my calendar">' + icon("bell") + "Remind me</button>" : "") + '<button class="btn sm ghost" data-act="edit-job" data-id="' + esc(j.id) + '">' + icon("edit") + "Details</button></div></article>";
          }).join("") + "</div>"
        : '<div class="empty"><b>' + (ws.jobs.length ? "Nothing here" : "No jobs yet") + '</b><span>Add every job you apply for. Follow-up reminders and interview prep come with it.</span><button class="btn brown" data-act="new-job">Add a job</button></div>') +
      "</div>"
    );
  };
  function jobForm(j) {
    j = j || { status: "Applied", appliedAt: t0() };
    return (
      '<form data-form="job" data-id="' + esc(j.id || "") + '">' + field("title", "Job title", j.title, { req: true, ph: "Warehouse associate" }) + field("company", "Company", j.company, { req: true }) +
      '<div class="fields2">' + select("status", "Stage", j.status, C.STATUSES) + select("pay", "Pay", j.pay || "hourly", [["hourly", "Hourly"], ["salaried", "Salaried"]]) + "</div>" +
      '<small class="muted">We remind you to check in 3 days, 1 week and 1 month after you apply or interview. Salaried jobs start at 1 week.</small>' +
      field("interviewAt", "Interview date and time (if you have one)", j.interviewAt, { type: "datetime-local" }) +
      '<details class="more"' + (j.id && (j.contact || j.link || j.notes) ? " open" : "") + '><summary>More details (optional)</summary><div class="stack">' +
      '<div class="fields2">' + field("appliedAt", "Applied on", j.appliedAt, { type: "date" }) + field("followUpAt", "Follow up on", j.followUpAt, { type: "date", hint: "Optional. Check-ins are already scheduled for you." }) + "</div>" +
      field("contact", "Contact name", j.contact, { ph: "Recruiter or hiring manager" }) + field("link", "Job posting link", j.link, { type: "url", ph: "https://" }) +
      field("notes", "Notes", j.notes, { area: true, rows: 3, ph: "Pay, shift, what they're looking for" }) + "</div></details>" +
      (j.history && j.history.length ? '<div class="stack-s"><span class="eyebrow">Timeline</span><div class="timeline">' + j.history.slice().reverse().map((x) => "<div><b>" + esc(x.status) + '</b> <span class="muted small mono">' + esc(C.fmtDateY(x.at.slice(0, 10))) + "</span></div>").join("") + "</div></div>" : "") +
      (/^https?:\/\//i.test(j.link || "") ? '<a class="linkbtn" href="' + esc(j.link) + '" target="_blank" rel="noopener noreferrer">Open the posting</a>' : "") +
      foot("job", j.id) + "</form>"
    );
  }

  // ---------- INTERVIEW ----------
  function needsWork(qid) {
    const last = ws.interview.practice.filter((p) => p.q === qid).pop();
    return !!last && !last.ok;
  }
  function questionRow(q, showPack) {
    if (q.pack === "ask") {
      const a = ws.interview.answers[q.id] || {};
      return '<label class="qrow ask"><input type="checkbox" data-change="pick-ask" data-id="' + esc(q.id) + '"' + (a.pick ? " checked" : "") + "><span><b>" + esc(q.q) + "</b>" + (q.tip ? '<small class="muted">' + esc(q.tip) + "</small>" : "") + "</span></label>";
    }
    const st = C.status(ws, q.id);
    const words = C.wordCount(C.answerText(ws.interview.answers[q.id]));
    const [cls, label] = STATUS_PILL[st];
    return '<button class="qrow" data-act="answer" data-id="' + esc(q.id) + '"><span class="dot ' + st + '"></span><span><b>' + esc(q.q) + '</b><small class="muted">' + (showPack || q.pack === "mine" ? esc(C.PACKS[q.pack]) + " · " : "") + (words ? words + " words · ~" + C.speakTime(words) : "Tap to write your answer") + (needsWork(q.id) ? " · needs work" : "") + '</small></span><span class="pill ' + cls + '">' + label + "</span></button>";
  }
  V.interview = function () {
    const job = ui.prepJob ? byId(ws.jobs, ui.prepJob) : null;
    let qs;
    if (job) qs = C.jobQuestions(ws, job);
    else if (ui.pack === "all") qs = C.bankFor(ws, ["mine", "common", "behavioral"].concat(ws.profile.packs || [], ["ask"]));
    else if (ui.pack === "work") qs = C.bankFor(ws).filter((q) => needsWork(q.id));
    else qs = C.bankFor(ws, [ui.pack]);
    const r = C.readiness(ws, qs);
    const packs = ["all", "common", "behavioral", "warehouse", "service", "lead", "mine", "ask", "work"];
    const label = (p) => (p === "all" ? "My set" : p === "work" ? "Needs work" : C.PACKS[p]);
    const answerable = qs.filter((q) => q.pack !== "ask");
    const asks = qs.filter((q) => q.pack === "ask");
    return (
      '<div class="view">' + head(job ? "Preparing for " + job.company : "Write it once, say it with confidence", job ? job.title : "Interview prep", '<button class="btn ghost" data-act="add-q">' + icon("plus") + 'Questions</button><button class="btn brown" data-act="practice">' + icon("play") + "Practise</button>") +
      (job
        ? '<div class="card stack-s"><div class="row between"><span>' + (job.interviewAt ? "Interview <b>" + esc(C.fmtWhen(job.interviewAt)) + "</b>" : "No interview date yet") + '</span><button class="linkbtn small" data-act="unprep">Show all questions</button></div><div class="row"><button class="btn sm ghost" data-act="cheat" data-id="' + esc(job.id) + '">Cheat sheet</button>' + (job.interviewAt ? '<button class="btn sm ghost" data-act="ics" data-id="' + esc(job.id) + '">Add to calendar</button>' : "") + '<button class="btn sm ghost" data-act="paste-q" data-job="' + esc(job.id) + '">Paste questions from the posting</button></div></div>'
        : '<p class="muted">Pick a question, write your answer in your own words, and mark it ready when you can say it without reading. CareerCrumbs times your answer so you know if it\'s too short or too long.</p><div class="chips" role="group" aria-label="Question sets">' + packs.map((p) => '<button class="chip" data-act="pack" data-v="' + p + '" aria-pressed="' + (ui.pack === p) + '">' + esc(label(p)) + "</button>").join("") + "</div>" +
          (!ws.profile.packsAsked ? '<div class="card kind stack-s"><div class="row between"><b>What kind of job are you going for?</b><button class="linkbtn small" data-act="kind-done">Done</button></div><span class="small muted">Tap any that fit to add those questions. Optional.</span><div class="togglechips">' + ["warehouse", "service", "lead"].map((k) => '<label><input type="checkbox" data-change="kind" value="' + esc(k) + '"' + ((ws.profile.packs || []).includes(k) ? " checked" : "") + "><span>" + esc(C.PACKS[k]) + "</span></label>").join("") + "</div></div>" : "")) +
      (answerable.length ? '<div class="stack-s"><div class="small"><b>' + r.ready + "</b> ready · <b>" + r.draft + "</b> drafts · " + r.total + ' questions</div><div class="progress big"><i style="width:' + r.pct + '%"></i></div></div><div class="qlist">' + answerable.map((q) => questionRow(q, !!job || ui.pack === "all" || ui.pack === "work")).join("") + "</div>" : "") +
      (asks.length ? '<section class="stack"><h2>Questions to ask them</h2><p class="muted small">Tick two or three to bring. They go on your cheat sheet.</p><div class="qlist">' + asks.map((q) => questionRow(q)).join("") + "</div></section>" : "") +
      (!qs.length ? '<div class="empty"><b>' + (ui.pack === "mine" ? "No questions of your own yet" : "Nothing marked as needs work") + "</b><span>" + (ui.pack === "mine" ? "Paste the requirements or questions from a job posting and practise each one." : "Practise a few. Anything you stumble on shows up here.") + '</span><button class="btn brown" data-act="' + (ui.pack === "mine" ? "paste-q" : "practice") + '">' + (ui.pack === "mine" ? "Add questions" : "Practise") + "</button></div>" : "") +
      "</div>"
    );
  };
  function answerSheet(q) {
    const a = Object.assign({ mode: q.star ? "star" : "free" }, ws.interview.answers[q.id]);
    const star = a.mode === "star";
    const storyOpts = ws.stories.map((s) => '<option value="' + esc(s.id) + '"' + (a.storyId === s.id ? " selected" : "") + ">" + esc(s.title) + "</option>").join("");
    return (
      '<div class="sheet-body" data-answer="' + esc(q.id) + '"><p class="question">' + esc(q.q) + "</p>" + (q.tip ? '<p class="tip">' + esc(q.tip) + "</p>" : "") +
      (C.EXAMPLES[q.id] ? '<details class="peek"><summary>See an example answer</summary><div class="out">' + esc(C.EXAMPLES[q.id]) + '</div><small class="muted">It shows the shape. Use your own words and your own experience.</small></details>' : "") +
      '<div class="seg" role="group" aria-label="Answer style"><button type="button" data-act="mode" data-v="free" aria-pressed="' + !star + '">Free text</button><button type="button" data-act="mode" data-v="star" aria-pressed="' + star + '">STAR</button></div>' +
      (star
        ? (ws.stories.length ? '<label class="field" for="a-story"><span>Fill from a story</span><select class="select" id="a-story" data-change="from-story"><option value="">Choose one of your stories…</option>' + storyOpts + "</select></label>" : '<p class="small muted">Tip: write your stories in Stories, then fill STAR answers from them in one tap.</p>') +
          [["s", "Situation", "Where were you and what was going on?"], ["t", "Task", "What did you need to do?"], ["a", "Action", "What did you do? Use I, not we."], ["r", "Result", "What happened? Add a number if you can."]].map(([k, l, ph]) => '<label class="field" for="a-' + esc(k) + '"><span>' + l + '</span><textarea class="textarea" id="a-' + esc(k) + '" data-ans="' + esc(k) + '" rows="' + (k === "a" ? 3 : 2) + '" placeholder="' + ph + '">' + esc(a[k] || "") + "</textarea></label>").join("")
        : '<label class="field" for="a-text"><span>Your answer</span><textarea class="textarea" id="a-text" data-ans="text" rows="9" placeholder="Write it the way you\'d say it out loud.">' + esc(a.text || "") + "</textarea></label>") +
      '<div class="meter" data-meter></div>' +
      '<div class="sheet-foot"><button type="button" class="btn ghost sm" data-act="copy-answer">' + icon("copy") + 'Copy</button><span class="grow"></span><label class="check"><input type="checkbox" data-change="ready"' + (a.ready ? " checked" : "") + "> I can say this without reading</label></div></div>"
    );
  }
  function updateMeter() {
    const host = $("[data-answer]");
    if (!host) return;
    const q = qById(host.dataset.answer);
    const words = C.wordCount(C.answerText(ws.interview.answers[q.id]));
    $("[data-meter]", host).innerHTML = words ? '<span class="mono">' + words + " words · ~" + C.speakTime(words) + ' spoken</span><span class="muted">' + esc(C.lengthHint(q, words)) + "</span>" : '<span class="muted">Aim for about one to two minutes spoken.</span>';
  }
  function openAnswer(id) {
    const q = qById(id);
    if (!q) return;
    openSheet(C.PACKS[q.pack], answerSheet(q));
    updateMeter();
  }

  // Practice: flashcards with a timer. Your own answer stays hidden until you ask for it.
  let timer = null;
  const session = { list: [], i: 0, ok: 0 };
  function practiceCard() {
    const q = session.list[session.i];
    const a = C.answerText(ws.interview.answers[q.id]);
    return '<div class="sheet-body practice"><div class="row between"><span class="eyebrow">Question ' + (session.i + 1) + " of " + session.list.length + '</span><span class="mono small muted">' + esc(C.PACKS[q.pack]) + '</span></div><p class="question">' + esc(q.q) + '</p><div class="timer" data-timer>0:00</div><p class="small muted center-text">Say your answer out loud. Aim for one to two minutes.</p><div class="row center"><button class="btn ghost" data-act="timer">Start timer</button></div>' +
      (a ? '<details class="peek"><summary>Show my answer</summary><div class="out">' + esc(a) + "</div></details>" : '<p class="small muted">You haven\'t written an answer for this one yet. Try it anyway, then write it down.</p>') +
      '<div class="row center"><button class="btn ghost" data-act="practice-mark" data-ok="0">Needs work</button><button class="btn brown" data-act="practice-mark" data-ok="1">Nailed it</button></div></div>';
  }

  // ---------- STORIES ----------
  V.stories = function () {
    const list = ws.stories.slice().sort((a, b) => ((a.date || "") < (b.date || "") ? 1 : -1));
    const used = {};
    for (const a of Object.values(ws.interview.answers)) if (a.storyId) used[a.storyId] = (used[a.storyId] || 0) + 1;
    return (
      '<div class="view">' + head(ws.stories.length + (ws.stories.length === 1 ? " story" : " stories"), "Stories", '<button class="btn brown" data-act="new-story">' + icon("plus") + "Add a story</button>") +
      '<p class="muted">Most interview questions can be answered with the same five to eight stories. Write down real moments: helping a teammate, fixing a mistake, handling a rush, calming a customer, catching a safety problem. Each one becomes a STAR answer and a résumé line.</p>' +
      (list.length
        ? '<div class="grid2">' + list.map((s) => '<article class="ticket"><div class="ticket-head"><b>STORY-' + String(s.n || 0).padStart(3, "0") + "</b><span>" + esc(C.fmtDateY(s.date)) + "</span></div><h3>" + esc(s.title) + "</h3>" + (s.result ? '<p class="small">' + esc(s.result) + "</p>" : "") + (used[s.id] ? '<span class="pill brown" style="justify-self:start">Used in ' + plural(used[s.id], "answer") + "</span>" : "") + '<div class="tear"></div><div class="row"><button class="btn sm ghost" data-act="edit-story" data-id="' + esc(s.id) + '">' + icon("edit") + 'Edit</button><button class="btn sm ghost" data-act="bullet" data-id="' + esc(s.id) + '">Résumé line</button></div></article>').join("") + "</div>"
        : '<div class="empty"><b>No stories yet</b><span>Think of one shift you\'re proud of. What happened, what did you do, how did it turn out?</span><button class="btn brown" data-act="new-story">Write your first story</button></div>') +
      "</div>"
    );
  };
  function storyForm(s) {
    s = s || { date: t0() };
    return (
      '<form data-form="story" data-id="' + esc(s.id || "") + '">' + field("title", "Name it", s.title, { req: true, ph: "Caught a mislabeled pallet" }) +
      field("action", "What you did", s.action, { area: true, rows: 3, ph: "Start with a verb: helped, trained, fixed, organised…" }) + field("result", "How it turned out", s.result, { area: true, rows: 2, ph: "A number helps, but it's optional." }) +
      '<details class="more"' + (s.situation || s.task ? " open" : "") + '><summary>Add the backstory (optional, makes a stronger STAR answer)</summary><div class="stack">' +
      field("situation", "Situation", s.situation, { area: true, rows: 2, ph: "Where were you, what was going on?" }) + field("task", "Task", s.task, { area: true, rows: 2, ph: "What needed doing?" }) + field("date", "Roughly when", s.date, { type: "date" }) + "</div></details>" +
      foot("story", s.id) + "</form>"
    );
  }

  // ---------- ME ----------
  V.me = function () {
    const p = ws.profile;
    let theme = "system";
    try { theme = localStorage.getItem("careercrumbs:theme") || "system"; } catch (e) {}
    const where = native ? "Saved on this phone. Export a backup now and then." : "Saved in this browser only. Export a backup now and then.";
    return (
      '<div class="view">' + head("Your details and your data", "Me") +
      '<section class="card stack"><h2>About you</h2><form class="stack" data-form="profile">' + field("name", "Your name", p.name, { hint: "Signs your follow-up and thank-you messages." }) + field("targetRole", "Job you're going for", p.targetRole, { ph: "Warehouse associate, cashier, shift lead…" }) +
      '<div class="field"><span>Question sets for your kind of job</span><div class="togglechips">' + ["warehouse", "service", "lead"].map((k) => '<label><input type="checkbox" name="packs" value="' + esc(k) + '"' + ((p.packs || []).includes(k) ? " checked" : "") + "><span>" + esc(C.PACKS[k]) + "</span></label>").join("") + "</div><small>Common and behavioral questions are always included.</small></div>" +
      '<div class="row"><button class="btn brown">Save</button></div></form></section>' +
      '<section class="card stack"><h2>Check-in reminders</h2><p class="muted">CareerCrumbs reminds you to reconnect <b>3 days, 1 week and 1 month</b> after you apply or interview. Salaried jobs start at 1 week. Due check-ins show on Home with a message ready to send.</p><p class="muted">For an alert on your phone, add them to your calendar. Your calendar app does the notifying, and you can delete them anytime.</p>' +
      '<div class="row"><button class="btn brown" data-act="reminders-all">' + icon("bell") + "Add all upcoming check-ins (" + C.reminderEvents(ws.jobs).length + ')</button></div><div class="field"><span>When I add or update a job</span><div class="chips" role="group" aria-label="Calendar offer">' + [["ask", "Offer to add reminders"], ["off", "Don\'t ask"]].map(([v, l]) => '<button class="chip" data-act="remind-pref" data-v="' + esc(v) + '" aria-pressed="' + ((p.reminders || "ask") === v) + '">' + l + "</button>").join("") + "</div></div></section>" +
      '<section class="card stack"><h2>Look</h2><div class="chips" role="group" aria-label="Theme">' + [["system", "Match device"], ["light", "Light"], ["dark", "Dark"]].map(([v, l]) => '<button class="chip" data-act="theme" data-v="' + esc(v) + '" aria-pressed="' + (theme === v) + '">' + l + "</button>").join("") + "</div></section>" +
      '<section class="card stack"><h2>Your data</h2><p class="muted">' + esc(where) + "</p>" + '<p class="' + (ws.profile.lastExport ? "muted" : "warn-text") + '">Last backup: ' + (ws.profile.lastExport ? esc(C.fmtDateY(ws.profile.lastExport)) : "never") + "</p>" + '<div class="row"><button class="btn ghost" data-act="export">Export backup</button><label class="btn ghost" for="import-file">Import backup</label><input class="sr" id="import-file" type="file" accept=".json,application/json"></div><div data-import></div><div class="row divider"><button class="btn danger sm" data-act="ask-erase">Erase everything</button></div><div data-erase></div></section>' +
      '<p class="muted small">CareerCrumbs has no AI and sends your answers nowhere. What you write is yours.</p></div>'
    );
  };

  // ---------- sheets, toasts, files ----------
  // Sheets sit in browser history, so the phone's Back button closes the sheet instead of
  // changing the page underneath it.
  let sheetTrigger = null;
  let curState = history.state;
  let curHref = location.href;
  function openSheet(title, body) {
    if (!ui.sheetOpen) {
      sheetTrigger = keyOf(document.activeElement);
      history.pushState({ sheet: 1 }, "");
      curState = history.state;
      curHref = location.href;
    }
    ui.sheetOpen = true;
    const host = $("#sheet");
    host.innerHTML = '<div class="scrim" data-act="scrim"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><div class="sheet-grip"></div><div class="sheet-head"><h2 id="sheet-title" tabindex="-1">' + esc(title) + '</h2><button class="iconbtn" data-act="close" aria-label="Close">' + icon("close") + "</button></div>" + body + "</div></div>";
    host.hidden = false;
    app().inert = true;
    document.body.style.overflow = "hidden";
    // On phones, focusing a field would pop the keyboard over the sheet; focus the title instead.
    const first = window.matchMedia("(min-width: 700px)").matches && host.querySelector(".sheet input:not([type=hidden]):not([type=checkbox]), .sheet textarea, .sheet select");
    (first || $("#sheet-title")).focus({ preventScroll: true });
  }
  // Closing from code (after saving a form): the history entry stays, marked so Back skips it.
  function closeSheet() {
    if (history.state && history.state.sheet) {
      history.replaceState({ dead: 1 }, "");
      curState = history.state;
    }
    finishClose();
  }
  // Closing by hand (X, tap outside, Escape) is the same as pressing Back.
  function dismissSheet() {
    if (history.state && history.state.sheet) history.back();
    else finishClose();
  }
  function finishClose() {
    const host = $("#sheet");
    host.innerHTML = "";
    host.hidden = true;
    app().inert = false;
    document.body.style.overflow = "";
    ui.sheetOpen = false;
    clearInterval(timer);
    render();
    if (sheetTrigger) refocus(sheetTrigger);
    sheetTrigger = null;
  }
  window.addEventListener("popstate", () => {
    const prev = curState;
    const prevHref = curHref;
    curState = history.state;
    curHref = location.href;
    if (ui.sheetOpen) return finishClose();
    // Back from an entry left behind by a closed sheet shows nothing new, so keep going.
    if (prev && prev.dead && prevHref === location.href) history.back();
  });
  let toastTimer = null;
  function toast(msg, label, fn) {
    const host = $("#toast");
    host.innerHTML = '<div class="toast" role="status"><span>' + esc(msg) + "</span>" + (label ? '<button type="button">' + esc(label) + "</button>" : "") + "</div>";
    host.hidden = false;
    if (label) host.querySelector("button").onclick = () => { host.hidden = true; fn(); };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (host.hidden = true), label ? 7000 : 3200);
  }
  function confirmIn(host, msg, label, fn) {
    host.innerHTML = '<div class="confirm"><p>' + esc(msg) + '</p><button type="button" class="btn sm ghost" data-act="cancel-confirm">Keep</button><button type="button" class="btn sm danger" data-go>' + esc(label) + "</button></div>";
    host.querySelector("[data-go]").onclick = fn;
  }
  // Inside the Android test app, window.CCAndroid handles copying and saving files.
  const native = window.CCAndroid || null;
  async function copyText(text, el) {
    if (native) {
      native.copy(text);
      return toast("Copied");
    }
    try {
      await navigator.clipboard.writeText(text);
      return toast("Copied");
    } catch (e) {}
    // Older WebViews and non-secure pages: copy through a hidden textarea.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (e) {}
    ta.remove();
    if (ok) return toast("Copied");
    if (el) {
      el.focus();
      el.select();
      toast("Couldn't copy automatically. The text is selected, so long-press to copy it.");
    } else textSheet("Copy this", text);
  }
  const canShareText = () => !native && typeof navigator.share === "function";
  async function shareText(title, text) {
    try {
      await navigator.share({ title, text });
    } catch (e) {
      if (e && e.name !== "AbortError") copyText(text);
    }
  }
  // Order matters: the Android app's bridge, the phone's share sheet (Drive, Gmail, Calendar),
  // a normal download, then a sheet to copy from.
  async function saveFile(name, data) {
    if (native) return void native.saveFile(name, data);
    const type = name.endsWith(".ics") ? "text/calendar" : name.endsWith(".json") ? "application/json" : "text/plain";
    let file = null;
    try { file = new File([data], name, { type }); } catch (e) {}
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    if (file) {
      try {
        const url = URL.createObjectURL(file);
        const a = Object.assign(document.createElement("a"), { href: url, download: name });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return toast("Saved " + name + " to your downloads");
      } catch (e) {}
    }
    textSheet(name, data);
  }
  function textSheet(title, text, file) {
    openSheet(title, '<div class="sheet-body"><textarea class="textarea mono-text" id="ts" rows="16">' + esc(text) + '</textarea><div class="sheet-foot"><span class="grow"></span>' + (file ? '<button class="btn ghost" data-act="ts-file" data-name="' + esc(file) + '">Save file</button>' : "") + '<button class="btn brown" data-act="ts-copy">' + icon("copy") + "Copy</button></div></div>");
  }
  const slug = (s) => String(s || "job").replace(/\s*\(example\)/, "").replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

  // ---------- actions ----------
  const A = {
    close: () => dismissSheet(),
    scrim: (el, ev) => ev.target === el && dismissSheet(),
    retry: () => render(),
    "export-raw"() {
      let raw = "";
      try { raw = localStorage.getItem(LS_KEY) || JSON.stringify(ws); } catch (e) { raw = JSON.stringify(ws); }
      saveFile("careercrumbs-data-" + t0() + ".json", raw);
    },
    "ask-reset"() {
      confirmIn($("[data-reset]"), "This clears everything saved in CareerCrumbs on this device.", "Reset", () => {
        ws = C.emptyWorkspace();
        dirty.add("ws");
        save();
      });
    },
    "cancel-confirm": (el) => (el.closest(".confirm").parentElement.innerHTML = ""),
    "new-job": () => openSheet("Add a job", jobForm()),
    "edit-job": (el) => openSheet("Job", jobForm(byId(ws.jobs, el.dataset.id))),
    "job-filter": (el) => { ui.jobFilter = el.dataset.v; route === "jobs" ? render() : go("jobs"); },
    messages(el) {
      const j = byId(ws.jobs, el.dataset.id);
      const ms = C.messages(j, ws.profile);
      const due = C.dueCheckIn(j);
      const next = C.nextCheckIn(j);
      const thanksDue = j.status === "Interview" && j.interviewAt && j.interviewAt.slice(0, 10) <= t0() && !j.thankYouSent;
      const first = ms.findIndex((m) => m.id === (thanksDue ? "thanks" : due ? due.message : j.status === "Interview" ? "confirm" : "followup"));
      const checkin = due
        ? '<div class="checkin" data-checkin><span><b>Check-in due</b> · ' + esc(due.label) + '</span><button class="btn sm brown" data-act="checked-in" data-id="' + esc(j.id) + '" data-key="' + esc(due.key) + '">I checked in</button></div>'
        : next ? '<p class="small muted" data-checkin>Next check-in: ' + esc(C.fmtDate(next.date)) + " (" + esc(next.label) + ")</p>" : "";
      openSheet("Messages · " + j.company, '<div class="sheet-body"><p class="muted small">Ready to copy into an email or text. Fill in anything in [brackets].</p>' + checkin + (ws.profile.name ? "" : '<label class="field" for="sign-name"><span>Your name, to sign the message</span><input class="input" id="sign-name" data-change="sign-name" data-id="' + esc(j.id) + '" placeholder="First and last name" autocomplete="name"></label>') + '<div class="chips">' + ms.map((m, i) => '<button class="chip" data-act="msg" data-i="' + i + '" data-id="' + esc(j.id) + '" aria-pressed="' + (i === first) + '">' + esc(m.label) + "</button>").join("") + '</div><label class="field" for="msg-subject"><span>Subject</span><input class="input" id="msg-subject" value="' + esc(ms[first].subject) + '"></label><label class="field" for="msg-body"><span>Message</span><textarea class="textarea" id="msg-body" rows="11">' + esc(ms[first].body) + '</textarea></label><div class="sheet-foot">' + (j.status === "Interview" ? '<label class="check"><input type="checkbox" data-change="thanked" data-id="' + esc(j.id) + '"' + (j.thankYouSent ? " checked" : "") + "> Thank-you sent</label>" : "") + '<span class="grow"></span>' + (canShareText() ? '<button class="btn ghost" data-act="msg-share">Share</button>' : "") + '<button class="btn brown" data-act="msg-copy">' + icon("copy") + "Copy message</button></div></div>");
    },
    "checked-in"(el) {
      const i = ws.jobs.findIndex((j) => j.id === el.dataset.id);
      ws.jobs[i] = C.markCheckedIn(ws.jobs[i], el.dataset.key);
      persist("jobs");
      const next = C.nextCheckIn(ws.jobs[i]);
      el.closest("[data-checkin]").outerHTML = '<p class="small muted" data-checkin>Nice. ' + (next ? "Next check-in: " + esc(C.fmtDate(next.date)) + " (" + esc(next.label) + ")." : "That was the last scheduled check-in.") + "</p>";
    },
    reminders(el) {
      const j = byId(ws.jobs, el.dataset.id);
      saveFile("check-ins-" + slug(j.company) + ".ics", C.remindersIcs([j]));
    },
    "reminders-all"() {
      const n = C.reminderEvents(ws.jobs).length;
      if (!n) return toast("Nothing coming up yet. Add a job you've applied for.");
      saveFile("careercrumbs-reminders.ics", C.remindersIcs(ws.jobs));
    },
    "remind-pref"(el) {
      ws.profile.reminders = el.dataset.v;
      save("profile");
    },
    msg(el) {
      const m = C.messages(byId(ws.jobs, el.dataset.id), ws.profile)[el.dataset.i];
      el.parentElement.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c === el)));
      $("#msg-subject").value = m.subject;
      $("#msg-body").value = m.body;
    },
    "msg-share": () => shareText($("#msg-subject").value, $("#msg-subject").value + "\n\n" + $("#msg-body").value),
    "msg-copy": () => copyText($("#msg-subject").value + "\n\n" + $("#msg-body").value, $("#msg-body")),
    prep(el) {
      ui.prepJob = el.dataset.id;
      if (ui.sheetOpen) closeSheet();
      if (route === "interview") render();
      else go("interview");
      window.scrollTo(0, 0);
    },
    unprep() { ui.prepJob = null; render(); },
    cheat(el) {
      const j = byId(ws.jobs, el.dataset.id);
      textSheet("Cheat sheet", C.cheatSheet(ws, j), "cheat-sheet-" + slug(j.company) + ".txt");
    },
    ics(el) {
      const j = byId(ws.jobs, el.dataset.id);
      saveFile("interview-" + slug(j.company) + ".ics", C.interviewIcs(j));
    },
    "ts-copy": () => copyText($("#ts").value, $("#ts")),
    "ts-file": (el) => saveFile(el.dataset.name, $("#ts").value),

    pack: (el) => { ui.pack = el.dataset.v; render(); },
    "kind-done": () => { ws.profile.packsAsked = true; save("profile"); },
    answer: (el) => openAnswer(el.dataset.id),
    mode(el) {
      const host = el.closest("[data-answer]");
      const q = qById(host.dataset.answer);
      const a = Object.assign({}, ws.interview.answers[q.id]);
      const cur = a.mode || (q.star ? "star" : "free");
      if (cur === el.dataset.v) return;
      // Keep the newest words when switching. STAR edited after the free text: rebuild the free text
      // from STAR and keep the old version in prevText. Free → STAR fills Action only when it's empty.
      if (el.dataset.v === "free") {
        const joined = C.answerText(Object.assign({}, a, { mode: "star" }));
        if (joined && (!a.text || (a.starAt || "") > (a.textAt || ""))) {
          if (a.text && a.text !== joined) a.prevText = a.text;
          a.text = joined;
        }
      } else if (!a.a && a.text) {
        a.a = a.text;
        toast("Your answer is in Action. Split it into the other parts if you like.");
      }
      a.mode = el.dataset.v;
      ws.interview.answers[q.id] = a;
      persist("interview");
      host.outerHTML = answerSheet(q);
      updateMeter();
    },
    "copy-answer": () => copyText(C.answerText(ws.interview.answers[$("[data-answer]").dataset.answer])),
    "add-q"() {
      openSheet("Add questions", '<div class="sheet-body"><p class="muted">Add a question you expect, or paste a list straight from a job posting. Each line becomes a question to practise.</p><div class="row"><button class="btn brown" data-act="paste-q">Paste a list</button></div><form data-form="one-q" class="stack">' + field("q", "Or add one question", "", { req: true, ph: "Are you comfortable lifting 50 lb?" }) + select("jobId", "For a job (optional)", ui.prepJob || "", jobOptions()) + '<div class="row"><button class="btn ghost">Add question</button></div></form></div>');
    },
    "paste-q"(el) {
      const jobId = (el && el.dataset && el.dataset.job) || ui.prepJob || "";
      openSheet("Paste questions", '<form data-form="paste-q"><label class="field" for="f-paste"><span>One per line</span><textarea class="textarea" id="f-paste" name="paste" rows="9" required placeholder="Paste questions or requirements from the posting. A line like &quot;Able to lift 50 lb&quot; becomes &quot;Tell me about: able to lift 50 lb&quot;."></textarea></label>' + select("jobId", "For a job (optional)", jobId, jobOptions()) + '<div class="sheet-foot"><span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">Add questions</button></div></form>');
    },
    practice() {
      const job = ui.prepJob ? byId(ws.jobs, ui.prepJob) : null;
      let pool = (job ? C.jobQuestions(ws, job) : C.bankFor(ws, ["mine", "common", "behavioral"].concat(ws.profile.packs || []))).filter((q) => q.pack !== "ask");
      const work = pool.filter((q) => needsWork(q.id));
      pool = work.concat(C.shuffle(pool.filter((q) => !work.includes(q))));
      session.list = pool.slice(0, 5);
      session.i = 0;
      session.ok = 0;
      if (!session.list.length) return toast("Add some questions first.");
      clearInterval(timer);
      openSheet("Practice", practiceCard());
    },
    timer(el) {
      clearInterval(timer);
      let s = 0;
      const out = $("[data-timer]");
      out.textContent = "0:00";
      el.textContent = "Restart";
      timer = setInterval(() => {
        if (!document.body.contains(out)) return clearInterval(timer);
        s++;
        out.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
        out.dataset.state = s > 120 ? "long" : s >= 60 ? "good" : "";
      }, 1000);
    },
    "practice-mark"(el) {
      clearInterval(timer);
      const q = session.list[session.i];
      const ok = el.dataset.ok === "1";
      ws.interview.practice = ws.interview.practice.concat([{ q: q.id, date: t0(), ok }]).slice(-300);
      persist("interview");
      if (ok) session.ok++;
      session.i++;
      const body = $(".sheet .sheet-body");
      if (session.i < session.list.length) body.outerHTML = practiceCard();
      else body.outerHTML = '<div class="sheet-body practice center-text">' + ruhv("ruhv-hero") + "<h2>" + session.ok + " of " + session.list.length + ' nailed</h2><p class="muted">' + (session.ok === session.list.length ? "Great run. Do another set tomorrow to keep it fresh." : "The ones that need work are saved under Needs work. Rewrite them, then practise again.") + '</p><div class="row center"><button class="btn ghost" data-act="close">Done</button><button class="btn brown" data-act="practice">Another 5</button></div></div>';
    },

    "new-story": () => openSheet("Add a story", storyForm()),
    "edit-story": (el) => openSheet("Story", storyForm(byId(ws.stories, el.dataset.id))),
    bullet(el) {
      const s = byId(ws.stories, el.dataset.id);
      openSheet("Résumé line", '<div class="sheet-body"><span class="eyebrow">Template · edit it to sound like you</span><textarea class="textarea" id="ts" rows="4">' + esc(C.bulletFromStory(s)) + '</textarea><p class="small muted">Built only from your own words. Anything in [brackets] is missing: fill it in or delete it.</p><div class="sheet-foot"><span class="grow"></span><button class="btn brown" data-act="ts-copy">' + icon("copy") + "Copy</button></div></div>");
    },

    theme(el) {
      try { localStorage.setItem("careercrumbs:theme", el.dataset.v); } catch (e) {}
      applyTheme();
      render();
    },
    export() {
      ws.profile.lastExport = t0();
      ws.profile.changesSinceExport = 0;
      save("profile");
      saveFile("careercrumbs-backup-" + t0() + ".json", JSON.stringify(Object.assign({ app: "CareerCrumbs", version: 2, exported: new Date().toISOString() }, ws), null, 2));
    },
    "ask-erase"() {
      confirmIn($("[data-erase]"), "This deletes every job, answer and story. Export a backup first if you might want them.", "Erase everything", () => {
        const before = ws;
        ws = C.emptyWorkspace();
        dirty.add("ws");
        save();
        toast("Erased", "Undo", () => {
          ws = before;
          dirty.add("ws");
          save();
          toast("Restored");
        });
      });
    },
    "ask-del"(el) {
      const map = { job: ["jobs", "this job"], story: ["stories", "this story"] };
      const [key, what] = map[el.dataset.kind];
      const id = el.dataset.id;
      confirmIn(el.closest(".sheet").querySelector("[data-confirm]"), "Delete " + what + "?", "Delete", () => {
        const idx = ws[key].findIndex((x) => x.id === id);
        const removed = ws[key][idx];
        ws[key] = ws[key].filter((x) => x.id !== id);
        // Questions pasted for this job stay, unlinked; undo links them again.
        const linked = key === "jobs" ? ws.interview.custom.filter((c) => c.jobId === id) : [];
        for (const c of linked) c.jobId = "";
        if (key === "jobs" && ui.prepJob === id) ui.prepJob = null;
        closeSheet();
        save(key, "interview");
        toast("Deleted", "Undo", () => {
          ws[key].splice(Math.min(idx, ws[key].length), 0, removed);
          for (const c of linked) c.jobId = id;
          save(key, "interview");
        });
      });
    },
  };

  // change handlers
  const CH = {
    kind(el) {
      const set = new Set(ws.profile.packs || []);
      el.checked ? set.add(el.value) : set.delete(el.value);
      ws.profile.packs = [...set];
      save("profile");
    },
    "sign-name"(el) {
      ws.profile.name = el.value.trim();
      persist("profile");
      const on = $(".sheet .chip[aria-pressed=true]");
      if (on) A.msg(on);
    },
    "job-status"(el) {
      const i = ws.jobs.findIndex((j) => j.id === el.dataset.id);
      ws.jobs[i] = C.setStatus(ws.jobs[i], el.value);
      save("jobs");
      if (el.value === "Applied") offerReminders(ws.jobs[i]);
      if (el.value === "Interview") toast("You got the interview. Add the date and time, then prep.", "Add date", () => A["edit-job"]({ dataset: { id: el.dataset.id } }));
      if (el.value === "Offer") toast("Congratulations! You earned this.");
    },
    "pick-ask"(el) {
      ws.interview.answers[el.dataset.id] = Object.assign({}, ws.interview.answers[el.dataset.id], { pick: el.checked });
      persist("interview");
    },
    ready(el) {
      const id = el.closest("[data-answer]").dataset.answer;
      ws.interview.answers[id] = Object.assign({ mode: qById(id).star ? "star" : "free" }, ws.interview.answers[id], { ready: el.checked });
      persist("interview");
      if (el.checked) toast("Marked ready. Say it out loud a couple more times.");
    },
    "from-story"(el) {
      const host = el.closest("[data-answer]");
      const s = byId(ws.stories, el.value);
      if (!s) return;
      const q = qById(host.dataset.answer);
      ws.interview.answers[q.id] = Object.assign({}, ws.interview.answers[q.id], C.storyToStar(s));
      persist("interview");
      host.outerHTML = answerSheet(q);
      updateMeter();
    },
    thanked(el) {
      byId(ws.jobs, el.dataset.id).thankYouSent = el.checked;
      persist("jobs");
    },
  };

  // Opt-in: we only offer the calendar file; nothing is added unless the person taps it.
  function offerReminders(job) {
    const upcoming = C.checkIns(job).filter((c) => !c.done && c.date >= t0());
    if (!upcoming.length) return;
    const dates = upcoming.map((c) => C.fmtDate(c.date));
    const list = dates.length > 1 ? dates.slice(0, -1).join(", ") + " and " + dates[dates.length - 1] : dates[0];
    if (ws.profile.reminders === "off") toast("Check-ins set for " + list + ".");
    else toast("Check-ins set for " + list + ". Get a phone alert?", "Add to calendar", () => A.reminders({ dataset: { id: job.id } }));
  }

  // form handlers
  const val = (f, n) => (f.elements[n] ? String(f.elements[n].value || "").trim() : "");
  const F = {
    job(f) {
      const id = f.dataset.id;
      const data = { title: val(f, "title"), company: val(f, "company"), appliedAt: val(f, "appliedAt"), interviewAt: val(f, "interviewAt"), followUpAt: val(f, "followUpAt"), pay: val(f, "pay") || "hourly", contact: val(f, "contact"), link: val(f, "link"), notes: val(f, "notes") };
      const status = val(f, "status");
      let j;
      let before = "";
      if (id) {
        const i = ws.jobs.findIndex((x) => x.id === id);
        before = C.checkIns(ws.jobs[i]).map((c) => c.date).join();
        j = Object.assign({}, ws.jobs[i], data);
        if (j.status !== status) j = C.setStatus(j, status);
        ws.jobs[i] = j;
      } else {
        j = C.setStatus(Object.assign({ id: C.uid("j"), created: t0(), history: [] }, data), status);
        if (!j.appliedAt && status !== "Saved") j.appliedAt = t0();
        ws.jobs.push(j);
      }
      closeSheet();
      save("jobs");
      if (C.checkIns(j).map((c) => c.date).join() !== before) offerReminders(j);
    },
    story(f) {
      const id = f.dataset.id;
      const data = { title: val(f, "title"), date: val(f, "date"), situation: val(f, "situation"), task: val(f, "task"), action: val(f, "action"), result: val(f, "result") };
      if (id) Object.assign(byId(ws.stories, id), data);
      else {
        ws.storySeq = (ws.storySeq || 0) + 1;
        ws.stories.push(Object.assign({ id: C.uid("s"), n: ws.storySeq }, data));
      }
      closeSheet();
      save("stories", "storySeq");
      if (!id) toast("Story saved. Use it to fill a STAR answer in Interview.");
    },
    "one-q"(f) {
      ws.interview.custom = ws.interview.custom.concat([{ id: C.uid("q"), q: val(f, "q"), jobId: val(f, "jobId") }]);
      closeSheet();
      if (!ui.prepJob) ui.pack = "mine";
      save("interview");
    },
    "paste-q"(f) {
      const jobId = val(f, "jobId");
      const lines = val(f, "paste").split(/\r?\n/).map((l) => l.replace(/^[\s•*\-–—\d.)]+/, "").trim()).filter((l) => l.length > 3);
      const qs = lines.slice(0, 40).map((l) => ({ id: C.uid("q"), q: /\?$/.test(l) ? l : "Tell me about: " + l.charAt(0).toLowerCase() + l.slice(1).replace(/[.;]$/, ""), jobId }));
      ws.interview.custom = ws.interview.custom.concat(qs);
      closeSheet();
      if (!ui.prepJob) ui.pack = "mine";
      save("interview");
      toast("Added " + plural(qs.length, "question"));
    },
    profile(f) {
      ws.profile.name = val(f, "name");
      ws.profile.targetRole = val(f, "targetRole");
      ws.profile.packs = [...f.querySelectorAll("input[name=packs]:checked")].map((i) => i.value);
      save("profile");
      toast("Saved");
    },
  };

  // ---------- wiring ----------
  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-act]");
    if (!el || !A[el.dataset.act]) return;
    if (el.tagName === "A") ev.preventDefault();
    A[el.dataset.act](el, ev);
  });
  document.addEventListener("change", (ev) => {
    const el = ev.target;
    if (el.dataset && el.dataset.change && CH[el.dataset.change]) CH[el.dataset.change](el);
    if (el.id === "import-file" && el.files && el.files[0]) {
      importFile(el.files[0]);
      el.value = "";
    }
  });
  document.addEventListener("submit", (ev) => {
    const f = ev.target;
    if (!F[f.dataset.form]) return;
    ev.preventDefault();
    F[f.dataset.form](f);
  });
  // Answers save as you type, without redrawing the sheet.
  document.addEventListener("input", (ev) => {
    const el = ev.target;
    if (!el.dataset || !el.dataset.ans) return;
    const q = qById(el.closest("[data-answer]").dataset.answer);
    const a = Object.assign({ mode: q.star ? "star" : "free" }, ws.interview.answers[q.id]);
    a[el.dataset.ans] = el.value;
    a.updated = new Date().toISOString();
    if (el.dataset.ans === "text") a.textAt = a.updated;
    else a.starAt = a.updated;
    ws.interview.answers[q.id] = a;
    updateMeter();
    persist("interview");
  });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && ui.sheetOpen) dismissSheet(); });

  function importFile(file) {
    const r = new FileReader();
    r.onload = () => {
      let data;
      try { data = JSON.parse(r.result); } catch (e) { return toast("That file isn't a CareerCrumbs backup, so nothing was changed."); }
      const check = C.checkBackup(data);
      if (!check.ok) return toast(check.reason);
      const c = check.counts;
      const parts = [plural(c.jobs, "job"), plural(c.answers, "answer"), c.stories + (c.stories === 1 ? " story" : " stories")];
      confirmIn($("[data-import]"), "Replace everything with this backup (" + parts.join(", ") + ")? You can undo right after.", "Replace", () => {
        const before = ws;
        try { localStorage.setItem(LS_KEY + ":before-import", JSON.stringify(before)); } catch (e) {}
        ws = check.ws;
        dirty.add("ws");
        save();
        toast("Backup restored", "Undo", () => {
          ws = before;
          dirty.add("ws");
          save();
          toast("Your previous data is back");
        });
      });
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
