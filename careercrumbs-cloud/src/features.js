// CareerCrumbs v2 sections. Registered by app.js through window.CCFeatures(api).
(function () {
  "use strict";
  window.CCFeatures = function (api) {
    const C = window.CC;
    const { esc, icon, fieldText, fieldSelect, head, plural, byId, sortDesc, t0, save, render, go, openSheet, closeSheet, toast, copyText, saveFile, addDraft, openDraft, winForm, ui } = api;
    const V = api.views, A = api.actions, CH = api.changes, F = api.forms;
    const $ = (s, el) => (el || document).querySelector(s);
    const W = () => api.ws;
    const val = (f, n) => (f.elements[n] ? String(f.elements[n].value || "").trim() : "");
    const foot = (id, kind, label) =>
      '<div class="sheet-foot">' + (id ? '<button type="button" class="btn danger sm" data-act="ask-del" data-kind="' + kind + '" data-id="' + id + '">Delete</button>' : "") + '<span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">' + (label || "Save") + "</button></div><div data-confirm></div>";
    const compName = (id) => (byId(W().competencies, id) || {}).name || "";
    const compOptions = (sel) => [["", "—"]].concat(W().competencies.map((c) => [c.id, c.name]));

    // ================================================================
    // SHIFT LOG
    // ================================================================
    function oplh(s) {
      const o = C.num(s.orders), h = C.num(s.laborHours);
      return o && h ? Math.round((o / h) * 10) / 10 : null;
    }
    function shiftBars(list) {
      const data = list.slice(0, 14).reverse();
      if (data.length < 2) return "";
      const vals = data.map(oplh);
      const max = Math.max(...vals.filter((v) => v !== null), 1);
      const Wd = 320, H = 70, bw = Wd / data.length;
      return '<div class="card stack-s"><span class="eyebrow">Orders per labor hour · last ' + data.length + ' shifts</span><svg class="chart" viewBox="0 0 ' + Wd + " " + H + '" role="img" aria-label="Orders per labor hour by shift">' +
        data.map((s, i) => {
          const v = vals[i];
          const h = v === null ? 0 : Math.round((v / max) * (H - 22));
          return '<rect x="' + (i * bw + 3).toFixed(1) + '" y="' + (H - 14 - h) + '" width="' + (bw - 6).toFixed(1) + '" height="' + Math.max(h, 1) + '" rx="2" fill="' + (i === data.length - 1 ? "var(--brown)" : "var(--ink)") + '"><title>' + esc(C.fmtDate(s.date) + ": " + (v === null ? "no data" : v)) + "</title></rect>" +
            (v !== null && (i === data.length - 1 || i === 0) ? '<text x="' + (i * bw + bw / 2).toFixed(1) + '" y="' + (H - 18 - h) + '" text-anchor="middle" font-size="10" font-family="var(--mono)" fill="var(--ink)">' + v + "</text>" : "");
        }).join("") +
        '<text x="2" y="' + (H - 2) + '" font-size="9" font-family="var(--mono)" fill="var(--muted)">' + C.fmtDate(data[0].date) + '</text><text x="' + (Wd - 2) + '" y="' + (H - 2) + '" text-anchor="end" font-size="9" font-family="var(--mono)" fill="var(--muted)">' + C.fmtDate(data[data.length - 1].date) + "</text></svg></div>";
    }
    V.shift = function () {
      const ws = W();
      const list = sortDesc(ws.shifts, "date");
      const [topic, tip] = C.safetyTopic(t0());
      const safety30 = ws.shifts.filter((s) => C.daysBetween(s.date, t0()) <= 30).reduce((n, s) => n + (s.safety || []).length, 0);
      return (
        '<div class="view">' + head(plural(ws.shifts.length, "shift") + " logged", "Shift log", '<button class="btn ghost" data-act="huddle">Huddle notes</button><button class="btn brown" data-act="new-shift">' + icon("plus") + "Log shift</button>") +
        '<section class="card floor-card"><span class="eyebrow">Safety topic · ' + esc(C.fmtDate(t0())) + "</span><h2>" + esc(topic) + "</h2><p>" + esc(tip) + "</p></section>" +
        '<p class="muted">Two minutes at the end of every shift. The log writes your handoff, feeds tomorrow\'s huddle, and catches wins you\'d otherwise forget. ' + (safety30 ? plural(safety30, "safety note") + " in the last 30 days." : "") + "</p>" +
        shiftBars(list) +
        (list.length
          ? '<div class="grid2">' + list.slice(0, 30).map((s) => {
              const r = oplh(s);
              return '<article class="card stack"><div class="row between"><b class="mono">' + esc(C.fmtDateY(s.date)) + "</b>" + (s.shift ? '<span class="pill">' + esc(s.shift) + "</span>" : "") + "</div>" +
                '<div class="kv">' + (s.orders ? "<div><span class=\"eyebrow\">Orders</span><b>" + esc(s.orders) + "</b></div>" : "") + (s.headcount ? "<div><span class=\"eyebrow\">People</span><b>" + esc(s.headcount) + "</b></div>" : "") + (r !== null ? "<div><span class=\"eyebrow\">Ord / lbr hr</span><b>" + r + "</b></div>" : "") + "</div>" +
                (s.wentWell ? '<p class="small"><b>Went well:</b> ' + esc(s.wentWell) + "</p>" : "") +
                (s.issues ? '<p class="small"><b>Issues:</b> ' + esc(s.issues) + "</p>" : "") +
                ((s.safety || []).length ? '<div class="row">' + s.safety.map((x) => '<span class="pill ' + (x.kind === "Incident" ? "bad" : x.kind === "Near miss" ? "warn" : "brown") + '" title="' + esc(x.text) + '">' + esc(x.kind) + "</span>").join("") + "</div>" : "") +
                '<div class="row"><button class="btn sm ghost" data-act="edit-shift" data-id="' + s.id + '">' + icon("edit") + 'Edit</button><button class="btn sm ghost" data-act="handoff" data-id="' + s.id + '">Handoff</button>' + (s.wentWell ? '<button class="btn sm ghost" data-act="shift-win" data-id="' + s.id + '">Make it a win</button>' : "") + "</div></article>";
            }).join("") + "</div>"
          : '<div class="empty"><b>No shifts logged</b><span>Log today\'s: orders, headcount, what went well and what the next shift needs to know.</span><button class="btn brown" data-act="new-shift">Log this shift</button></div>') +
        "</div>"
      );
    };
    function shiftForm(s) {
      s = s || { date: t0(), shift: (W().team[0] && "") || "", safety: [] };
      const saf = (s.safety || []).concat([{}, {}, {}]).slice(0, Math.max(3, (s.safety || []).length));
      return (
        '<form data-form="shift" data-id="' + esc(s.id || "") + '"><div class="fields2">' + fieldText("date", "Date", s.date, { type: "date" }) + fieldSelect("shift", "Shift", s.shift || "", [["", "—"]].concat(C.SHIFTS)) + "</div>" +
        '<div class="fields2">' + fieldText("orders", "Orders", s.orders, { mode: "numeric" }) + fieldText("headcount", "People on shift", s.headcount, { mode: "numeric" }) + fieldText("laborHours", "Labor hours", s.laborHours, { mode: "decimal" }) + "</div>" +
        fieldText("wentWell", "What went well?", s.wentWell, { area: true, rows: 2 }) +
        fieldText("issues", "Issues", s.issues, { area: true, rows: 2, ph: "Late trucks, call-outs, equipment…" }) +
        fieldText("handoff", "Next shift needs to know", s.handoff, { area: true, rows: 2 }) +
        '<div class="field"><span>Safety</span>' + saf.map((x, i) => '<div class="row"><select class="select" style="width:auto;flex:0 0 auto" name="sk' + i + '" aria-label="Safety type">' + C.SAFETY_KINDS.map((k) => "<option" + (x.kind === k ? " selected" : "") + ">" + k + "</option>").join("") + '</select><input class="input" style="flex:1 1 160px" name="st' + i + '" value="' + esc(x.text || "") + '" placeholder="Leave blank if nothing" aria-label="Safety note"></div>').join("") + "</div>" +
        foot(s.id, "shift") + "</form>"
      );
    }
    A["new-shift"] = () => openSheet("Log a shift", shiftForm());
    A["edit-shift"] = (el) => openSheet("Edit shift", shiftForm(byId(W().shifts, el.dataset.id)));
    F.shift = (f) => {
      const id = f.dataset.id;
      const safety = [];
      for (let i = 0; i < 8; i++) if (f.elements["st" + i] && val(f, "st" + i)) safety.push({ kind: val(f, "sk" + i), text: val(f, "st" + i) });
      const data = { date: val(f, "date") || t0(), shift: val(f, "shift"), orders: C.num(val(f, "orders")), headcount: C.num(val(f, "headcount")), laborHours: C.num(val(f, "laborHours")), wentWell: val(f, "wentWell"), issues: val(f, "issues"), handoff: val(f, "handoff"), safety };
      const ws = W();
      if (id) Object.assign(byId(ws.shifts, id), data);
      else ws.shifts.push(Object.assign({ id: C.uid("sh") }, data));
      ws.shifts = sortDesc(ws.shifts, "date").slice(0, 400);
      closeSheet();
      save("shifts");
      toast("Shift logged", data.wentWell ? "Make it a win" : null, () => A["shift-win"]({ dataset: { id: id || ws.shifts.find((x) => x.date === data.date && x.wentWell === data.wentWell).id } }));
    };
    A.handoff = (el) => {
      const s = byId(W().shifts, el.dataset.id);
      textSheet("Shift handoff", C.handoffText(s), "huddle", "Handoff · " + C.fmtDate(s.date));
    };
    A.huddle = () => {
      const pick = '<div class="chips">' + C.SHIFTS.map((x) => '<button class="chip" data-act="huddle-go" data-v="' + x + '">' + x + "</button>").join("") + "</div>";
      openSheet("Huddle notes", '<div class="sheet-body"><p class="muted">A 5-minute start-of-shift huddle: today\'s safety topic, last shift\'s recap, the number to watch and shout-outs. Which shift?</p>' + pick + "</div>");
    };
    A["huddle-go"] = (el) => textSheet("Huddle · " + el.dataset.v, C.huddleText(W(), t0(), el.dataset.v), "huddle", "Huddle · " + C.fmtDate(t0()) + " " + el.dataset.v);
    A["shift-win"] = (el) => {
      const s = byId(W().shifts, el.dataset.id);
      openSheet("Log a win", winForm(null, { title: s.wentWell.slice(0, 90), date: s.date, action: s.wentWell, situation: s.issues || "" }));
    };
    function textSheet(title, text, kind, draftTitle) {
      openSheet(esc(title), '<div class="sheet-body"><span class="ai-note">Template · built from your log</span><textarea class="textarea" id="ts-text" rows="14" style="font-family:var(--mono);font-size:0.88rem">' + esc(text) + '</textarea><div class="sheet-foot"><span class="grow"></span><button class="btn ghost" data-act="ts-copy">' + icon("copy") + 'Copy</button><button class="btn brown" data-act="ts-save" data-kind="' + kind + '" data-title="' + esc(draftTitle) + '">Save to drafts</button></div></div>');
    }
    A["ts-copy"] = () => copyText($("#ts-text").value);
    A["ts-save"] = (el) => {
      const d = addDraft(el.dataset.kind, el.dataset.title, $("#ts-text").value);
      closeSheet();
      toast("Saved to drafts", "Open", () => { go("drafts"); openDraft(d); });
    };

    // ================================================================
    // PROBLEM SOLVING (A3)
    // ================================================================
    const PSTAT = ["Open", "Investigating", "Countermeasures", "Checking", "Solved"];
    V.solve = function () {
      const ws = W();
      const list = ws.problems.slice().sort((a, b) => (a.status === "Solved") - (b.status === "Solved") || (a.created < b.created ? 1 : -1));
      return (
        '<div class="view">' + head(ws.problems.filter((p) => p.status !== "Solved").length + " open", "Problem solving", '<button class="btn brown" data-act="new-problem">' + icon("plus") + "New problem</button>") +
        '<p class="muted">The managers who get promoted fix problems so they stay fixed. Use the 5 whys to get past the first answer, check the six cause areas, then assign countermeasures with an owner and a date. One page per problem, like an A3.</p>' +
        (list.length
          ? '<div class="grid2">' + list.map((p) => {
              const cm = p.countermeasures || [];
              const done = cm.filter((c) => c.done).length;
              return '<article class="card stack"><div class="row between"><span class="pill ' + (p.status === "Solved" ? "solid" : p.status === "Open" ? "bad" : "brown") + '">' + esc(p.status) + '</span><span class="mono small muted">' + esc(C.fmtDate(p.created)) + "</span></div><h3>" + esc(p.title) + "</h3>" +
                (p.rootCause ? '<p class="small"><b>Root cause:</b> ' + esc(p.rootCause) + "</p>" : p.problem ? '<p class="small muted">' + esc(p.problem) + "</p>" : "") +
                (cm.length ? '<div class="stack-s"><span class="small muted">' + done + " of " + cm.length + ' countermeasures done</span><div class="progress"><i style="width:' + Math.round((done / cm.length) * 100) + '%"></i></div></div>' : "") +
                '<div class="row"><button class="btn sm ghost" data-act="edit-problem" data-id="' + p.id + '">' + icon("edit") + 'Open</button><button class="btn sm ghost" data-act="a3" data-id="' + p.id + '">A3 sheet</button>' +
                (p.status === "Solved" ? '<button class="btn sm ghost" data-act="problem-win" data-id="' + p.id + '">Log as a win</button>' : '<button class="btn sm ghost" data-act="problem-project" data-id="' + p.id + '">Make a project</button>') + "</div></article>";
            }).join("") + "</div>"
          : '<div class="empty"><b>No problems logged</b><span>Pick the miss that keeps coming back: INF on one aisle, late putaway, mis-picks on one zone.</span><button class="btn brown" data-act="new-problem">Start one</button></div>') +
        "</div>"
      );
    };
    function problemForm(p) {
      p = p || { status: "Open", whys: [], causes: {}, countermeasures: [] };
      const whys = (p.whys || []).concat(["", "", "", "", ""]).slice(0, 5);
      return (
        '<form data-form="problem" data-id="' + esc(p.id || "") + '">' + fieldText("title", "Problem in a few words", p.title, { req: true }) +
        fieldSelect("status", "Status", p.status, PSTAT) +
        fieldText("problem", "What's happening?", p.problem, { area: true, rows: 2, ph: "Where, since when, how often" }) +
        fieldText("impact", "Impact", p.impact, { area: true, rows: 2, ph: "Which number it hurts" }) +
        '<div class="field"><span>Five whys</span><div class="whys">' + whys.map((w, i) => '<label for="why' + i + '"><span>Why ' + (i + 1) + '</span><input class="input" id="why' + i + '" name="why' + i + '" value="' + esc(w) + '"></label>').join("") + "</div></div>" +
        '<div class="field"><span>Contributing causes</span><div class="fish">' + C.FISHBONE.map((k) => fieldText("cause_" + k, k, (p.causes || {})[k] || "")).join("") + "</div></div>" +
        fieldText("rootCause", "Root cause", p.rootCause, { ph: "One sentence you can act on" }) +
        fieldText("cms", "Countermeasures", (p.countermeasures || []).map((c) => (c.done ? "[x] " : "") + c.text + (c.owner ? " | " + c.owner : "") + (c.due ? " | " + c.due : "")).join("\n"), { area: true, rows: 3, hint: "One per line: action | owner | YYYY-MM-DD. Start with [x] when done." }) +
        fieldText("check", "How you'll check it worked", p.check, { ph: "e.g. INF under 2.5% for 4 weeks" }) +
        foot(p.id, "problem") + "</form>"
      );
    }
    A["new-problem"] = () => openSheet("New problem", problemForm());
    A["edit-problem"] = (el) => openSheet("Problem", problemForm(byId(W().problems, el.dataset.id)));
    F.problem = (f) => {
      const id = f.dataset.id;
      const causes = {};
      for (const k of C.FISHBONE) if (val(f, "cause_" + k)) causes[k] = val(f, "cause_" + k);
      const countermeasures = val(f, "cms").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
        const done = /^\[x\]/i.test(l);
        const [text, owner, due] = l.replace(/^\[[x ]?\]\s*/i, "").split("|").map((x) => x.trim());
        return { text, owner: owner || "", due: /^\d{4}-\d{2}-\d{2}$/.test(due || "") ? due : "", done };
      });
      const data = { title: val(f, "title"), status: val(f, "status"), problem: val(f, "problem"), impact: val(f, "impact"), whys: [0, 1, 2, 3, 4].map((i) => val(f, "why" + i)), causes, rootCause: val(f, "rootCause"), countermeasures, check: val(f, "check") };
      const ws = W();
      if (id) Object.assign(byId(ws.problems, id), data);
      else ws.problems.push(Object.assign({ id: C.uid("pb"), created: t0() }, data));
      closeSheet();
      save("problems");
    };
    A.a3 = (el) => {
      const p = byId(W().problems, el.dataset.id);
      textSheet("A3 · " + p.title, C.a3Text(p), "a3", "A3 · " + p.title);
    };
    A["problem-win"] = (el) => {
      const p = byId(W().problems, el.dataset.id);
      openSheet("Log a win", winForm(null, { title: "Solved: " + p.title, situation: p.problem, action: (p.countermeasures || []).map((c) => c.text).join("; "), result: p.check, competencies: ["c4"] }));
    };
    A["problem-project"] = (el) => {
      const p = byId(W().problems, el.dataset.id);
      W().projects.push({ id: C.uid("pr"), title: p.title, status: "Active", impact: p.impact, nextAction: ((p.countermeasures || []).find((c) => !c.done) || {}).text || "", milestones: (p.countermeasures || []).map((c) => ({ text: c.text, done: c.done })), created: new Date().toISOString() });
      save("projects");
      toast("Project created", "Open", () => go("projects"));
    };

    // ================================================================
    // LABOR & IMPACT CALCULATORS
    // ================================================================
    const n1 = (v) => (v === null || v === undefined ? "—" : (Math.round(v * 10) / 10).toLocaleString("en-US"));
    const money = (v) => (v === null || v === undefined ? "—" : "$" + Math.round(v).toLocaleString("en-US"));
    function laborResult(i) {
      const r = C.laborPlan(i);
      if (!r) return '<p class="muted small">Fill in orders, units per order and UPH to see the plan.</p>';
      let h = '<div class="kv big"><div><span class="eyebrow">Units</span><b>' + n1(r.units) + '</b></div><div><span class="eyebrow">Pick hours</span><b>' + n1(r.pickHours) + '</b></div><div><span class="eyebrow">Total hours</span><b>' + n1(r.totalHours) + '</b></div><div><span class="eyebrow">Headcount</span><b>' + r.headcount + "</b></div>" +
        '<div><span class="eyebrow">Orders / lbr hr</span><b>' + n1(r.ordersPerLaborHour) + "</b></div>" + (r.cost !== null ? '<div><span class="eyebrow">Labor cost</span><b>' + money(r.cost) + "</b></div>" : "") + "</div>";
      if (r.whatIf) {
        const w = r.whatIf;
        h += '<div class="stack-s"><span class="eyebrow">If UPH goes to ' + n1(w.newUph) + '</span><div class="kv"><div><span class="eyebrow">Hours saved / day</span><b>' + n1(w.hoursSavedPerDay) + '</b></div><div><span class="eyebrow">Per week</span><b>' + n1(w.hoursSavedPerWeek) + '</b></div><div><span class="eyebrow">Per year</span><b>' + n1(w.hoursSavedPerYear) + "</b></div>" + (w.dollarsPerYear !== null ? '<div><span class="eyebrow">$ / year</span><b>' + money(w.dollarsPerYear) + "</b></div>" : "") + '<div><span class="eyebrow">Headcount</span><b>' + w.newHeadcount + "</b></div></div></div>";
      }
      return h;
    }
    function impactResult(i) {
      const r = C.impactCalc(i);
      if (!r) return '<p class="muted small">Enter minutes saved per order and orders per day.</p>';
      return '<div class="kv big"><div><span class="eyebrow">Hours / week</span><b>' + n1(r.hoursWeek) + '</b></div><div><span class="eyebrow">Hours / year</span><b>' + n1(r.hoursYear) + "</b></div>" + (r.dollarsYear !== null ? '<div><span class="eyebrow">$ / year</span><b>' + money(r.dollarsYear) + "</b></div>" : "") + "</div>";
    }
    V.tools = function () {
      const ti = W().toolInputs;
      const L = ti.labor || {}, I = ti.impact || {};
      const num = (name, label, v, o) => fieldText(name, label, v == null ? "" : v, Object.assign({ mode: "decimal" }, o || {}));
      return (
        '<div class="view">' + head("Speak the language of the P&L", "Labor & impact") +
        '<p class="muted">Managers talk in hours and dollars. Plan a shift from forecast volume, and turn a process fix into hours and dollars saved per year. Everything here comes from numbers you type in.</p>' +
        '<section class="card stack"><h2>Labor planner</h2><form class="stack" data-live="labor" data-form="noop">' +
        '<div class="fields2">' + num("orders", "Forecast orders", L.orders) + num("unitsPerOrder", "Units per order", L.unitsPerOrder) + num("uph", "UPH (units / labor hr)", L.uph) + "</div>" +
        '<div class="fields2">' + num("shiftHours", "Hours per person", L.shiftHours, { ph: "8" }) + num("overhead", "Non-pick time %", L.overhead, { ph: "e.g. 20", hint: "Receiving, stocking, breaks" }) + num("wage", "Avg wage $/hr (optional)", L.wage) + "</div>" +
        '<div class="fields2">' + num("newUph", "What if UPH were…", L.newUph) + num("daysPerWeek", "Days per week", L.daysPerWeek, { ph: "7" }) + "</div>" +
        '<div data-out="labor">' + laborResult(L) + "</div>" +
        '<div class="row"><button type="button" class="btn sm ghost" data-act="labor-draft">Save as draft</button><button type="button" class="btn sm ghost" data-act="labor-win">Use in a win</button></div></form></section>' +
        '<section class="card stack"><h2>Impact calculator</h2><p class="muted small">You shaved time off every order: how much is that worth?</p><form class="stack" data-live="impact" data-form="noop">' +
        '<div class="fields2">' + num("minutesPerOrder", "Minutes saved per order", I.minutesPerOrder) + num("ordersPerDay", "Orders per day", I.ordersPerDay) + num("daysPerWeek", "Days per week", I.daysPerWeek, { ph: "7" }) + num("wage", "Avg wage $/hr (optional)", I.wage) + "</div>" +
        '<div data-out="impact">' + impactResult(I) + "</div>" +
        '<div class="row"><button type="button" class="btn sm ghost" data-act="impact-win">Add to a win</button></div></form></section>' +
        "</div>"
      );
    };
    F.noop = () => {};
    let liveTimer = null;
    document.addEventListener("input", (ev) => {
      const f = ev.target.closest && ev.target.closest("form[data-live]");
      if (!f) return;
      const kind = f.dataset.live;
      const inputs = {};
      for (const el of f.elements) if (el.name) inputs[el.name] = el.value;
      W().toolInputs[kind] = inputs;
      $('[data-out="' + kind + '"]', f).innerHTML = kind === "labor" ? laborResult(inputs) : impactResult(inputs);
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => api.persist("toolInputs"), 900);
    });
    A["labor-draft"] = () => {
      const i = W().toolInputs.labor || {};
      const r = C.laborPlan(i);
      if (!r) return toast("Fill in orders, units per order and UPH first.");
      let t = "Labor plan — " + C.fmtDateY(t0()) + "\n\nINPUTS\n- Forecast orders: " + i.orders + "\n- Units per order: " + i.unitsPerOrder + "\n- UPH: " + i.uph + "\n- Non-pick time: " + (i.overhead || 0) + "%\n\nPLAN\n- Units: " + n1(r.units) + "\n- Pick hours: " + n1(r.pickHours) + "\n- Total labor hours: " + n1(r.totalHours) + "\n- Headcount at " + (i.shiftHours || 8) + " hrs each: " + r.headcount + "\n- Orders per labor hour: " + n1(r.ordersPerLaborHour);
      if (r.cost !== null) t += "\n- Labor cost: " + money(r.cost);
      if (r.whatIf) t += "\n\nIF UPH REACHES " + n1(r.whatIf.newUph) + "\n- Saves " + n1(r.whatIf.hoursSavedPerDay) + " hrs/day, " + n1(r.whatIf.hoursSavedPerYear) + " hrs/year" + (r.whatIf.dollarsPerYear !== null ? " (" + money(r.whatIf.dollarsPerYear) + "/year)" : "");
      const d = addDraft("other", "Labor plan · " + C.fmtDate(t0()), t);
      go("drafts");
      openDraft(d);
    };
    A["labor-win"] = () => {
      const i = W().toolInputs.labor || {};
      const r = C.laborPlan(i);
      if (!r || !r.whatIf) return toast("Fill in the plan and a what-if UPH first.");
      openSheet("Log a win", winForm(null, { title: "Raised UPH from " + i.uph + " to " + r.whatIf.newUph, result: "Saves about " + n1(r.whatIf.hoursSavedPerYear) + " labor hours a year" + (r.whatIf.dollarsPerYear !== null ? " (" + money(r.whatIf.dollarsPerYear) + ")" : ""), metric: { label: "UPH", before: i.uph, after: r.whatIf.newUph, unit: "UPH" }, competencies: ["c1", "c6"] }));
    };
    A["impact-win"] = () => {
      const i = W().toolInputs.impact || {};
      const r = C.impactCalc(i);
      if (!r) return toast("Fill in the impact calculator first.");
      openSheet("Log a win", winForm(null, { title: "Cut " + i.minutesPerOrder + " min from every order", result: "About " + n1(r.hoursYear) + " labor hours a year" + (r.dollarsYear !== null ? " (" + money(r.dollarsYear) + ")" : "") + " at " + i.ordersPerDay + " orders/day", competencies: ["c1", "c3"] }));
    };

    // ================================================================
    // LEARNING
    // ================================================================
    const LSTAT = ["In progress", "Planned", "Done"];
    V.learn = function () {
      const ws = W();
      const yr = String(new Date().getFullYear());
      const doneYr = ws.learning.filter((l) => l.status === "Done" && (l.doneAt || "").startsWith(yr));
      const hours = doneYr.reduce((s, l) => s + (C.num(l.hours) || 0), 0) + ws.learning.filter((l) => l.status === "In progress").reduce((s, l) => s + (C.num(l.hours) || 0), 0);
      const have = new Set(ws.learning.map((l) => l.title.toLowerCase()));
      const sugg = C.LEARNING_SUGGESTIONS.filter(([t]) => !have.has(t.toLowerCase()));
      return (
        '<div class="view">' + head("Courses, certs, shadowing", "Learning", '<button class="btn brown" data-act="new-learn">' + icon("plus") + "Add</button>") +
        '<div class="tiles"><div class="tile"><span class="eyebrow">Done in ' + yr + "</span><b>" + doneYr.length + '</b></div><div class="tile"><span class="eyebrow">In progress</span><b>' + ws.learning.filter((l) => l.status === "In progress").length + '</b></div><div class="tile"><span class="eyebrow">Planned</span><b>' + ws.learning.filter((l) => l.status === "Planned").length + '</b></div><div class="tile"><span class="eyebrow">Hours · ' + yr + "</span><b>" + n1(hours) + "</b></div></div>" +
        LSTAT.map((st) => {
          const items = ws.learning.filter((l) => l.status === st);
          if (!items.length) return "";
          return '<section class="stack"><h2>' + st + '</h2><div class="list">' + items.map((l) => '<button class="li" data-act="edit-learn" data-id="' + l.id + '"><span class="row between"><b>' + esc(l.title) + '</b><span class="pill">' + esc(l.type) + '</span></span><span class="small muted">' + esc([compName(l.comp), l.hours ? l.hours + " hrs" : "", l.status === "Done" ? "Done " + C.fmtDate(l.doneAt) : l.due ? "Due " + C.fmtDate(l.due) : ""].filter(Boolean).join(" · ")) + "</span></button>").join("") + "</div></section>";
        }).join("") +
        (!ws.learning.length ? '<div class="empty"><b>Nothing tracked yet</b><span>Certifications and shadowing are easy wins for a promotion case. Start with one below.</span></div>' : "") +
        (sugg.length ? '<section class="card stack"><h2>Ideas for an ops manager track</h2><p class="muted small">Common picks for warehouse leaders. Check what your company covers or requires.</p><div class="togglechips">' + sugg.map(([t, ty, c], i) => '<button class="chip" data-act="learn-sugg" data-t="' + esc(t) + '" data-ty="' + esc(ty) + '" data-c="' + c + '">+ ' + esc(t) + "</button>").join("") + "</div></section>" : "") +
        "</div>"
      );
    };
    function learnForm(l) {
      l = l || { type: "Course", status: "Planned" };
      return (
        '<form data-form="learn" data-id="' + esc(l.id || "") + '">' + fieldText("title", "What", l.title, { req: true }) +
        '<div class="fields2">' + fieldSelect("type", "Type", l.type, C.LEARNING_TYPES) + fieldSelect("status", "Status", l.status, LSTAT) + "</div>" +
        '<div class="fields2">' + fieldSelect("comp", "Builds", l.comp || "", compOptions()) + fieldText("due", "Target date", l.due, { type: "date" }) + fieldText("hours", "Hours", l.hours, { mode: "decimal" }) + "</div>" +
        fieldText("link", "Link", l.link, { type: "url", ph: "https://" }) + fieldText("notes", "Notes", l.notes, { area: true, rows: 2 }) +
        foot(l.id, "learn") + "</form>"
      );
    }
    A["new-learn"] = () => openSheet("Add learning", learnForm());
    A["edit-learn"] = (el) => openSheet("Learning", learnForm(byId(W().learning, el.dataset.id)));
    A["learn-sugg"] = (el) => {
      W().learning.push({ id: C.uid("l"), title: el.dataset.t, type: el.dataset.ty, comp: el.dataset.c, status: "Planned" });
      save("learning");
      toast("Added to your plan");
    };
    F.learn = (f) => {
      const id = f.dataset.id;
      const ws = W();
      const old = id ? byId(ws.learning, id) : null;
      const data = { title: val(f, "title"), type: val(f, "type"), status: val(f, "status"), comp: val(f, "comp"), due: val(f, "due"), hours: C.num(val(f, "hours")), link: val(f, "link"), notes: val(f, "notes") };
      const nowDone = data.status === "Done" && (!old || old.status !== "Done");
      if (nowDone) data.doneAt = t0();
      if (old) Object.assign(old, data);
      else ws.learning.push(Object.assign({ id: C.uid("l") }, data));
      closeSheet();
      save("learning");
      if (nowDone) toast("Nice. Log it as a win?", "Log win", () => openSheet("Log a win", winForm(null, { title: "Completed " + data.title, competencies: data.comp ? [data.comp] : [] })));
    };

    // ================================================================
    // INTERVIEW PREP
    // ================================================================
    V.interview = function () {
      const ws = W();
      const r = C.interviewReadiness(ws);
      const st = ws.interview.stories;
      const prac = ws.interview.practice || [];
      const avg = prac.length ? Math.round((prac.slice(-10).reduce((s, p) => s + p.rating, 0) / Math.min(10, prac.length)) * 10) / 10 : null;
      return (
        '<div class="view">' + head("Behavioural interview", "Interview prep", '<button class="btn ghost" data-act="interview-sheet">Answer sheet</button><button class="btn brown" data-act="practice">Practice</button>') +
        '<div class="tiles"><div class="tile"><span class="eyebrow">Questions with a story</span><b>' + r.ready + '<span class="muted small"> / ' + r.total + '</span></b></div><div class="tile"><span class="eyebrow">Practice runs</span><b>' + prac.length + '</b></div><div class="tile"><span class="eyebrow">Avg self-score</span><b>' + (avg === null ? "—" : avg + '<span class="muted small"> / 5</span>') + '</b></div><div class="tile"><span class="eyebrow">Wins to draw on</span><b>' + ws.wins.length + "</b></div></div>" +
        (api.sample ? '<section class="card floor-card"><span class="eyebrow">Ask Ruhv</span><h2>Mock interview</h2><p>Ruhv plays the hiring manager for ' + esc(ws.profile.targetRole) + ", asks one question at a time and gives you feedback on each answer.</p><div class=\"row\"><button class=\"btn brown\" data-act=\"mock\">Start a mock interview</button></div></section>" : "") +
        '<p class="muted">Panels ask for specific stories. Match each question to a win you\'ve logged, and you\'ll walk in with an answer ready for every one. Suggested wins are listed first.</p>' +
        '<div class="list">' + C.INTERVIEW_QS.map((q) => {
          const sugg = C.suggestStories(ws, q);
          const others = ws.wins.filter((w) => !sugg.includes(w));
          const cur = st[q.id];
          const has = cur && byId(ws.wins, cur);
          return '<div class="li" style="cursor:default"><span class="row between"><b>' + esc(q.q) + "</b>" + (has ? '<span class="pill solid">Ready</span>' : "") + '</span><span class="row">' + q.comps.map((c) => '<span class="pill brown">' + esc(compName(c) || c) + "</span>").join("") + "</span>" +
            '<span class="row"><label class="sr" for="st-' + q.id + '">Story</label><select class="select" style="flex:1 1 200px;min-height:36px" id="st-' + q.id + '" data-act-change="story" data-q="' + q.id + '"><option value="">' + (sugg.length ? "Pick a story…" : "No matching wins yet") + "</option>" +
            (sugg.length ? '<optgroup label="Suggested">' + sugg.map((w) => '<option value="' + w.id + '"' + (cur === w.id ? " selected" : "") + ">" + esc(w.title) + "</option>").join("") + "</optgroup>" : "") +
            (others.length ? '<optgroup label="Other wins">' + others.map((w) => '<option value="' + w.id + '"' + (cur === w.id ? " selected" : "") + ">" + esc(w.title) + "</option>").join("") + "</optgroup>" : "") +
            "</select>" + (has ? '<button class="btn sm ghost" data-act="star" data-q="' + q.id + '">STAR</button>' : "") + "</span></div>";
        }).join("") + "</div></div>"
      );
    };
    CH.story = (el) => {
      const st = W().interview.stories;
      if (el.value) st[el.dataset.q] = el.value;
      else delete st[el.dataset.q];
      save("interview");
    };
    A.star = (el) => {
      const ws = W();
      const q = C.INTERVIEW_QS.find((x) => x.id === el.dataset.q);
      const w = byId(ws.wins, ws.interview.stories[q.id]);
      textSheet("STAR answer", "Q: " + q.q + "\n\n" + C.starAnswer(w), "interview", "Interview · " + q.q.slice(0, 40));
    };
    A["interview-sheet"] = () => {
      const ws = W();
      const parts = C.INTERVIEW_QS.map((q) => {
        const w = byId(ws.wins, ws.interview.stories[q.id]);
        return "Q: " + q.q + "\n" + (w ? C.starAnswer(w) : "[No story picked yet]");
      });
      const d = addDraft("interview", "Interview answer sheet · " + C.fmtDate(t0()), "Interview answer sheet — " + ws.profile.targetRole + "\n\n" + parts.join("\n\n"));
      go("drafts");
      openDraft(d);
    };
    let timer = null;
    A.practice = () => {
      const ws = W();
      const withStory = C.INTERVIEW_QS.filter((q) => ws.interview.stories[q.id]);
      const pool = withStory.length && Math.random() < 0.7 ? withStory : C.INTERVIEW_QS;
      const q = pool[Math.floor(Math.random() * pool.length)];
      const w = byId(ws.wins, ws.interview.stories[q.id]);
      openSheet("Practice", '<div class="sheet-body" data-practice="' + q.id + '"><p class="question">' + esc(q.q) + '</p><p class="muted small">Answer out loud. Aim for about two minutes: situation, what you did, the result with a number.</p><div class="timer" data-timer>2:00</div><div class="row" style="justify-content:center"><button class="btn brown" data-act="timer">Start timer</button><button class="btn ghost" data-act="practice">Next question</button></div>' +
        (w ? '<details class="peek"><summary>Peek at your story</summary><div class="out">' + esc(C.starAnswer(w)) + "</div></details>" : '<p class="small muted">No story matched to this one yet.</p>') +
        '<div class="field"><span>How did that go?</span><div class="rating">' + [1, 2, 3, 4, 5].map((v) => '<button type="button" data-act="rate-practice" data-v="' + v + '">' + v + "</button>").join("") + "</div><small>1 = rambled · 5 = crisp, specific, with a number</small></div></div>");
    };
    A.timer = (el) => {
      clearInterval(timer);
      let left = 120;
      const out = $("[data-timer]");
      el.textContent = "Restart";
      timer = setInterval(() => {
        left--;
        if (!document.body.contains(out)) return clearInterval(timer);
        out.textContent = (left < 0 ? "-" : "") + Math.floor(Math.abs(left) / 60) + ":" + String(Math.abs(left) % 60).padStart(2, "0");
        out.style.color = left < 0 ? "var(--bad)" : left < 20 ? "var(--warn)" : "";
      }, 1000);
    };
    A["rate-practice"] = (el) => {
      const qid = el.closest("[data-practice]").dataset.practice;
      W().interview.practice = (W().interview.practice || []).concat([{ q: qid, date: t0(), rating: Number(el.dataset.v) }]).slice(-200);
      clearInterval(timer);
      save("interview");
      toast("Logged. Another one?", "Next", () => A.practice());
      closeSheet();
    };

    // ---------- mock interview (Ruhv) ----------
    let mock = null;
    A.mock = () => {
      const ws = W();
      mock = { msgs: [], busy: false };
      openSheet("Mock interview", '<div class="sheet-body"><div class="chat" data-mock></div><form class="composer" data-form="mock" style="bottom:0"><textarea class="textarea" name="text" rows="2" placeholder="Your answer…" aria-label="Your answer"></textarea><button class="btn brown">Send</button></form></div>');
      const brief = "You are Ruhv, playing a hiring manager interviewing an internal candidate for " + ws.profile.targetRole + " at " + (ws.profile.company || "DashMart") + " (DoorDash's own dark-store grocery and convenience warehouses). The candidate is currently a " + ws.profile.role + ".\nRun a realistic behavioural interview: ask ONE question at a time. After each answer give short feedback (2-4 bullets: what was strong, what was missing against STAR, whether they gave a number), a score out of 5, then ask the next question. Mix leadership, metrics, safety, labor planning and conflict. Keep it warm but honest. No emojis. Start now with a one-line welcome and the first question.";
      mock.brief = brief;
      mockTurn(brief);
    };
    async function mockTurn(firstUser) {
      const box = $("[data-mock]");
      if (!box || !api.sample) return;
      mock.busy = true;
      const turn = document.createElement("div");
      turn.className = "msg ruhv";
      turn.innerHTML = '<span class="who">Ruhv</span><span data-t>Thinking…</span>';
      box.appendChild(turn);
      const input = mock.msgs.length ? [{ role: "user", content: mock.brief + "\n\n(The interview has started.)" }].concat(mock.msgs) : [{ role: "user", content: firstUser }];
      // The platform needs alternating turns ending on the user.
      const fixed = [];
      for (const m of input) {
        if (fixed.length && fixed[fixed.length - 1].role === m.role) fixed[fixed.length - 1].content += "\n\n" + m.content;
        else fixed.push({ role: m.role, content: m.content });
      }
      try {
        const res = await api.sample(fixed, { cache: false, modelTier: "default", onText: ({ text }) => { const t = $("[data-t]", turn); if (t) t.textContent = text; } });
        mock.msgs.push({ role: "assistant", content: res.text });
        $("[data-t]", turn).textContent = res.text;
        turn.querySelector("[data-t]").removeAttribute("data-t");
      } catch (e) {
        $("[data-t]", turn).textContent = e && e.code === "rate_limited" ? "Ruhv needs a short break. Try again in a minute." : "Ruhv couldn't answer just now.";
      }
      mock.busy = false;
      turn.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    F.mock = (f) => {
      const text = val(f, "text");
      if (!text || !mock || mock.busy) return;
      if (!mock.msgs.length) mock.msgs.push({ role: "assistant", content: "(Welcome and first question asked.)" });
      mock.msgs.push({ role: "user", content: text });
      const me = document.createElement("div");
      me.className = "msg me";
      me.textContent = text;
      $("[data-mock]").appendChild(me);
      f.reset();
      mockTurn();
    };

    // ================================================================
    // ASK RUHV — coach chat with read-only access to the workspace
    // ================================================================
    let coachBusy = false;
    let coachAbort = null;
    const STARTERS = [
      "What should I focus on this week to move toward promotion?",
      "Prep me for my next 1:1 with my manager.",
      "Which competency is my weakest, and how can I show it on the floor?",
      "Look at my numbers. Which one should I attack first, and how?",
      "Write a short update to my skip-level about my last month.",
      "Who on my team needs attention right now?",
    ];
    const fmtMsg = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
    V.coach = function () {
      const ws = W();
      if (!api.sample) {
        return '<div class="view">' + head("Your career coach", "Ask Ruhv") + '<div class="empty"><b>Ruhv works inside Claude</b><span>Open this page from claude.ai or the Claude app to chat with Ruhv. Everything else in CareerCrumbs works without it.</span></div></div>';
      }
      const msgs = ws.coach || [];
      return (
        '<div class="view">' + head("Coach · reads your workspace, never changes it", "Ask Ruhv", msgs.length ? '<button class="btn sm ghost" data-act="coach-clear">New chat</button>' : "") +
        (msgs.length ? "" : '<p class="muted">Ruhv can look up your wins, numbers, team notes and plan when it answers. It only sees your data when you send a message, and it can\'t edit anything. It can save a draft if you ask.</p><div class="togglechips">' + STARTERS.map((s, i) => '<button class="chip" data-act="coach-starter" data-i="' + i + '">' + esc(s) + "</button>").join("") + "</div>") +
        '<div class="chat" data-chat>' + msgs.map((m, i) => (m.role === "user" ? '<div class="msg me">' + esc(m.content) + "</div>" : '<div class="msg ruhv"><span class="who">Ruhv</span>' + fmtMsg(m.content) + '<span class="msg-acts"><button class="linkbtn small" data-act="coach-copy" data-i="' + i + '">Copy</button><button class="linkbtn small" data-act="coach-draft" data-i="' + i + '">Save as draft</button></span></div>')).join("") + "</div>" +
        '<form class="composer" data-form="coach"><textarea class="textarea" id="coach-in" name="text" rows="2" placeholder="Ask Ruhv anything about your path…" aria-label="Message Ruhv"></textarea><button class="btn brown">Send</button></form>' +
        '<p class="muted small">Ruhv is Claude. It can be wrong, so check facts and numbers before you use them.</p></div>'
      );
    };
    function coachTools() {
      const ws = W();
      return [
        { name: "get_overview", description: "Returns the person's profile, promotion readiness, competency ratings with evidence counts, KPI statuses, this week's stats, today's agenda, open plan steps and active projects. Call this first.", execute: () => C.coachSummary(ws) },
        { name: "search_workspace", description: "Full-text search across wins, projects, drafts, team notes, people, jobs, shift logs, problems and learning. Returns up to 15 matches with type, title, snippet and date.", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, execute: (i) => C.searchAll(ws, String(i.query || "")).slice(0, 15) },
        { name: "get_wins", description: "Returns logged wins (title, date, situation, action, result, measured change, competencies), newest first. Optionally filter by competency name.", inputSchema: { type: "object", properties: { competency: { type: "string" }, limit: { type: "number" } } }, execute: (i) => {
          const c = i.competency ? ws.competencies.find((x) => x.name.toLowerCase().includes(String(i.competency).toLowerCase())) : null;
          return sortDesc(ws.wins, "date").filter((w) => !c || (w.competencies || []).includes(c.id)).slice(0, Math.min(Number(i.limit) || 10, 25)).map((w) => ({ title: w.title, date: w.date, situation: w.situation, action: w.action, result: w.result, measured: C.metricPhrase(w.metric), competencies: (w.competencies || []).map(compName) }));
        } },
        { name: "get_kpi_history", description: "Returns weekly values for one KPI by name (partial match), with unit, target and whether lower is better.", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, execute: (i) => {
          const k = ws.kpis.find((x) => x.name.toLowerCase().includes(String(i.name || "").toLowerCase()));
          if (!k) throw new Error("No KPI matches. Available: " + ws.kpis.map((x) => x.name).join(", "));
          return { name: k.name, unit: k.unit, target: k.target, better: k.better, weeks: (k.entries || []).slice(-26) };
        } },
        { name: "get_team", description: "Returns team members with role, shift, growth goal, last 1:1, recent notes (last 5) and certified stations.", execute: () => ws.team.map((m) => ({ name: m.name, role: m.role, shift: m.shift, growth: m.growth, lastOneOnOne: C.lastOneOnOne(m), recentNotes: sortDesc(m.notes || [], "date").slice(0, 5).map((n) => n.type + " " + n.date + ": " + n.text), certified: Object.entries(m.training || {}).filter(([, v]) => v >= 2).map(([s]) => s) })) },
        { name: "save_draft", description: "Saves a text document to the person's Drafts library (for updates, agendas, plans). Only call when the person asks you to save or write something for them to keep.", inputSchema: { type: "object", properties: { title: { type: "string" }, body: { type: "string" } }, required: ["title", "body"] }, execute: (i) => {
          const now = new Date().toISOString();
          ws.drafts.unshift({ id: C.uid("d"), kind: "coach", title: String(i.title || "From Ruhv").slice(0, 120), body: String(i.body || ""), created: now, updated: now });
          api.persist("drafts");
          return "Saved to Drafts.";
        } },
      ];
    }
    async function coachSend(text) {
      const ws = W();
      if (coachBusy || !api.sample) return;
      coachBusy = true;
      ws.coach = (ws.coach || []).concat([{ role: "user", content: text }]);
      render();
      const box = $("[data-chat]");
      const turn = document.createElement("div");
      turn.className = "msg ruhv";
      turn.innerHTML = '<span class="who">Ruhv</span><span data-t>Looking at your workspace…</span>';
      box.appendChild(turn);
      turn.scrollIntoView({ block: "nearest" });
      const brief = "You are Ruhv, the coach inside CareerCrumbs. The person is a " + ws.profile.role + " at " + (ws.profile.company || "DashMart") + " (DoorDash's own dark-store grocery and convenience warehouses) working toward " + ws.profile.targetRole + ". Today is " + t0() + ".\n" +
        "Use the tools to look at their real data before giving advice, and cite specifics (win titles, KPI values, names). Never invent numbers, wins or people. Be practical and specific to running a warehouse shift. Keep answers short: a few sentences or up to 6 bullets. Plain text, **bold** allowed, no headings, no emojis. If they ask you to write something to keep, write it and call save_draft.\n\n";
      const hist = ws.coach.slice(-16).map((m) => ({ role: m.role, content: m.content }));
      while (hist.length && hist[0].role !== "user") hist.shift();
      hist[0] = { role: "user", content: brief + hist[0].content };
      let tools = null;
      try {
        const lim = await api.sample.limits();
        if (lim && lim.tools) tools = coachTools();
      } catch (e) {}
      if (!tools) hist[0].content += "\n\n(Workspace summary: " + JSON.stringify(C.coachSummary(ws)) + ")";
      coachAbort = new AbortController();
      try {
        const opts = { modelTier: "default", signal: coachAbort.signal, onText: ({ text }) => { const t = $("[data-t]", turn); if (t) t.textContent = text; } };
        if (tools) opts.tools = tools;
        else opts.cache = false;
        const res = await api.sample(hist, opts);
        ws.coach.push({ role: "assistant", content: res.text });
        ws.coach = ws.coach.slice(-40);
        save("coach");
      } catch (e) {
        ws.coach.push({ role: "assistant", content: e && e.code === "rate_limited" ? "I need a short break. Try again in a minute." : e && e.code === "not_granted" ? "I'm not switched on for this page." : "I couldn't answer just now. Try again." });
        render();
      }
      coachBusy = false;
    }
    F.coach = (f) => {
      const t = val(f, "text");
      if (t) coachSend(t);
    };
    A["coach-starter"] = (el) => coachSend(STARTERS[el.dataset.i]);
    A["coach-clear"] = () => {
      W().coach = [];
      save("coach");
    };
    A["coach-copy"] = (el) => copyText(W().coach[el.dataset.i].content);
    A["coach-draft"] = (el) => {
      const d = addDraft("coach", "From Ruhv · " + C.fmtDate(t0()), W().coach[el.dataset.i].content);
      toast("Saved to drafts", "Open", () => { go("drafts"); openDraft(d); });
    };
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey && ev.target.id === "coach-in" && window.matchMedia("(min-width: 700px)").matches) {
        ev.preventDefault();
        ev.target.form.requestSubmit();
      }
    });

    // ================================================================
    // INSIGHTS
    // ================================================================
    function heatmap() {
      const ws = W();
      const weeks = 26;
      const end = C.today();
      const startMon = C.addDays(C.weekOf(end), -7 * (weeks - 1));
      const { counts } = C.activityByDay(ws, weeks * 7 + 7);
      const cell = 11, gap = 3, left = 24, top = 16;
      const Wd = left + weeks * (cell + gap), H = top + 7 * (cell + gap) + 4;
      let out = "";
      let lastMonth = -1;
      for (let w = 0; w < weeks; w++) {
        const mon = C.addDays(startMon, 7 * w);
        const m = C.parse(mon).getMonth();
        if (m !== lastMonth && w < weeks - 2) {
          out += '<text x="' + (left + w * (cell + gap)) + '" y="10" font-size="9" font-family="var(--mono)" fill="var(--muted)">' + C.fmtDate(mon).split(" ")[0] + "</text>";
          lastMonth = m;
        }
        for (let d = 0; d < 7; d++) {
          const day = C.addDays(mon, d);
          if (day > end) continue;
          const n = counts[day] || 0;
          const op = n === 0 ? 0 : n === 1 ? 0.35 : n === 2 ? 0.6 : n < 5 ? 0.8 : 1;
          out += '<rect x="' + (left + w * (cell + gap)) + '" y="' + (top + d * (cell + gap)) + '" width="' + cell + '" height="' + cell + '" rx="2" fill="' + (n ? "var(--brown)" : "var(--sunk)") + '"' + (n ? ' fill-opacity="' + op + '"' : "") + "><title>" + esc(C.fmtDateY(day) + ": " + plural(n, "entry").replace("entrys", "entries")) + "</title></rect>";
        }
      }
      out += ["Mon", "Wed", "Fri"].map((l, i) => '<text x="0" y="' + (top + i * 2 * (cell + gap) + 9) + '" font-size="9" font-family="var(--mono)" fill="var(--muted)">' + l + "</text>").join("");
      return '<svg class="heat" viewBox="0 0 ' + Wd + " " + H + '" role="img" aria-label="Activity over the last 26 weeks">' + out + "</svg>";
    }
    V.insights = function () {
      const ws = W();
      const ev = C.evidenceCounts(ws);
      const maxEv = Math.max(1, ...ws.competencies.map((c) => ev[c.id] || 0));
      const bm = C.evidenceByMonth(ws, 6);
      const maxCell = Math.max(1, ...bm.rows.flatMap((r) => r.counts));
      const gaps = C.recognitionGaps(ws, 30);
      const touches90 = ws.people.map((p) => ({ p, n: (p.touches || []).filter((t) => C.daysBetween(t.date, t0()) <= 90).length }));
      const maxT = Math.max(1, ...touches90.map((x) => x.n));
      const { counts } = C.activityByDay(ws, 30);
      const activeDays = Object.keys(counts).length;
      return (
        '<div class="view">' + head("Patterns in your own data", "Insights", '<button class="btn brown" data-act="quarter">Quarterly review</button>') +
        '<section class="card stack"><div class="row between"><h2>Activity</h2><span class="muted small">' + activeDays + " active days in the last 30</span></div>" + '<div class="scroll-x">' + heatmap() + '</div><p class="muted small">Wins, team notes, touchpoints, shift logs, reviews and logged numbers. Consistency beats bursts.</p></section>' +
        '<section class="card stack"><h2>Evidence by competency</h2>' + ws.competencies.map((c) => '<div class="hbar"><span title="' + esc(c.name) + '">' + esc(c.name) + '</span><span class="track"><i style="width:' + Math.round(((ev[c.id] || 0) / maxEv) * 100) + '%"></i></span><span class="mono">' + (ev[c.id] || 0) + "</span></div>").join("") +
        '<p class="muted small">Thin bars are where a promotion panel will push. Log a win that shows each one.</p></section>' +
        '<section class="card stack"><h2>Evidence over 6 months</h2><div class="scroll-x"><table class="matrix"><thead><tr><th>Competency</th>' + bm.keys.map((k) => "<th>" + esc(C.fmtDate(k + "-01").split(" ")[0]) + "</th>").join("") + "</tr></thead><tbody>" +
        bm.rows.map((r) => "<tr><td>" + esc(r.c.name) + "</td>" + r.counts.map((n) => '<td><span class="heatcell" style="background:' + (n ? "color-mix(in srgb, var(--brown) " + Math.round(25 + (n / maxCell) * 75) + "%, var(--surface))" : "var(--sunk)") + ";color:" + (n / maxCell > 0.5 ? "var(--brown-ink)" : "var(--ink)") + '">' + (n || "") + "</span></td>").join("") + "</tr>").join("") + "</tbody></table></div></section>" +
        (ws.kpis.length ? '<section class="card stack"><h2>Weeks on target</h2>' + ws.kpis.map((k) => {
          const h = C.kpiHitRate(k);
          return '<div class="hbar"><span title="' + esc(k.name) + '">' + esc(k.name) + '</span><span class="track"><i style="width:' + (h ? h.pct : 0) + '%"></i></span><span class="mono">' + (h ? h.pct + "%" : "—") + "</span></div>";
        }).join("") + '<p class="muted small">Share of logged weeks that met the target you set.</p></section>' : "") +
        (ws.team.length ? '<section class="card stack"><h2>Team attention</h2>' + (gaps.length ? '<p>Not recognised in 30+ days: ' + gaps.map((m) => "<b>" + esc(m.name) + "</b>").join(", ") + '</p><div class="row">' + gaps.slice(0, 3).map((m) => '<button class="btn sm ghost" data-act="note" data-id="' + m.id + '">Recognise ' + esc(m.name.split(" ")[0]) + "</button>").join("") + "</div>" : "<p>Everyone has been recognised in the last 30 days.</p>") + "</section>" : "") +
        (ws.people.length ? '<section class="card stack"><h2>Touchpoints · 90 days</h2>' + touches90.map(({ p, n }) => '<div class="hbar"><span>' + esc(p.name) + '</span><span class="track"><i style="width:' + Math.round((n / maxT) * 100) + '%"></i></span><span class="mono">' + n + "</span></div>").join("") + "</section>" : "") +
        "</div>"
      );
    };
    A.quarter = () => {
      const d = addDraft("quarter", "Quarterly review · " + C.fmtDate(t0()), C.quarterlyReview(W()));
      go("drafts");
      openDraft(d);
    };

    // ================================================================
    // GLOBAL: search, quick capture, setup, calendar, KPI paste
    // ================================================================
    A.search = () => {
      openSheet("Search", '<div class="sheet-body"><label class="field" for="gsearch"><span class="sr">Search everything</span><input class="input" id="gsearch" type="search" placeholder="Search wins, notes, drafts, shifts…" autocomplete="off"></label><div data-results><p class="muted small">Type at least 2 letters.</p></div></div>');
      setTimeout(() => { const i = $("#gsearch"); if (i) i.focus(); }, 30);
    };
    document.addEventListener("input", (ev) => {
      if (ev.target.id !== "gsearch") return;
      const res = C.searchAll(W(), ev.target.value);
      const out = $("[data-results]");
      out.innerHTML = res.length ? '<div class="list">' + res.map((r) => '<button class="li" data-act="open-hit" data-r="' + r.route + '" data-type="' + esc(r.type) + '" data-id="' + r.id + '"><span class="row between"><b>' + esc(r.title) + '</b><span class="pill">' + esc(r.type.split(" · ")[0]) + '</span></span><span class="small muted">' + esc(r.snippet) + "</span></button>").join("") + "</div>" : ev.target.value.trim().length < 2 ? '<p class="muted small">Type at least 2 letters.</p>' : '<p class="muted small">Nothing matches.</p>';
    });
    A["open-hit"] = (el) => {
      const { r, id } = el.dataset;
      const type = el.dataset.type;
      closeSheet();
      go(r);
      const fake = { dataset: { id } };
      setTimeout(() => {
        if (type === "Win") A["edit-win"](fake);
        else if (type === "Project") A["edit-project"](fake);
        else if (type === "Draft") A["open-draft"](fake);
        else if (type === "Job") A["edit-job"](fake);
        else if (type === "Person") A["edit-person"](fake);
        else if (type === "Shift log") A["edit-shift"](fake);
        else if (type === "Problem") A["edit-problem"](fake);
        else if (type === "Learning") A["edit-learn"](fake);
        else if (r === "team") A.member(fake);
      }, 30);
    };

    A.capture = () => {
      const ws = W();
      openSheet("Quick capture", '<form data-form="capture"><label class="field" for="cap-text"><span>What happened?</span><textarea class="textarea" id="cap-text" name="text" rows="3" required placeholder="Jot it now, tidy it later"></textarea></label>' +
        '<div class="field"><span>Save it as</span><div class="togglechips">' + [["win", "Win"], ["note", "Team note"], ["step", "Plan step"], ["shift", "Shift note"], ["draft", "Draft"]].map(([v, l], i) => '<label><input type="radio" name="as" value="' + v + '"' + (i === 0 ? " checked" : "") + "><span>" + l + "</span></label>").join("") + "</div></div>" +
        (ws.team.length ? fieldSelect("member", "Team member (for a team note)", "", ws.team.map((m) => [m.id, m.name])) : "") +
        '<div class="sheet-foot"><span class="grow"></span><button class="btn brown">Save</button></div></form>');
      setTimeout(() => { const i = $("#cap-text"); if (i) i.focus(); }, 30);
    };
    F.capture = (f) => {
      const ws = W();
      const text = val(f, "text");
      const as = (f.querySelector("input[name=as]:checked") || {}).value;
      if (!text) return;
      if (as === "win") return openSheet("Log a win", winForm(null, { title: text.slice(0, 100), action: text.length > 100 ? text : "" }));
      if (as === "note") {
        const m = byId(ws.team, val(f, "member"));
        if (!m) return toast("Add a team member first.");
        m.notes = (m.notes || []).concat([{ id: C.uid("n"), type: "Coaching", date: t0(), text }]);
        closeSheet();
        save("team");
        return toast("Noted for " + m.name);
      }
      if (as === "step") {
        ws.plan.push({ id: C.uid("p"), phase: "30", text, done: false });
        closeSheet();
        save("plan");
        return toast("Added to your 30-day plan");
      }
      if (as === "shift") {
        let s = ws.shifts.find((x) => x.date === t0());
        if (!s) {
          s = { id: C.uid("sh"), date: t0(), shift: "", safety: [], wentWell: "", issues: "" };
          ws.shifts.unshift(s);
        }
        s.issues = (s.issues ? s.issues + "\n" : "") + text;
        closeSheet();
        save("shifts");
        return toast("Added to today's shift log");
      }
      const d = addDraft("other", text.split("\n")[0].slice(0, 60), text);
      closeSheet();
      toast("Saved to drafts", "Open", () => { go("drafts"); openDraft(d); });
    };

    A.onboard = () => {
      const ws = W();
      const p = ws.profile;
      const presets = C.KPI_PRESETS.slice(0, 8);
      openSheet("Set up in 2 minutes", '<form data-form="onboard">' +
        '<div class="wiz-step"><h3><span class="mono">1</span>You</h3>' + fieldText("name", "Your name", p.name) + '<div class="fields2">' + fieldText("site", "Site / building", p.site) + fieldText("role", "Current role", p.role) + "</div>" + '<div class="fields2">' + fieldText("targetRole", "Next role", p.targetRole) + fieldText("targetDate", "Target date", p.targetDate, { type: "date" }) + "</div></div>" +
        '<div class="wiz-step"><h3><span class="mono">2</span>Numbers you own</h3><div class="togglechips">' + presets.map((k, i) => '<label><input type="checkbox" name="kpi" value="' + i + '"' + (i < 3 ? " checked" : "") + "><span>" + esc(k.name) + "</span></label>").join("") + "</div></div>" +
        '<div class="wiz-step"><h3><span class="mono">3</span>Your manager</h3><div class="fields2">' + fieldText("mgr", "Name", "") + fieldSelect("cad", "Touch base every", 7, [[7, "Week"], [14, "2 weeks"]]) + "</div></div>" +
        '<div class="wiz-step"><h3><span class="mono">4</span>Your team</h3>' + fieldText("team", "One name per line", "", { area: true, rows: 4, hint: "You can add roles and shifts later." }) + "</div>" +
        '<div class="sheet-foot"><button type="button" class="btn ghost" data-act="close">Skip</button><span class="grow"></span><button class="btn brown">Finish setup</button></div></form>');
    };
    F.onboard = (f) => {
      const ws = W();
      for (const k of ["name", "site", "role", "targetRole", "targetDate"]) if (val(f, k)) ws.profile[k] = val(f, k);
      for (const el of f.querySelectorAll("input[name=kpi]:checked")) {
        const p = C.KPI_PRESETS[Number(el.value)];
        if (!ws.kpis.some((k) => k.name === p.name)) ws.kpis.push({ id: C.uid("k"), name: p.name, unit: p.unit, better: p.better, target: null, entries: [] });
      }
      if (val(f, "mgr")) ws.people.push({ id: C.uid("s"), name: val(f, "mgr"), relation: "Manager", role: "", cadenceDays: Number(val(f, "cad")) || 7, touches: [], notes: "" });
      for (const n of val(f, "team").split("\n").map((s) => s.trim()).filter(Boolean)) ws.team.push({ id: C.uid("t"), name: n, role: "", shift: "", growth: "", notes: [], training: {} });
      closeSheet();
      save("profile", "kpis", "people", "team");
      go("home");
      toast("You're set up. Log your first win when something goes right today.");
    };

    A.ics = () => {
      const ev = C.upcomingReminders(W(), 30);
      if (!ev.length) return toast("Nothing due in the next 30 days.");
      saveFile("careercrumbs-reminders.ics", C.buildIcs(ev));
    };

    A["kpi-paste"] = (el) => {
      const k = byId(W().kpis, el.dataset.id);
      openSheet("Paste history", '<form data-form="kpipaste" data-id="' + k.id + '"><p class="muted">Copy two columns (date and value) from your site dashboard or a spreadsheet and paste them below. Each value is filed under its week; pasted weeks replace what\'s there.</p><label class="field" for="f-paste"><span>' + esc(k.name) + '</span><textarea class="textarea" id="f-paste" name="paste" rows="8" style="font-family:var(--mono)" placeholder="2026-10-19, 92&#10;2026-10-26, 95"></textarea></label><div data-paste-preview class="small muted"></div><div class="sheet-foot"><span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">Import</button></div></form>');
    };
    document.addEventListener("input", (ev) => {
      if (ev.target.id !== "f-paste") return;
      const r = C.parseKpiPaste(ev.target.value);
      $("[data-paste-preview]").textContent = r.entries.length ? plural(r.entries.length, "week") + " found (" + C.fmtDate(r.entries[0].week) + " to " + C.fmtDate(r.entries[r.entries.length - 1].week) + ")" + (r.bad ? "; " + plural(r.bad, "line") + " skipped" : "") : r.bad ? "No dates and values recognised yet." : "";
    });
    F.kpipaste = (f) => {
      const k = byId(W().kpis, f.dataset.id);
      const r = C.parseKpiPaste(val(f, "paste"));
      if (!r.entries.length) return toast("No dates and values recognised.");
      const map = {};
      for (const e of k.entries || []) map[e.week] = e;
      for (const e of r.entries) map[e.week] = Object.assign({ loggedAt: t0() }, e);
      k.entries = Object.values(map).sort((a, b) => (a.week < b.week ? -1 : 1)).slice(-156);
      closeSheet();
      save("kpis");
      toast("Imported " + plural(r.entries.length, "week") + " into " + k.name);
    };

    // ================================================================
    // HOME additions
    // ================================================================
    function homeTop() {
      const ws = W();
      const [topic, tip] = C.safetyTopic(t0());
      const logged = ws.shifts.some((s) => s.date === t0());
      return '<section class="card floor-card"><div class="row between"><span class="eyebrow">On the floor today</span><span class="eyebrow">Safety: ' + esc(topic) + "</span></div><p>" + esc(tip) + '</p><div class="row"><button class="btn sm brown" data-act="huddle">Huddle notes</button><button class="btn sm ghost" data-act="' + (logged ? "goto\" data-r=\"shift" : "new-shift") + '">' + (logged ? "Today's log" : "Log this shift") + "</button></div></section>";
    }
    function homeBottom() {
      const ws = W();
      const ir = C.interviewReadiness(ws);
      const learning = ws.learning.filter((l) => l.status === "In progress");
      const openProblems = ws.problems.filter((p) => p.status !== "Solved");
      const rem = C.upcomingReminders(ws, 14);
      return '<section class="stack"><h2>Growing</h2><div class="grid2">' +
        '<a class="card stack-s" href="#interview" style="text-decoration:none;color:inherit"><span class="eyebrow">Interview ready</span><b class="mono" style="font-size:1.5rem">' + ir.ready + "/" + ir.total + '</b><span class="small muted">questions matched to a story</span></a>' +
        '<a class="card stack-s" href="#learn" style="text-decoration:none;color:inherit"><span class="eyebrow">Learning in progress</span><b>' + (learning.length ? esc(learning[0].title) : "Nothing yet") + '</b><span class="small muted">' + (learning.length > 1 ? "+" + (learning.length - 1) + " more" : "Add a course or cert") + "</span></a>" +
        '<a class="card stack-s" href="#solve" style="text-decoration:none;color:inherit"><span class="eyebrow">Open problems</span><b class="mono" style="font-size:1.5rem">' + openProblems.length + '</b><span class="small muted">' + (openProblems[0] ? esc(openProblems[0].title) : "Nothing open") + "</span></a>" +
        '<div class="card stack-s"><span class="eyebrow">Next 14 days</span><b>' + plural(rem.length, "reminder") + '</b><button class="linkbtn small" data-act="ics" style="justify-self:start">' + "Add to my calendar (.ics)</button></div>" +
        "</div></section>";
    }

    return {
      homeTop,
      homeBottom,
      deletable: { shift: ["shifts", "this shift log"], problem: ["problems", "this problem"], learn: ["learning", "this item"] },
    };
  };
})();
