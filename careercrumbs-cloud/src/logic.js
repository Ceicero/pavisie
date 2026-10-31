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
    huddle: "Huddle & handoff",
    a3: "Problem sheet (A3)",
    interview: "Interview answers",
    quarter: "Quarterly review",
    coach: "From Ruhv",
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
    shifts: [],
    problems: [],
    learning: [],
    interview: { stories: {}, practice: [] },
    toolInputs: {},
    coach: [],
    feedback: [],
    schedule: { weeks: {}, needs: [], hoursPerShift: 8 },
    priorities: {},
    winSeq: 0,
  });

  // Fill in anything missing so older saves and hand-edited imports still load.
  function normalize(ws) {
    const base = emptyWorkspace();
    const out = Object.assign({}, base, ws || {});
    out.profile = Object.assign({}, base.profile, (ws && ws.profile) || {});
    for (const k of ["wins", "kpis", "competencies", "plan", "projects", "team", "stations", "people", "jobs", "drafts", "reviews", "shifts", "problems", "learning", "coach", "feedback"]) {
      if (!Array.isArray(out[k])) out[k] = base[k];
    }
    out.kpis = out.kpis.map((k) => Object.assign({ entries: [], target: null, better: "higher", unit: "" }, k));
    out.team = out.team.map((m) => Object.assign({ notes: [], training: {} }, m));
    out.people = out.people.map((p) => Object.assign({ touches: [], cadenceDays: 14 }, p));
    out.jobs = out.jobs.map((j) => Object.assign({ history: [], status: "Saved" }, j));
    out.projects = out.projects.map((p) => Object.assign({ milestones: [], status: "Active" }, p));
    out.wins = out.wins.map((w) => Object.assign({ competencies: [], skills: [] }, w));
    const iv = (ws && ws.interview) || {};
    out.interview = { stories: Object.assign({}, iv.stories), practice: Array.isArray(iv.practice) ? iv.practice : [] };
    out.toolInputs = Object.assign({}, ws && ws.toolInputs);
    const sc = (ws && ws.schedule) || {};
    out.schedule = { weeks: Object.assign({}, sc.weeks), needs: Array.isArray(sc.needs) ? sc.needs : [], hoursPerShift: Number(sc.hoursPerShift) || 8 };
    out.priorities = Object.assign({}, ws && ws.priorities);
    out.shifts = out.shifts.map((x) => Object.assign({ safety: [] }, x));
    out.problems = out.problems.map((x) => Object.assign({ whys: [], causes: {}, countermeasures: [], status: "Open" }, x));
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
    ws.shifts = [
      { id: "sh1", date: d(-1), shift: "AM", orders: 412, headcount: 9, laborHours: 68, wentWell: "Frozen audit caught 6 mis-slots before the lunch wave", issues: "Two late trucks pushed putaway into peak", handoff: "Finish putaway on aisle 7 before 5pm wave", safety: [{ kind: "Near miss", text: "Pallet jack left in the handoff walkway" }] },
      { id: "sh2", date: d(-2), shift: "AM", orders: 388, headcount: 8, laborHours: 64, wentWell: "Sam ran receiving solo for the first time", issues: "", handoff: "", safety: [] },
    ];
    ws.problems = [
      { id: "pb1", title: "Frozen INF spikes after deliveries", status: "Countermeasures", created: d(-35), problem: "Frozen item-not-found rises to 5%+ on delivery days", impact: "Refunds, unhappy customers, INF above target", whys: ["Pickers can't find the item", "It's in overflow, not the pick face", "Putaway puts it wherever there's room", "No assigned overflow slots for frozen", "Slotting was never set up for frozen velocity"], causes: { Process: "No overflow rule", Measurement: "INF not split by temp zone" }, rootCause: "Frozen has no velocity-based slotting or overflow rule", countermeasures: [{ text: "Slot frozen by velocity", owner: "Me", due: d(-10), done: true }, { text: "Mid-shift freezer audit", owner: "Jordan", due: d(-5), done: true }], check: "Frozen INF under 2.5% for 4 straight weeks" },
    ];
    ws.learning = [
      { id: "l1", title: "OSHA 10-hour General Industry", type: "Certification", comp: "c5", status: "Done", hours: 10, doneAt: d(-60) },
      { id: "l2", title: "Lean Six Sigma Yellow Belt", type: "Certification", comp: "c4", status: "In progress", hours: 6, due: d(30) },
      { id: "l3", title: "Shadow the Ops Manager's weekly labor plan", type: "Shadowing", comp: "c6", status: "Planned", due: d(5) },
    ];
    ws.interview = { stories: { q1: "w1", q5: "w3", q13: "w4" }, practice: [] };
    const thisWk = weekOf(t);
    ws.schedule = { hoursPerShift: 8, needs: [3, 3, 3, 3, 4, 4, 3], weeks: { [thisWk]: { t1: ["AM", "AM", "AM", "OFF", "AM", "AM", "OFF"], t2: ["PM", "PM", "OFF", "PM", "PM", "PM", "OFF"], t3: ["AM", "OFF", "AM", "AM", "AM", "OFF", "AM"] } } };
    ws.feedback = [
      { id: "f1", date: d(-12), from: "Alex (example)", kind: "Praise", text: "Your INF write-up was exactly what I needed for the regional call", comp: "c3", actedOn: true },
      { id: "f2", date: d(-5), from: "Alex (example)", kind: "Coaching", text: "Speak up more in the site leads meeting; bring one number and one ask", comp: "c8", actedOn: false },
    ];
    ws.priorities = { [thisWk]: [{ text: "Get slotting data pulled", done: true }, { text: "Sign off Sam on receiving", done: false }, { text: "Bring INF trend to the leads meeting", done: false }] };
    ws.team[2].onboarding = NEW_HIRE_CHECKLIST.map((text, i) => ({ text, done: i < 4 }));
    ws.team[2].hiredAt = d(-12);
    ws.reviews = [{ id: "r1", week: wk(1), wentWell: "Frozen INF finally moved.", stuck: "HR approval on the buddy program.", nextFocus: "Get slotting data pulled.", energy: 4, created: d(-5) }];
    return ws;
  }

  // =====================================================================
  // v2: shift log, interview prep, calculators, problem solving, learning,
  // insights, search, calendar export
  // =====================================================================

  const SHIFTS = ["AM", "PM", "Overnight", "Weekend"];
  const SAFETY_KINDS = ["Near miss", "Incident", "Observation", "Hazard fixed"];

  // Rotating huddle topics for a dark-store warehouse floor. General guidance only.
  const SAFETY_TOPICS = [
    ["Lifting", "Bend at the knees, keep the load close, and ask for a team lift on anything heavy or awkward."],
    ["Box cutters", "Cut away from your body, retract the blade every time, and never leave a cutter open on a shelf."],
    ["Step stools", "Use the stool, not a shelf or a crate. Three points of contact, and don't overreach."],
    ["Freezer work", "Wear the freezer gear, take your warm-up breaks, and tell a lead if you're feeling numb."],
    ["Spills", "Stop, block it, clean it or call it in. Nobody walks past a wet floor."],
    ["Pallet jacks", "Push, don't pull. Watch corners and pedestrians, and park it out of walkways."],
    ["Clear exits", "Fire exits, extinguishers and electrical panels stay clear. Check them during your first lap."],
    ["Stacking", "Heavy on the bottom, light on top, and nothing past the shelf edge."],
    ["Broken glass", "Use a broom and dustpan, never hands. Bag it, label it, and tell the next shift."],
    ["Near misses", "A near miss is a free lesson. Report it, even if nobody got hurt."],
    ["Cold chain", "Check temps at receiving. Frozen and refrigerated goods go away first, before ambient."],
    ["Allergens", "Keep damaged allergen items separate and clean the area before it touches other product."],
    ["Wrists & scanning", "Switch hands, keep wrists straight, and stretch between waves."],
    ["Handoff area", "Keep the dasher pickup area clear of carts and boxes. It's a walkway first."],
    ["Evacuation", "Know two ways out and where we meet. New hires walk the route this week."],
    ["Cleaning chemicals", "Keep chemicals in labelled containers away from food. Know where the safety data sheets are."],
    ["Blade disposal", "Old blades go in the sharps container, never the trash."],
    ["Fatigue", "Take your breaks. Tired people make mistakes, so speak up if you need a reset."],
    ["Hydration", "Water at every break, especially in the warm zones and on long shifts."],
    ["Reporting injuries", "Every injury gets reported the same shift, even small ones. It protects you."],
  ];
  function safetyTopic(dateStr) {
    const d = parse(dateStr);
    const start = new Date(d.getFullYear(), 0, 1);
    const doy = Math.round((d - start) / 864e5);
    return SAFETY_TOPICS[doy % SAFETY_TOPICS.length];
  }

  function huddleText(ws, dateStr, shift) {
    const prev = (ws.shifts || []).filter((s) => s.date < dateStr).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    const [topic, tip] = safetyTopic(dateStr);
    const L = ["Huddle — " + fmtDateY(dateStr) + (shift ? " · " + shift + " shift" : ""), ""];
    L.push("SAFETY: " + topic, "- " + tip, "");
    L.push("LAST SHIFT");
    if (prev) {
      if (prev.orders) L.push("- " + prev.orders + " orders" + (prev.headcount ? " with " + prev.headcount + " people" : ""));
      if (prev.wentWell) L.push("- Went well: " + clean(prev.wentWell));
      if (prev.issues) L.push("- Watch out: " + clean(prev.issues));
      if (prev.handoff) L.push("- Handoff: " + clean(prev.handoff));
    } else L.push("- [Quick recap of yesterday]");
    const kp = (ws.kpis || []).map((k) => ({ k, s: kpiStatus(k) })).filter((o) => o.s.latest && o.s.target !== null);
    const off = kp.filter((o) => o.s.state === "off" || o.s.state === "near");
    L.push("", "TODAY'S FOCUS");
    if (off.length) L.push(bullets(off.slice(0, 2).map((o) => o.k.name + " is at " + fmtNum(o.s.value, o.k.unit) + "; target " + fmtNum(o.s.target, o.k.unit))));
    else L.push("- [One number or habit to focus on]");
    const recentRec = [];
    for (const m of ws.team || []) for (const n of m.notes || []) if (n.type === "Recognition" && daysBetween(n.date, dateStr) <= 3 && daysBetween(n.date, dateStr) >= 0) recentRec.push(m.name.replace(/\s*\(example\)/, "") + ": " + clean(n.text));
    L.push("", "SHOUT-OUTS");
    L.push(recentRec.length ? bullets(recentRec.slice(0, 3)) : "- [Recognise someone by name for something specific]");
    L.push("", "QUESTIONS / BLOCKERS", "- [Open the floor]");
    return L.join("\n");
  }

  function handoffText(s) {
    const L = ["Shift handoff — " + fmtDateY(s.date) + (s.shift ? " · " + s.shift : ""), ""];
    const nums = [];
    if (s.orders) nums.push(s.orders + " orders");
    if (s.headcount) nums.push(s.headcount + " on shift");
    if (s.laborHours) nums.push(s.laborHours + " labor hrs");
    if (s.orders && s.laborHours) nums.push((Math.round((num(s.orders) / num(s.laborHours)) * 10) / 10) + " orders/labor hr");
    if (nums.length) L.push("VOLUME: " + nums.join(" · "), "");
    L.push("WENT WELL", s.wentWell ? "- " + clean(s.wentWell) : "- —", "");
    L.push("ISSUES", s.issues ? "- " + clean(s.issues) : "- None", "");
    const saf = s.safety || [];
    L.push("SAFETY", saf.length ? bullets(saf.map((x) => x.kind + ": " + clean(x.text))) : "- Nothing reported", "");
    L.push("FOR THE NEXT SHIFT", s.handoff ? "- " + clean(s.handoff) : "- [Anything they need to pick up]");
    return L.join("\n");
  }

  // ---------- interview prep ----------
  // Behavioural questions a hiring panel commonly uses for operations manager roles.
  const INTERVIEW_QS = [
    ["q1", "Tell me about a time you improved a key metric in your building.", ["c1", "c3"]],
    ["q2", "Describe a time you used data to find the real cause of a problem.", ["c3", "c4"]],
    ["q3", "Tell me about a time you had to coach an underperforming team member.", ["c2"]],
    ["q4", "Give an example of developing someone on your team into a bigger role.", ["c2", "c10"]],
    ["q5", "Tell me about a safety issue you caught and how you handled it.", ["c5"]],
    ["q6", "How have you handled a shift where volume far exceeded your labor plan?", ["c6", "c1"]],
    ["q7", "Describe a time you reduced shrink, waste or inventory errors.", ["c7", "c4"]],
    ["q8", "Tell me about a time you influenced someone you didn't manage.", ["c8"]],
    ["q9", "Describe a change you introduced that people resisted. How did you land it?", ["c10", "c8"]],
    ["q10", "Tell me about a time you made a decision with incomplete information.", ["c4", "c1"]],
    ["q11", "Give an example of a difficult conversation you had with an employee.", ["c2", "c9"]],
    ["q12", "Tell me about a time you missed a target. What did you do next?", ["c1", "c4"]],
    ["q13", "How have you built a schedule or labor plan around forecast volume?", ["c6", "c3"]],
    ["q14", "Describe how you keep your manager informed on what matters.", ["c9"]],
    ["q15", "Tell me about a process you made simpler or faster.", ["c4", "c1"]],
    ["q16", "Describe a time you handled conflict between two team members.", ["c2", "c9"]],
    ["q17", "Tell me about a time you had to enforce a policy that was unpopular.", ["c5", "c2"]],
    ["q18", "Give an example of how you recognise and motivate your team.", ["c2"]],
    ["q19", "Tell me about a time you worked with another team to fix a customer issue.", ["c8", "c4"]],
    ["q20", "How have you prepared for or passed an audit or inspection?", ["c5", "c7"]],
    ["q21", "Describe a time you had to prioritise competing urgent problems on shift.", ["c1", "c6"]],
    ["q22", "Tell me about a mistake you made as a leader and what you learned.", ["c2", "c9"]],
    ["q23", "Why do you want to be an operations manager, and why now?", ["c9", "c10"]],
    ["q24", "What would you change in your first 90 days running a building?", ["c10", "c1"]],
  ].map(([id, q, comps]) => ({ id, q, comps }));

  function suggestStories(ws, q) {
    return (ws.wins || [])
      .map((w) => ({ w, score: (w.competencies || []).filter((c) => q.comps.includes(c)).length + (metricPhrase(w.metric) ? 0.5 : 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || (a.w.date < b.w.date ? 1 : -1))
      .slice(0, 4)
      .map((x) => x.w);
  }
  function interviewReadiness(ws) {
    const st = (ws.interview && ws.interview.stories) || {};
    const ready = INTERVIEW_QS.filter((q) => st[q.id] && (ws.wins || []).some((w) => w.id === st[q.id])).length;
    return { ready, total: INTERVIEW_QS.length, pct: Math.round((ready / INTERVIEW_QS.length) * 100) };
  }
  function starAnswer(w) {
    const L = [];
    L.push("SITUATION: " + (clean(w.situation) || "[Set the scene: where, when, what was at stake]") + ".");
    L.push("TASK: [What you were responsible for]");
    L.push("ACTION: " + (clean(w.action) || "[What you did, step by step, using I not we]") + ".");
    const m = metricPhrase(w.metric);
    L.push("RESULT: " + [clean(w.result), m].filter(Boolean).join("; ") + (clean(w.result) || m ? "." : "[The measurable outcome]"));
    L.push("LEARNED: [What you'd repeat or do differently]");
    return L.join("\n");
  }

  // ---------- calculators (inputs are always the person's own) ----------
  function laborPlan(i) {
    const orders = num(i.orders), upo = num(i.unitsPerOrder), uph = num(i.uph), shiftHours = num(i.shiftHours) || 8;
    const overhead = num(i.overhead) || 0, wage = num(i.wage);
    if (!orders || !upo || !uph) return null;
    const units = orders * upo;
    const pickHours = units / uph;
    const totalHours = pickHours * (1 + overhead / 100);
    const out = { units, pickHours, totalHours, headcount: Math.ceil(totalHours / shiftHours), cost: wage ? totalHours * wage : null, ordersPerLaborHour: orders / totalHours };
    const newUph = num(i.newUph);
    if (newUph && newUph > 0) {
      const newTotal = (units / newUph) * (1 + overhead / 100);
      const days = num(i.daysPerWeek) || 7;
      out.whatIf = {
        newUph,
        hoursSavedPerDay: totalHours - newTotal,
        hoursSavedPerWeek: (totalHours - newTotal) * days,
        hoursSavedPerYear: (totalHours - newTotal) * days * 52,
        dollarsPerYear: wage ? (totalHours - newTotal) * days * 52 * wage : null,
        newHeadcount: Math.ceil(newTotal / shiftHours),
      };
    }
    return out;
  }
  function impactCalc(i) {
    const mins = num(i.minutesPerOrder), orders = num(i.ordersPerDay), days = num(i.daysPerWeek) || 7, wage = num(i.wage);
    if (!mins || !orders) return null;
    const hoursWeek = (mins * orders * days) / 60;
    return { hoursWeek, hoursYear: hoursWeek * 52, dollarsYear: wage ? hoursWeek * 52 * wage : null };
  }

  // ---------- problem solving (A3) ----------
  const FISHBONE = ["People", "Process", "Equipment", "Materials", "Measurement", "Environment"];
  function a3Text(p) {
    const L = ["A3: " + (clean(p.title) || "[Problem]"), "Owner: " + (p.owner || "me") + " · Opened " + fmtDateY(p.created || ""), ""];
    L.push("1. PROBLEM", clean(p.problem) || "[What is happening, where, since when, how often]", "");
    L.push("2. IMPACT", clean(p.impact) || "[Which number it hurts and by how much]", "");
    L.push("3. FIVE WHYS");
    const whys = (p.whys || []).filter((x) => clean(x));
    L.push(whys.length ? whys.map((w, i) => "   Why " + (i + 1) + ": " + clean(w)).join("\n") : "   [Ask why until you reach something you can fix]");
    const causes = Object.entries(p.causes || {}).filter(([, v]) => clean(v));
    if (causes.length) {
      L.push("", "4. CONTRIBUTING CAUSES");
      L.push(causes.map(([k, v]) => "   " + k + ": " + clean(v)).join("\n"));
    }
    L.push("", (causes.length ? "5" : "4") + ". ROOT CAUSE", clean(p.rootCause) || "[One sentence]", "");
    L.push((causes.length ? "6" : "5") + ". COUNTERMEASURES");
    const cms = p.countermeasures || [];
    L.push(cms.length ? cms.map((c) => "   [" + (c.done ? "x" : " ") + "] " + clean(c.text) + (c.owner ? " — " + c.owner : "") + (c.due ? " by " + fmtDate(c.due) : "")).join("\n") : "   [What you'll change, who owns it, by when]");
    L.push("", (causes.length ? "7" : "6") + ". CHECK", clean(p.check) || "[How you'll know it worked, and when you'll look]");
    return L.join("\n");
  }

  // ---------- learning ----------
  const LEARNING_TYPES = ["Course", "Certification", "Book", "Shadowing", "Mentoring", "Project stretch"];
  const LEARNING_SUGGESTIONS = [
    ["OSHA 10-hour General Industry", "Certification", "c5"],
    ["Food safety manager certification", "Certification", "c5"],
    ["Lean Six Sigma Yellow Belt", "Certification", "c4"],
    ["Lean Six Sigma Green Belt", "Certification", "c4"],
    ["First Aid / CPR / AED", "Certification", "c5"],
    ["Powered industrial truck train-the-trainer", "Certification", "c2"],
    ["Excel: pivot tables and lookups", "Course", "c3"],
    ["Shadow the Ops Manager's weekly labor plan", "Shadowing", "c6"],
    ["Shadow a P&L / shrink review", "Shadowing", "c7"],
    ["Run a site meeting with your manager watching", "Project stretch", "c9"],
    ["Book: The Goal (Goldratt)", "Book", "c4"],
    ["Book: Crucial Conversations", "Book", "c2"],
  ];

  // ---------- insights ----------
  function activityByDay(ws, days, now) {
    const end = today(now);
    const start = addDays(end, -(days - 1));
    const c = {};
    const bump = (d) => {
      if (d && d >= start && d <= end) c[d] = (c[d] || 0) + 1;
    };
    for (const w of ws.wins || []) bump(w.date);
    for (const m of ws.team || []) for (const n of m.notes || []) bump(n.date);
    for (const p of ws.people || []) for (const t of p.touches || []) bump(t.date);
    for (const s of ws.shifts || []) bump(s.date);
    for (const r of ws.reviews || []) bump(r.created);
    for (const k of ws.kpis || []) for (const e of k.entries || []) bump(e.loggedAt);
    return { start, end, counts: c };
  }
  function kpiHitRate(k) {
    const t = num(k.target);
    const es = (k.entries || []).filter((e) => num(e.value) !== null);
    if (t === null || !es.length) return null;
    const hit = es.filter((e) => (k.better === "lower" ? num(e.value) <= t : num(e.value) >= t)).length;
    return { hit, total: es.length, pct: Math.round((hit / es.length) * 100) };
  }
  function recognitionGaps(ws, days, now) {
    const t = today(now);
    return (ws.team || []).filter((m) => {
      const last = (m.notes || []).filter((n) => n.type === "Recognition").map((n) => n.date).sort().pop();
      return !last || daysBetween(last, t) > days;
    });
  }
  function evidenceByMonth(ws, months, now) {
    const d = parse(today(now));
    const keys = [];
    for (let i = months - 1; i >= 0; i--) {
      const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
      keys.push(x.getFullYear() + "-" + pad(x.getMonth() + 1));
    }
    const rows = (ws.competencies || []).map((c) => ({ c, counts: keys.map((k) => (ws.wins || []).filter((w) => (w.date || "").slice(0, 7) === k && (w.competencies || []).includes(c.id)).length) }));
    return { keys, rows };
  }
  function quarterlyReview(ws, now) {
    const end = today(now);
    const start = addDays(end, -89);
    const wins = (ws.wins || []).filter((w) => inRange(w.date, start, end)).sort((a, b) => (a.date < b.date ? 1 : -1));
    const L = ["Quarterly review — " + fmtDateY(start) + " to " + fmtDateY(end), ""];
    L.push("HEADLINE", "- [One sentence: the most important thing you delivered]", "");
    L.push("TOP WINS");
    L.push(wins.length ? bullets(wins.slice(0, 6).map(winLine)) : "- [No wins logged this quarter]");
    const kp = (ws.kpis || []).map((k) => ({ k, h: kpiHitRate(k), s: kpiStatus(k) })).filter((o) => o.h);
    if (kp.length) {
      L.push("", "NUMBERS");
      L.push(bullets(kp.map((o) => o.k.name + ": on target " + o.h.hit + " of " + o.h.total + " weeks logged; latest " + fmtNum(o.s.value, o.k.unit))));
    }
    const done = (ws.projects || []).filter((p) => p.status === "Done" && (!p.updated || p.updated.slice(0, 10) >= start));
    if (done.length) L.push("", "PROJECTS DELIVERED", bullets(done.map((p) => p.title + (p.result ? " — " + clean(p.result) : ""))));
    const notes = [];
    for (const m of ws.team || []) for (const n of m.notes || []) if (inRange(n.date, start, end)) notes.push(n);
    L.push("", "TEAM", "- " + notes.filter((n) => n.type === "1:1").length + " 1:1s, " + notes.filter((n) => n.type === "Recognition").length + " recognitions, " + notes.filter((n) => n.type === "Coaching").length + " coaching conversations logged");
    const certs = (ws.learning || []).filter((l) => l.status === "Done" && inRange(l.doneAt, start, end));
    if (certs.length) L.push("", "LEARNING", bullets(certs.map((l) => l.title)));
    const r = readiness(ws);
    L.push("", "GROWTH", "- Readiness for " + ws.profile.targetRole + ": " + r.pct + "% (self-assessed)");
    if (r.gaps[0]) L.push("- Biggest gap: " + r.gaps[0].c.name);
    L.push("", "NEXT QUARTER", "- [Your top 3 goals]");
    return L.join("\n");
  }

  // ---------- search ----------
  function searchAll(ws, q) {
    q = String(q || "").trim().toLowerCase();
    if (q.length < 2) return [];
    const out = [];
    const hit = (type, route, id, title, text, date) => {
      const hay = (title + " " + (text || "")).toLowerCase();
      if (hay.includes(q)) out.push({ type, route, id, title, snippet: snippet(text || title, q), date: date || "" });
    };
    for (const w of ws.wins || []) hit("Win", "wins", w.id, w.title, [w.situation, w.action, w.result].join(" "), w.date);
    for (const p of ws.projects || []) hit("Project", "projects", p.id, p.title, [p.impact, p.nextAction, p.result, p.blocker].join(" "), p.due);
    for (const d of ws.drafts || []) hit("Draft", "drafts", d.id, d.title, d.body, (d.updated || "").slice(0, 10));
    for (const m of ws.team || []) {
      hit("Team", "team", m.id, m.name, [m.role, m.growth].join(" "));
      for (const n of m.notes || []) hit(n.type + " · " + m.name, "team", m.id, n.text.slice(0, 80), n.text, n.date);
    }
    for (const p of ws.people || []) hit("Person", "people", p.id, p.name, [p.role, p.notes, (p.touches || []).map((t) => t.note).join(" ")].join(" "));
    for (const j of ws.jobs || []) hit("Job", "jobs", j.id, j.title + " · " + j.company, [j.notes, j.nextStep].join(" "));
    for (const s of ws.shifts || []) hit("Shift log", "shift", s.id, fmtDateY(s.date) + (s.shift ? " " + s.shift : ""), [s.wentWell, s.issues, s.handoff, (s.safety || []).map((x) => x.text).join(" ")].join(" "), s.date);
    for (const p of ws.problems || []) hit("Problem", "solve", p.id, p.title, [p.problem, p.rootCause, (p.whys || []).join(" ")].join(" "), p.created);
    for (const l of ws.learning || []) hit("Learning", "learn", l.id, l.title, l.notes);
    for (const f of ws.feedback || []) hit("Feedback", "feedback", f.id, f.text.slice(0, 80), [f.text, f.action, f.from].join(" "), f.date);
    return out.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 40);
  }
  function snippet(text, q) {
    const t = String(text || "").replace(/\s+/g, " ");
    const i = t.toLowerCase().indexOf(q);
    if (i < 0) return t.slice(0, 100);
    const s = Math.max(0, i - 40);
    return (s ? "…" : "") + t.slice(s, i + q.length + 60) + (i + q.length + 60 < t.length ? "…" : "");
  }

  // ---------- calendar (.ics) ----------
  function icsEscape(s) {
    return String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  }
  function buildIcs(events, now) {
    const stamp = (now || new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CareerCrumbs//EN", "CALSCALE:GREGORIAN"];
    events.forEach((e, i) => {
      const d = e.date.replace(/-/g, "");
      const next = addDays(e.date, 1).replace(/-/g, "");
      L.push("BEGIN:VEVENT", "UID:cc-" + d + "-" + i + "-" + (e.key || "x") + "@careercrumbs", "DTSTAMP:" + stamp, "DTSTART;VALUE=DATE:" + d, "DTEND;VALUE=DATE:" + next, "SUMMARY:" + icsEscape(e.title));
      if (e.desc) L.push("DESCRIPTION:" + icsEscape(e.desc));
      L.push("END:VEVENT");
    });
    L.push("END:VCALENDAR");
    return L.join("\r\n") + "\r\n";
  }
  function upcomingReminders(ws, days, now) {
    const t = today(now);
    const end = addDays(t, days);
    const ev = [];
    const clamp = (d) => (d < t ? t : d);
    for (const p of ws.people || []) {
      const last = lastTouch(p);
      const due = last ? addDays(last, Number(p.cadenceDays) || 14) : t;
      if (due <= end) ev.push({ date: clamp(due), title: "Touch base: " + p.name, desc: (p.relation || "") + (p.notes ? " — " + p.notes : ""), key: p.id });
    }
    for (const m of ws.team || []) {
      const last = lastOneOnOne(m);
      const due = last ? addDays(last, 14) : t;
      if (due <= end) ev.push({ date: clamp(due), title: "1:1 with " + m.name, desc: m.growth ? "Growth goal: " + m.growth : "", key: m.id });
    }
    for (const j of ws.jobs || []) if (j.followUpAt && j.status !== "Closed" && j.followUpAt <= end) ev.push({ date: clamp(j.followUpAt), title: "Follow up: " + j.company + " — " + j.title, desc: j.nextStep || "", key: j.id });
    for (const s of ws.plan || []) if (!s.done && s.due && s.due <= end) ev.push({ date: clamp(s.due), title: "Plan: " + s.text, key: s.id });
    for (const p of ws.projects || []) if (p.status !== "Done" && p.due && p.due <= end) ev.push({ date: clamp(p.due), title: "Due: " + p.title, desc: p.nextAction || "", key: p.id });
    for (const l of ws.learning || []) if (l.status !== "Done" && l.due && l.due <= end) ev.push({ date: clamp(l.due), title: "Learning: " + l.title, key: l.id });
    return ev.sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  // ---------- pasted KPI history ----------
  // Accepts lines like "2026-10-26, 94", "10/26/2026\t94.5" or "Oct 26 2026 94".
  function parseKpiPaste(text) {
    const entries = {};
    let bad = 0;
    for (const raw of String(text || "").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const parts = line.split(/[\t,;]+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
      let date = null, value = null;
      const tryDate = (s) => {
        let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (m) return m[1] + "-" + pad(+m[2]) + "-" + pad(+m[3]);
        m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
        if (m) return (m[3].length === 2 ? "20" + m[3] : m[3]) + "-" + pad(+m[1]) + "-" + pad(+m[2]);
        const d = new Date(s);
        return isNaN(d) || !/[a-z]/i.test(s) ? null : iso(d);
      };
      if (parts.length >= 2) {
        date = tryDate(parts[0]);
        value = num(parts[parts.length - 1]);
      } else {
        const m = line.match(/^(.*\d)\s+(-?[\d.,]+%?)$/);
        if (m) {
          date = tryDate(m[1]);
          value = num(m[2]);
        }
      }
      if (date && value !== null) entries[weekOf(date)] = value;
      else bad++;
    }
    return { entries: Object.keys(entries).sort().map((w) => ({ week: w, value: entries[w] })), bad };
  }

  // ---------- coach context ----------
  function coachSummary(ws, now) {
    const r = readiness(ws);
    const st = weekStats(ws, now);
    const p = ws.profile;
    return {
      today: today(now),
      profile: { role: p.role, company: p.company, site: p.site, targetRole: p.targetRole, targetDate: p.targetDate, why: p.why },
      readinessPct: r.pct,
      competencies: ws.competencies.map((c) => ({ id: c.id, name: c.name, rating: c.rating, target: c.target, winsLogged: evidenceCounts(ws)[c.id] || 0 })),
      weekStats: st,
      kpis: ws.kpis.map((k) => {
        const s = kpiStatus(k);
        return { name: k.name, unit: k.unit, better: k.better, target: s.target, latest: s.value, state: s.state };
      }),
      agenda: agenda(ws, now).slice(0, 8).map((a) => a.title + " — " + a.sub),
      openPlanSteps: (ws.plan || []).filter((s) => !s.done).map((s) => s.phase + "d: " + s.text),
      activeProjects: (ws.projects || []).filter((x) => x.status !== "Done").map((x) => x.title + " (" + x.status + ")"),
      teamSize: (ws.team || []).length,
      interview: interviewReadiness(ws),
    };
  }


  // =====================================================================
  // v3: schedule, feedback, manager 1:1, weekly priorities, kudos, new hires
  // =====================================================================
  const SCHED_CODES = ["", "AM", "PM", "ON", "OFF", "PTO"];
  const SCHED_WORKING = ["AM", "PM", "ON"];
  const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  function scheduleWeek(ws, week) {
    const sc = ws.schedule || {};
    return (sc.weeks || {})[week] || {};
  }
  // Per day: how many people are on each working shift, against the heads needed.
  function scheduleCoverage(ws, week) {
    const grid = scheduleWeek(ws, week);
    const needs = ((ws.schedule || {}).needs || []).map((n) => num(n));
    return DAY_NAMES.map((d, i) => {
      const by = { AM: 0, PM: 0, ON: 0 };
      for (const m of ws.team || []) {
        const c = (grid[m.id] || [])[i];
        if (by[c] !== undefined) by[c]++;
      }
      const total = by.AM + by.PM + by.ON;
      const need = needs[i];
      return { day: d, date: addDays(week, i), by, total, need: need === undefined ? null : need, short: need ? Math.max(0, need - total) : 0 };
    });
  }
  function scheduleHours(ws, week, hoursPerShift) {
    const grid = scheduleWeek(ws, week);
    const out = {};
    for (const m of ws.team || []) out[m.id] = (grid[m.id] || []).filter((c) => SCHED_WORKING.includes(c)).length * (hoursPerShift || 8);
    return out;
  }
  function scheduleText(ws, week) {
    const grid = scheduleWeek(ws, week);
    const cov = scheduleCoverage(ws, week);
    const L = ["Schedule — week of " + fmtDateY(week), ""];
    const w = Math.max(6, ...(ws.team || []).map((m) => m.name.length));
    L.push("".padEnd(w) + "  " + DAY_NAMES.map((d, i) => (d + " " + parse(addDays(week, i)).getDate()).padEnd(7)).join(""));
    for (const m of ws.team || []) L.push(m.name.padEnd(w) + "  " + DAY_NAMES.map((_, i) => ((grid[m.id] || [])[i] || "—").padEnd(7)).join(""));
    L.push("", "On shift".padEnd(w) + "  " + cov.map((c) => String(c.total + (c.need ? "/" + c.need : "")).padEnd(7)).join(""));
    const short = cov.filter((c) => c.short);
    if (short.length) L.push("", "Short: " + short.map((c) => c.day + " (" + c.short + ")").join(", "));
    return L.join("\n");
  }

  const FEEDBACK_KINDS = ["Praise", "Coaching", "Ask", "Concern"];
  function managerAgenda(ws, now) {
    const t = today(now);
    const mgr = (ws.people || []).find((p) => p.relation === "Manager");
    const since = mgr ? lastTouch(mgr) || addDays(t, -14) : addDays(t, -14);
    const wins = (ws.wins || []).filter((w) => inRange(w.date, since, t)).sort((a, b) => (a.date < b.date ? 1 : -1));
    const L = ["1:1 with " + (mgr ? mgr.name.replace(/\s*\(example\)/, "") : "my manager") + " — " + fmtDateY(t), ""];
    L.push("WINS SINCE WE LAST TALKED (" + fmtDate(since) + ")");
    L.push(wins.length ? bullets(wins.slice(0, 5).map(winLine)) : "- [Log a win or two before the meeting]");
    const kp = (ws.kpis || []).map((k) => ({ k, s: kpiStatus(k) })).filter((o) => o.s.latest);
    if (kp.length) L.push("", "NUMBERS", bullets(kp.map((o) => o.k.name + ": " + fmtNum(o.s.value, o.k.unit) + (o.s.target !== null ? " (target " + fmtNum(o.s.target, o.k.unit) + ")" : ""))));
    const blocked = (ws.projects || []).filter((p) => p.status === "Blocked");
    L.push("", "WHERE I NEED YOUR HELP");
    L.push(blocked.length ? bullets(blocked.map((p) => p.title + (p.blocker ? ": " + clean(p.blocker) : ""))) : "- [One specific ask]");
    const open = (ws.feedback || []).filter((f) => !f.actedOn).slice(-3);
    if (open.length) L.push("", "FOLLOWING UP ON YOUR FEEDBACK", bullets(open.map((f) => clean(f.text) + " — what I've done: [update]")));
    const r = readiness(ws);
    L.push("", "MY GROWTH");
    L.push("- Working toward " + ws.profile.targetRole + (ws.profile.targetDate ? " by " + fmtDateY(ws.profile.targetDate) : ""));
    if (r.gaps[0]) L.push("- Where do you see my biggest gap? I'd guess " + r.gaps[0].c.name.toLowerCase() + ".");
    const next = (ws.plan || []).filter((s) => !s.done).slice(0, 2);
    if (next.length) L.push(bullets(next.map((s) => "Next on my plan: " + s.text)));
    L.push("", "ONE QUESTION FOR YOU", "- " + CAREER_QS[parse(t).getDate() % CAREER_QS.length]);
    return L.join("\n");
  }
  const CAREER_QS = [
    "What would you need to see from me to put me up for " + "the next role" + "?",
    "What's one thing I should start doing that you've noticed top supervisors do?",
    "Is there a project or meeting I could take off your plate to stretch me?",
    "How do you think the site leadership sees my shift right now?",
    "What did you work on to get from supervisor to manager?",
    "Who else should I be learning from in the region?",
  ];

  function kudosText(name, what, impact) {
    const first = String(name || "").replace(/\s*\(example\)/, "").split(" ")[0] || "[name]";
    return "Shout-out to " + first + " for " + (clean(what) ? lower1(clean(what)) : "[what they did]") + "." + (clean(impact) ? " " + cap(clean(impact)) + "." : " [Why it mattered to the team or customers.]") + " Thank you!";
  }

  const NEW_HIRE_CHECKLIST = [
    "Safety walk: exits, extinguishers, eyewash, first aid",
    "PPE and freezer gear issued",
    "Buddy assigned for the first two weeks",
    "Scanner and app login working",
    "Picking: shadowed, then signed off",
    "Packing: shadowed, then signed off",
    "Food safety and allergen basics",
    "Day 7 check-in",
    "Day 30 check-in: what's working, what isn't",
  ];

  function weekPriorities(ws, week) {
    return ((ws.priorities || {})[week] || []).slice(0, 3);
  }

  const api = {
    SCHED_CODES, SCHED_WORKING, DAY_NAMES, scheduleWeek, scheduleCoverage, scheduleHours, scheduleText, FEEDBACK_KINDS, managerAgenda, kudosText, NEW_HIRE_CHECKLIST, weekPriorities,
    SHIFTS, SAFETY_KINDS, SAFETY_TOPICS, safetyTopic, huddleText, handoffText,
    INTERVIEW_QS, suggestStories, interviewReadiness, starAnswer,
    laborPlan, impactCalc, FISHBONE, a3Text, LEARNING_TYPES, LEARNING_SUGGESTIONS,
    activityByDay, kpiHitRate, recognitionGaps, evidenceByMonth, quarterlyReview,
    searchAll, buildIcs, upcomingReminders, parseKpiPaste, coachSummary,
    uid, iso, today, parse, addDays, daysBetween, weekOf, fmtDate, fmtDateY, relDays, num, fmtNum,
    COMPETENCY_PRESET, RATING_LABELS, KPI_PRESETS, STATIONS_PRESET, TRAIN_LEVELS, JOB_STATUSES, PROJECT_STATUSES, RELATIONS, DRAFT_KINDS,
    emptyWorkspace, normalize, metricPhrase, bulletFromWin, readiness, evidenceCounts,
    kpiSeries, kpiLatest, kpiStatus, sparkPoints, lastTouch, touchDue, lastOneOnOne, oneOnOneDue, coverage,
    setJobStatus, followUpBadge, weeklyUpdate, promotionCase, oneOnOneAgenda, bragDoc, agenda, weekStats, winsByWeek, exampleWorkspace,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CC = api;
})(typeof window !== "undefined" ? window : globalThis);
