// CareerCrumbs pure helpers. No DOM, no storage: everything here is testable in Node.
(function (root) {
  "use strict";

  // ---------- ids & dates ----------
  const uid = (p) => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const today = (now) => iso(now || new Date());
  const parse = (s) => {
    const [y, m, d] = String(s).slice(0, 10).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  };
  const addDays = (s, n) => {
    const d = parse(s);
    d.setDate(d.getDate() + n);
    return iso(d);
  };
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
  // Monday of the week that holds `s`; KPI entries are keyed by this.
  const weekOf = (s) => {
    const d = parse(s);
    const back = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - back);
    return iso(d);
  };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const fmtDate = (s) => {
    if (!s) return "";
    const d = parse(s);
    return MONTHS[d.getMonth()] + " " + d.getDate();
  };
  const fmtDateY = (s) => (s ? fmtDate(s) + ", " + parse(s).getFullYear() : "");
  const relDays = (s, now) => {
    const n = daysBetween(today(now), s);
    if (n === 0) return "today";
    if (n === 1) return "tomorrow";
    if (n === -1) return "yesterday";
    return n > 0 ? "in " + n + " days" : Math.abs(n) + " days ago";
  };

  // ---------- numbers ----------
  const num = (v) => {
    if (v === "" || v === null || v === undefined) return null;
    const n = Number(String(v).replace(/[,$%\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  const fmtNum = (n, unit) => {
    if (n === null || n === undefined || !Number.isFinite(n)) return "—";
    const r = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
    const s = r.toLocaleString("en-US");
    if (unit === "%") return s + "%";
    if (unit === "$") return (n < 0 ? "-$" : "$") + Math.abs(r).toLocaleString("en-US");
    return unit ? s + " " + unit : s;
  };

  // ---------- defaults ----------
  const COMPETENCY_PRESET = [
    ["Operational excellence", "Runs a safe, accurate, on-time building shift after shift."],
    ["People leadership", "Hires, coaches, recognises and holds the team accountable."],
    ["Data & metrics", "Reads the numbers, finds the cause, and acts on it."],
    ["Problem solving", "Gets to root cause and makes fixes stick."],
    ["Safety & compliance", "Food safety, audits, incident follow-through."],
    ["Planning & labor", "Builds schedules and labor plans that match volume."],
    ["Inventory & shrink", "Protects inventory accuracy and reduces loss."],
    ["Cross-team influence", "Moves work forward with people you don't manage."],
    ["Communication", "Clear updates up, down and across."],
    ["Change leadership", "Lands new processes and gets buy-in."],
  ];
  const RATING_LABELS = ["Not started", "Learning", "Developing", "Proficient", "Role model"];

  const KPI_PRESETS = [
    { name: "Units per hour (UPH)", unit: "UPH", better: "higher" },
    { name: "Pick accuracy", unit: "%", better: "higher" },
    { name: "Item-not-found (INF) rate", unit: "%", better: "lower" },
    { name: "Order pick time", unit: "min", better: "lower" },
    { name: "Dasher wait time", unit: "min", better: "lower" },
    { name: "On-time handoff", unit: "%", better: "higher" },
    { name: "Inventory record accuracy", unit: "%", better: "higher" },
    { name: "Shrink", unit: "$", better: "lower" },
    { name: "Labor hours per order", unit: "hrs", better: "lower" },
    { name: "Team attendance", unit: "%", better: "higher" },
    { name: "Safety incidents", unit: "", better: "lower" },
    { name: "Expired / out-of-date pulls", unit: "", better: "lower" },
  ];

  const STATIONS_PRESET = ["Receiving", "Putaway", "Picking", "Packing", "Dispatch", "Cycle counts", "Cold chain"];
  const TRAIN_LEVELS = ["—", "Training", "Certified", "Trainer"];
  const JOB_STATUSES = ["Saved", "Applied", "Interview", "Offer", "Closed"];
  const PROJECT_STATUSES = ["Idea", "Active", "Blocked", "Done"];
  const RELATIONS = ["Manager", "Skip-level", "Peer", "Mentor", "Cross-team", "HR / Recruiter"];
  const DRAFT_KINDS = {
    update: "Weekly update",
    case: "Promotion case",
    bullet: "Résumé bullets",
    oneonone: "1:1 agenda",
    brag: "Brag doc",
    other: "Other",
  };

  const emptyWorkspace = () => ({
    profile: {
      name: "",
      role: "Warehouse Supervisor",
      company: "DashMart",
      site: "",
      targetRole: "Operations Manager",
      targetDate: "",
      why: "",
    },
    wins: [],
    kpis: [],
    competencies: COMPETENCY_PRESET.map(([name, desc], i) => ({
      id: "c" + (i + 1),
      name,
      desc,
      rating: 0,
      target: 3,
      notes: "",
    })),
    plan: [],
    projects: [],
    team: [],
    stations: STATIONS_PRESET.slice(),
    people: [],
    jobs: [],
    drafts: [],
    reviews: [],
    winSeq: 0,
  });

  // Fill in anything missing so older saves and hand-edited imports still load.
  function normalize(ws) {
    const base = emptyWorkspace();
    const out = Object.assign({}, base, ws || {});
    out.profile = Object.assign({}, base.profile, (ws && ws.profile) || {});
    for (const k of ["wins", "kpis", "competencies", "plan", "projects", "team", "stations", "people", "jobs", "drafts", "reviews"]) {
      if (!Array.isArray(out[k])) out[k] = base[k];
    }
    out.kpis = out.kpis.map((k) => Object.assign({ entries: [], target: null, better: "higher", unit: "" }, k));
    out.team = out.team.map((m) => Object.assign({ notes: [], training: {} }, m));
    out.people = out.people.map((p) => Object.assign({ touches: [], cadenceDays: 14 }, p));
    out.jobs = out.jobs.map((j) => Object.assign({ history: [], status: "Saved" }, j));
    out.projects = out.projects.map((p) => Object.assign({ milestones: [], status: "Active" }, p));
    out.wins = out.wins.map((w) => Object.assign({ competencies: [], skills: [] }, w));
    out.winSeq = Math.max(Number(out.winSeq) || 0, out.wins.reduce((m, w) => Math.max(m, w.n || 0), 0));
    return out;
  }

  // ---------- wins → résumé bullets ----------
  const VERB_MAP = [
    [/^(led|lead|leading)\b/i, "Led"],
    [/^(train|trained|training|coach|coached|coaching)\b/i, "Trained"],
    [/^(reduce|reduced|cut|lower|lowered)\b/i, "Reduced"],
    [/^(improve|improved|raise|raised|increase|increased|boost|boosted)\b/i, "Improved"],
    [/^(build|built|create|created|set up|launch|launched)\b/i, "Built"],
    [/^(fix|fixed|solve|solved|resolve|resolved)\b/i, "Resolved"],
    [/^(redesign|redesigned|reorganize|reorganized|restructure|restructured)\b/i, "Redesigned"],
  ];
  const clean = (s) => String(s || "").trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const lower1 = (s) => (s && !/^[A-Z]{2}/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

  function metricPhrase(m) {
    if (!m || !m.label) return "";
    const b = num(m.before);
    const a = num(m.after);
    if (b === null || a === null) return "";
    const unit = m.unit || "";
    let delta = "";
    if (b !== 0 && unit !== "%") delta = " (" + (a > b ? "+" : "") + Math.round(((a - b) / Math.abs(b)) * 100) + "%)";
    if (unit === "%") delta = " (" + (a > b ? "+" : "") + Math.round((a - b) * 10) / 10 + " pts)";
    return m.label + " from " + fmtNum(b, unit) + " to " + fmtNum(a, unit) + delta;
  }

  // Template only. Uses the person's own words and numbers; never invents a figure.
  function bulletFromWin(w) {
    let action = clean(w.action) || clean(w.title);
    if (!action) action = "[what you did]";
    let lead = "";
    for (const [re, verb] of VERB_MAP) {
      if (re.test(action)) {
        lead = verb;
        action = action.replace(re, "").trim();
        break;
      }
    }
    let text = lead ? lead + " " + lower1(action) : cap(action);
    const metric = metricPhrase(w.metric);
    const result = clean(w.result);
    if (metric && result) text += ", moving " + metric + "; " + lower1(result);
    else if (metric) text += ", moving " + metric;
    else if (result) text += ", resulting in " + lower1(result);
    else text += ", resulting in [result — add a number if you have one]";
    return text.replace(/\s+,/g, ",") + ".";
  }

  // ---------- promotion readiness ----------
  function readiness(ws) {
    const cs = ws.competencies || [];
    const totalTarget = cs.reduce((s, c) => s + (Number(c.target) || 0), 0);
    if (!totalTarget) return { pct: 0, atTarget: 0, total: cs.length, evidenced: 0, gaps: [] };
    const met = cs.reduce((s, c) => s + Math.min(Number(c.rating) || 0, Number(c.target) || 0), 0);
    const evidence = evidenceCounts(ws);
    const gaps = cs
      .map((c) => ({ c, gap: (Number(c.target) || 0) - (Number(c.rating) || 0), ev: evidence[c.id] || 0 }))
      .filter((g) => g.gap > 0 || g.ev === 0)
      .sort((a, b) => b.gap - a.gap || a.ev - b.ev);
    return {
      pct: Math.round((met / totalTarget) * 100),
      atTarget: cs.filter((c) => (Number(c.rating) || 0) >= (Number(c.target) || 0)).length,
      total: cs.length,
      evidenced: cs.filter((c) => evidence[c.id]).length,
      gaps,
    };
  }
  function evidenceCounts(ws) {
    const out = {};
    for (const w of ws.wins || []) for (const id of w.competencies || []) out[id] = (out[id] || 0) + 1;
    return out;
  }

  // ---------- KPIs ----------
  function kpiSeries(k, weeks, now) {
    const end = weekOf(today(now));
    const map = {};
    for (const e of k.entries || []) map[e.week] = num(e.value);
    const out = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const wk = addDays(end, -7 * i);
      out.push({ week: wk, value: map[wk] === undefined ? null : map[wk] });
    }
    return out;
  }
  function kpiLatest(k) {
    const es = (k.entries || []).filter((e) => num(e.value) !== null).slice().sort((a, b) => (a.week < b.week ? 1 : -1));
    return { latest: es[0] || null, prior: es[1] || null };
  }
  function kpiStatus(k) {
    const { latest, prior } = kpiLatest(k);
    const t = num(k.target);
    const v = latest ? num(latest.value) : null;
    let state = "none";
    if (v !== null && t !== null) {
      const good = k.better === "lower" ? v <= t : v >= t;
      const near = k.better === "lower" ? v <= t * 1.05 : v >= t * 0.95;
      state = good ? "on" : near ? "near" : "off";
    } else if (v !== null) state = "logged";
    let trend = 0;
    if (latest && prior) {
      const d = num(latest.value) - num(prior.value);
      trend = d === 0 ? 0 : (d > 0) === (k.better !== "lower") ? 1 : -1;
    }
    return { state, value: v, target: t, trend, latest, prior };
  }
  // Points for an SVG sparkline; nulls break the line into segments.
  function sparkPoints(series, w, h, padY, target) {
    const vals = series.map((p) => p.value).filter((v) => v !== null);
    if (target !== null && target !== undefined) vals.push(target);
    if (!vals.length) return { segments: [], y: () => h / 2, min: 0, max: 0 };
    let min = Math.min.apply(null, vals);
    let max = Math.max.apply(null, vals);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const step = series.length > 1 ? w / (series.length - 1) : 0;
    const y = (v) => padY + (h - 2 * padY) * (1 - (v - min) / (max - min));
    const segments = [];
    let cur = [];
    series.forEach((p, i) => {
      if (p.value === null) {
        if (cur.length) segments.push(cur);
        cur = [];
      } else cur.push([Math.round(i * step * 10) / 10, Math.round(y(p.value) * 10) / 10]);
    });
    if (cur.length) segments.push(cur);
    return { segments, y, min, max };
  }

  // ---------- people & team ----------
  function lastTouch(p) {
    const ds = (p.touches || []).map((t) => t.date).concat(p.lastTouch ? [p.lastTouch] : []);
    return ds.sort().pop() || null;
  }
  function touchDue(p, now) {
    const last = lastTouch(p);
    const cadence = Number(p.cadenceDays) || 14;
    if (!last) return { due: true, days: null, label: "No touchpoint yet" };
    const since = daysBetween(last, today(now));
    const left = cadence - since;
    if (left < 0) return { due: true, days: left, label: "Overdue by " + Math.abs(left) + (left === -1 ? " day" : " days") };
    if (left === 0) return { due: true, days: 0, label: "Due today" };
    return { due: false, days: left, label: "Next in " + left + (left === 1 ? " day" : " days") };
  }
  function lastOneOnOne(m) {
    return (m.notes || []).filter((n) => n.type === "1:1").map((n) => n.date).sort().pop() || null;
  }
  function oneOnOneDue(m, now, every) {
    const last = lastOneOnOne(m);
    if (!last) return { due: true, label: "No 1:1 logged" };
    const since = daysBetween(last, today(now));
    const left = (every || 14) - since;
    return left <= 0
      ? { due: true, label: left === 0 ? "1:1 due today" : "1:1 overdue by " + -left + "d" }
      : { due: false, label: "Last 1:1 " + since + "d ago" };
  }
  // How many people are certified or trainer level per station.
  function coverage(ws) {
    const out = {};
    for (const s of ws.stations) out[s] = 0;
    for (const m of ws.team) for (const s of ws.stations) if ((m.training || {})[s] >= 2) out[s]++;
    return out;
  }

  // ---------- jobs ----------
  function setJobStatus(job, status, now) {
    const at = (now || new Date()).toISOString();
    const next = Object.assign({}, job, { status, updated: at });
    next.history = (job.history || []).concat([{ status, at }]);
    if (status === "Applied" && !job.appliedAt) next.appliedAt = at.slice(0, 10);
    return next;
  }
  function followUpBadge(job, now) {
    if (!job.followUpAt || job.status === "Closed") return null;
    const n = daysBetween(today(now), job.followUpAt);
    if (n < 0) return { tone: "bad", text: "Follow-up overdue by " + -n + (n === -1 ? " day" : " days") };
    if (n === 0) return { tone: "warn", text: "Follow up today" };
    return { tone: "", text: "Follow up " + relDays(job.followUpAt, now) };
  }

  // ---------- documents (templates) ----------
  const bullets = (arr) => arr.map((s) => "- " + s).join("\n");
  function winLine(w) {
    const m = metricPhrase(w.metric);
    return clean(w.title) + (m ? " — " + m : clean(w.result) ? " — " + clean(w.result) : "") + " (" + fmtDate(w.date) + ")";
  }
  function inRange(d, from, to) {
    return d && d >= from && d <= to;
  }

  function weeklyUpdate(ws, now) {
    const end = today(now);
    const start = addDays(end, -6);
    const p = ws.profile;
    const wins = ws.wins.filter((w) => inRange(w.date, start, end));
    const lines = ["Weekly update — " + fmtDate(start) + " to " + fmtDateY(end), ""];
    lines.push("Hi" + (managerName(ws) ? " " + managerName(ws) : "") + ", here's my week" + (p.site ? " at " + p.site : "") + ".", "");
    lines.push("WINS");
    lines.push(wins.length ? bullets(wins.map(winLine)) : "- [Add this week's wins in CareerCrumbs]");
    const k = ws.kpis.map((x) => ({ x, s: kpiStatus(x) })).filter((o) => o.s.latest && o.s.latest.week >= weekOf(start));
    if (k.length) {
      lines.push("", "NUMBERS");
      lines.push(
        bullets(
          k.map(({ x, s }) => {
            let t = x.name + ": " + fmtNum(s.value, x.unit);
            if (s.target !== null) t += " (target " + fmtNum(s.target, x.unit) + (s.state === "on" ? ", on target" : "") + ")";
            if (s.prior) t += ", " + (s.trend > 0 ? "better than" : s.trend < 0 ? "behind" : "same as") + " last week";
            return t;
          })
        )
      );
    }
    const active = ws.projects.filter((x) => x.status === "Active" || x.status === "Blocked");
    if (active.length) {
      lines.push("", "PROJECTS");
      lines.push(bullets(active.map((x) => x.title + " — " + x.status.toLowerCase() + (x.nextAction ? "; next: " + clean(x.nextAction) : ""))));
    }
    const blocked = ws.projects.filter((x) => x.status === "Blocked");
    lines.push("", "WHERE I COULD USE HELP");
    lines.push(blocked.length ? bullets(blocked.map((x) => x.title + (x.blocker ? ": " + clean(x.blocker) : ""))) : "- [Anything you need from your manager]");
    lines.push("", "NEXT WEEK");
    lines.push("- [Your top 1–3 priorities]");
    return lines.join("\n");
  }
  function managerName(ws) {
    const m = ws.people.find((x) => x.relation === "Manager");
    return m ? m.name.split(" ")[0] : "";
  }

  function promotionCase(ws) {
    const p = ws.profile;
    const ev = {};
    for (const w of ws.wins) for (const id of w.competencies || []) (ev[id] = ev[id] || []).push(w);
    const r = readiness(ws);
    const L = [];
    L.push("Promotion case: " + (p.name || "[Your name]") + " — " + p.role + " → " + p.targetRole, "");
    L.push("SUMMARY");
    L.push(
      "I'm a " + p.role + (p.company ? " at " + p.company : "") + (p.site ? " (" + p.site + ")" : "") + ". I'm working toward " + p.targetRole + (p.targetDate ? " by " + fmtDateY(p.targetDate) : "") + "."
    );
    if (p.why) L.push(clean(p.why) + ".");
    L.push("Self-assessed readiness: " + r.pct + "% across " + r.total + " competencies; " + r.evidenced + " have documented evidence.", "");
    L.push("EVIDENCE BY COMPETENCY");
    for (const c of ws.competencies) {
      const list = (ev[c.id] || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 3);
      L.push("", c.name + " — " + RATING_LABELS[c.rating || 0] + " (target: " + RATING_LABELS[c.target || 0] + ")");
      L.push(list.length ? bullets(list.map(winLine)) : "- [Gap: log a win that shows this]");
    }
    const kp = ws.kpis.map((k) => ({ k, s: kpiStatus(k) })).filter((o) => o.s.latest);
    if (kp.length) {
      L.push("", "RESULTS I OWN");
      L.push(bullets(kp.map(({ k, s }) => k.name + ": " + fmtNum(s.value, k.unit) + (s.target !== null ? " vs target " + fmtNum(s.target, k.unit) : ""))));
    }
    const done = ws.projects.filter((x) => x.status === "Done");
    if (done.length) {
      L.push("", "PROJECTS DELIVERED");
      L.push(bullets(done.map((x) => x.title + (x.result ? " — " + clean(x.result) : ""))));
    }
    if (ws.team.length) {
      const cov = coverage(ws);
      const certified = Object.values(cov).reduce((a, b) => a + b, 0);
      L.push("", "DEVELOPING MY TEAM");
      L.push("- Team of " + ws.team.length + "; " + certified + " station certifications across " + ws.stations.length + " stations.");
      const rec = ws.team.reduce((s, m) => s + (m.notes || []).filter((n) => n.type === "Recognition").length, 0);
      if (rec) L.push("- " + rec + " recognitions given and logged.");
    }
    L.push("", "WHAT I'M ASKING FOR");
    L.push("- [The role, the timeline, and the support you need]");
    return L.join("\n");
  }

  function oneOnOneAgenda(m, ws, now) {
    const notes = (m.notes || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    const last = notes.find((n) => n.type === "1:1");
    const L = ["1:1 with " + m.name + " — " + fmtDateY(today(now)), ""];
    L.push("CHECK-IN", "- How are you doing, honestly? Anything getting in the way?", "");
    L.push("FOLLOW-UPS FROM LAST TIME");
    L.push(last ? "- " + clean(last.text) + " (" + fmtDate(last.date) + ")" : "- [First logged 1:1]");
    L.push("", "RECOGNITION");
    const rec = notes.filter((n) => n.type === "Recognition").slice(0, 2);
    L.push(rec.length ? bullets(rec.map((n) => clean(n.text))) : "- [Something specific they did well this week]");
    L.push("", "GROWTH");
    L.push("- Goal: " + (clean(m.growth) || "[Agree a growth goal]"));
    const training = Object.entries(m.training || {}).filter(([, v]) => v === 1).map(([s]) => s);
    if (training.length) L.push("- In training on: " + training.join(", ") + ". What's left before sign-off?");
    const next = (ws.stations || []).filter((s) => !(m.training || {})[s]);
    if (next.length) L.push("- Next station to cross-train: " + next[0] + "?");
    L.push("", "ACTIONS", "- [Who does what, by when]");
    return L.join("\n");
  }

  function bragDoc(ws, from, to) {
    const wins = ws.wins.filter((w) => inRange(w.date, from, to)).sort((a, b) => (a.date < b.date ? -1 : 1));
    const L = ["# Brag doc — " + fmtDateY(from) + " to " + fmtDateY(to), ""];
    if (!wins.length) L.push("No wins logged in this range yet.");
    for (const w of wins) {
      L.push("## " + clean(w.title) + " — " + fmtDateY(w.date));
      if (w.situation) L.push("**Situation:** " + clean(w.situation));
      if (w.action) L.push("**What I did:** " + clean(w.action));
      if (w.result) L.push("**Result:** " + clean(w.result));
      const m = metricPhrase(w.metric);
      if (m) L.push("**Measured:** " + m);
      const cs = (w.competencies || []).map((id) => (ws.competencies.find((c) => c.id === id) || {}).name).filter(Boolean);
      if (cs.length) L.push("**Shows:** " + cs.join(", "));
      L.push("");
    }
    return L.join("\n");
  }

  // ---------- home agenda ----------
  function agenda(ws, now) {
    const t = today(now);
    const items = [];
    for (const j of ws.jobs) {
      const b = followUpBadge(j, now);
      if (b && (b.tone === "bad" || b.tone === "warn")) items.push({ kind: "job", id: j.id, tone: b.tone, title: "Follow up: " + j.company, sub: j.title + " · " + b.text, route: "jobs" });
    }
    for (const p of ws.people) {
      const d = touchDue(p, now);
      if (d.due) items.push({ kind: "person", id: p.id, tone: d.days !== null && d.days < 0 ? "bad" : "warn", title: "Touch base with " + p.name, sub: p.relation + " · " + d.label, route: "people" });
    }
    for (const m of ws.team) {
      const d = oneOnOneDue(m, now, 14);
      if (d.due) items.push({ kind: "team", id: m.id, tone: "warn", title: "1:1 with " + m.name, sub: d.label, route: "team" });
    }
    for (const p of ws.projects) {
      if (p.status === "Blocked") items.push({ kind: "project", id: p.id, tone: "bad", title: "Unblock: " + p.title, sub: clean(p.blocker) || "Blocked", route: "projects" });
      else if (p.status === "Active" && p.due && daysBetween(t, p.due) <= 3)
        items.push({ kind: "project", id: p.id, tone: daysBetween(t, p.due) < 0 ? "bad" : "warn", title: p.title, sub: "Due " + relDays(p.due, now) + (p.nextAction ? " · " + clean(p.nextAction) : ""), route: "projects" });
    }
    const wk = weekOf(t);
    const unlogged = ws.kpis.filter((k) => !(k.entries || []).some((e) => e.week === wk && num(e.value) !== null));
    if (unlogged.length && ws.kpis.length)
      items.push({ kind: "kpi", tone: "", title: "Log this week's numbers", sub: unlogged.length + " of " + ws.kpis.length + " metrics not logged for the week of " + fmtDate(wk), route: "metrics" });
    for (const s of ws.plan || []) {
      if (!s.done && s.due && daysBetween(t, s.due) <= 7)
        items.push({ kind: "plan", id: s.id, tone: daysBetween(t, s.due) < 0 ? "bad" : "", title: s.text, sub: "Plan step · due " + relDays(s.due, now), route: "path" });
    }
    const rank = { bad: 0, warn: 1, "": 2 };
    return items.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }

  function weekStats(ws, now) {
    const end = today(now);
    const start = addDays(end, -6);
    const kp = ws.kpis.map(kpiStatus);
    return {
      wins7: ws.wins.filter((w) => inRange(w.date, start, end)).length,
      wins30: ws.wins.filter((w) => inRange(w.date, addDays(end, -29), end)).length,
      onTarget: kp.filter((s) => s.state === "on").length,
      withTarget: kp.filter((s) => s.state !== "none" && s.state !== "logged").length,
      activeProjects: ws.projects.filter((p) => p.status === "Active").length,
    };
  }

  // Wins per week for the last n weeks (oldest first).
  function winsByWeek(ws, n, now) {
    const end = weekOf(today(now));
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const wk = addDays(end, -7 * i);
      const nx = addDays(wk, 6);
      out.push({ week: wk, count: ws.wins.filter((w) => inRange(w.date, wk, nx)).length });
    }
    return out;
  }

  // ---------- example workspace (clearly labelled in the UI) ----------
  function exampleWorkspace(now) {
    const t = today(now);
    const d = (n) => addDays(t, n);
    const wk = (n) => addDays(weekOf(t), -7 * n);
    const ws = emptyWorkspace();
    ws.profile = Object.assign(ws.profile, { name: "", site: "Example site", targetDate: d(180), why: "I want to own the whole building's results, not just my shift" });
    const c = (i, r, tg) => Object.assign(ws.competencies[i], { rating: r, target: tg || 3 });
    c(0, 3); c(1, 2); c(2, 2, 4); c(3, 3); c(4, 3); c(5, 1); c(6, 2); c(7, 1); c(8, 2); c(9, 1);
    const win = (n, days, title, s, a, r, metric, comps) => ({ id: "w" + n, n, date: d(days), title, situation: s, action: a, result: r, metric, competencies: comps, skills: [], created: d(days) });
    ws.wins = [
      win(1, -2, "Cut INF misses on the frozen aisle", "Frozen picks were driving item-not-found refunds.", "Reorganized frozen slotting by velocity and added a mid-shift freezer audit", "Fewer refunds and fewer customer complaints", { label: "frozen INF rate", before: "4.1", after: "2.3", unit: "%" }, ["c1", "c3", "c7"]),
      win(2, -9, "Cross-trained two packers on receiving", "Receiving bottlenecked whenever one person called out.", "Trained Jordan and Sam on receiving and signed them off", "Truck check-in no longer depends on one person", null, ["c2", "c6"]),
      win(3, -16, "Closed out the health inspection with zero findings", "Annual inspection on short notice.", "Led a two-day walk-through of cold chain logs and date checks", "Zero findings", null, ["c5", "c1"]),
      win(4, -30, "Fixed the Sunday labor gap", "Sunday close was understaffed for evening peak.", "Rebuilt the Sunday schedule from four weeks of order-volume data", "Peak covered without adding hours", { label: "Sunday on-time handoff", before: "88", after: "96", unit: "%" }, ["c6", "c3"]),
    ];
    ws.winSeq = 4;
    const series = (vals) => vals.map((v, i) => ({ week: wk(vals.length - 1 - i), value: v }));
    ws.kpis = [
      { id: "k1", name: "Units per hour (UPH)", unit: "UPH", better: "higher", target: 95, entries: series([84, 86, 85, 88, 91, 90, 93, 96]) },
      { id: "k2", name: "Pick accuracy", unit: "%", better: "higher", target: 99.5, entries: series([99.1, 99.2, 99.0, 99.3, 99.4, 99.6, 99.5, 99.6]) },
      { id: "k3", name: "Item-not-found (INF) rate", unit: "%", better: "lower", target: 2.5, entries: series([3.9, 4.1, 3.6, 3.4, 3.0, 2.8, 2.6, 2.4]) },
      { id: "k4", name: "Dasher wait time", unit: "min", better: "lower", target: 4, entries: series([5.2, 5.0, 4.9, 5.1, 4.6, 4.4, 4.5, 4.3]) },
    ];
    ws.plan = [
      { id: "p1", phase: "30", text: "Ask my manager what 'ready' looks like for Ops Manager", done: true, due: d(-10) },
      { id: "p2", phase: "30", text: "Shadow the Ops Manager through one weekly labor plan", done: false, due: d(5) },
      { id: "p3", phase: "60", text: "Own the weekly shrink review for one month", done: false, due: d(40) },
      { id: "p4", phase: "90", text: "Present a building-wide INF reduction plan", done: false, due: d(85) },
    ];
    ws.projects = [
      { id: "pr1", title: "Velocity-based slotting, ambient aisles", status: "Active", impact: "Shorter pick paths, higher UPH", nextAction: "Pull 4 weeks of pick data by SKU", due: d(2), stakeholders: "Ops Manager, inventory lead", milestones: [{ text: "Map current slots", done: true }, { text: "Rank SKUs by velocity", done: false }, { text: "Move top 50", done: false }] },
      { id: "pr2", title: "New-hire buddy program", status: "Blocked", blocker: "Waiting on HR for buddy incentive approval", impact: "Faster ramp, lower 30-day turnover", nextAction: "Follow up with HR", due: d(10), stakeholders: "HR, Ops Manager", milestones: [] },
      { id: "pr3", title: "Freezer audit checklist", status: "Done", result: "Frozen INF down from 4.1% to 2.3%", impact: "", nextAction: "", milestones: [] },
    ];
    ws.team = [
      { id: "t1", name: "Jordan (example)", role: "Picker", shift: "AM", growth: "Become a shift lead", notes: [{ id: "n1", date: d(-16), type: "1:1", text: "Wants more ownership; agreed to run the receiving huddle" }, { id: "n2", date: d(-3), type: "Recognition", text: "Caught a mislabeled cold-chain pallet" }], training: { Receiving: 2, Picking: 3, Packing: 2 } },
      { id: "t2", name: "Sam (example)", role: "Packer", shift: "PM", growth: "Get certified on receiving", notes: [{ id: "n3", date: d(-6), type: "1:1", text: "Receiving sign-off next week" }], training: { Packing: 3, Receiving: 1, Dispatch: 2 } },
      { id: "t3", name: "Riley (example)", role: "Inventory associate", shift: "AM", growth: "Lead cycle counts", notes: [], training: { "Cycle counts": 2, Putaway: 2, Picking: 2 } },
    ];
    ws.people = [
      { id: "s1", name: "Alex (example)", relation: "Manager", role: "Operations Manager", cadenceDays: 7, touches: [{ date: d(-8), kind: "Weekly update", note: "Sent update with INF numbers" }], notes: "Cares most about INF and labor" },
      { id: "s2", name: "Morgan (example)", relation: "Skip-level", role: "Regional Ops", cadenceDays: 30, touches: [{ date: d(-20), kind: "Site visit", note: "Walked frozen slotting" }], notes: "" },
      { id: "s3", name: "Casey (example)", relation: "Mentor", role: "Ops Manager, other site", cadenceDays: 21, touches: [], notes: "" },
    ];
    ws.jobs = [
      { id: "j1", title: "Operations Manager", company: "DashMart (internal)", internal: true, status: "Saved", followUpAt: d(0), nextStep: "Ask Alex about the opening", history: [{ status: "Saved", at: new Date(parse(d(-4))).toISOString() }], created: d(-4) },
    ];
    ws.reviews = [{ id: "r1", week: wk(1), wentWell: "Frozen INF finally moved.", stuck: "HR approval on the buddy program.", nextFocus: "Get slotting data pulled.", energy: 4, created: d(-5) }];
    return ws;
  }

  const api = {
    uid, iso, today, parse, addDays, daysBetween, weekOf, fmtDate, fmtDateY, relDays, num, fmtNum,
    COMPETENCY_PRESET, RATING_LABELS, KPI_PRESETS, STATIONS_PRESET, TRAIN_LEVELS, JOB_STATUSES, PROJECT_STATUSES, RELATIONS, DRAFT_KINDS,
    emptyWorkspace, normalize, metricPhrase, bulletFromWin, readiness, evidenceCounts,
    kpiSeries, kpiLatest, kpiStatus, sparkPoints, lastTouch, touchDue, lastOneOnOne, oneOnOneDue, coverage,
    setJobStatus, followUpBadge, weeklyUpdate, promotionCase, oneOnOneAgenda, bragDoc, agenda, weekStats, winsByWeek, exampleWorkspace,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CC = api;
})(typeof window !== "undefined" ? window : globalThis);
