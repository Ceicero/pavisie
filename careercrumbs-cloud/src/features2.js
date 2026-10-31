// CareerCrumbs v3: team schedule, feedback & manager 1:1, weekly top 3, shout-outs, new-hire checklists.
(function () {
  "use strict";
  (window.CCFeatureList = window.CCFeatureList || []).push(function (api) {
    const C = window.CC;
    const { esc, icon, fieldText, fieldSelect, head, plural, byId, sortDesc, t0, save, persist, go, openSheet, closeSheet, toast, copyText, addDraft, openDraft, ui } = api;
    const V = api.views, A = api.actions, CH = api.changes, F = api.forms;
    const $ = (s, el) => (el || document).querySelector(s);
    const W = () => api.ws;
    const val = (f, n) => (f.elements[n] ? String(f.elements[n].value || "").trim() : "");
    const compName = (id) => (byId(W().competencies, id) || {}).name || "";

    function shareSheet(title, text, kind, draftTitle) {
      openSheet(esc(title), '<div class="sheet-body"><textarea class="textarea" id="ts-text" rows="14" style="font-family:var(--mono);font-size:0.85rem">' + esc(text) + '</textarea><div class="sheet-foot"><span class="grow"></span><button class="btn ghost" data-act="ts-copy">' + icon("copy") + "Copy</button>" + (kind ? '<button class="btn brown" data-act="ts-save" data-kind="' + kind + '" data-title="' + esc(draftTitle) + '">Save to drafts</button>' : "") + "</div></div>");
    }

    // ================================================================
    // TEAM SCHEDULE
    // ================================================================
    const CODE_LABEL = { "": "·", AM: "AM", PM: "PM", ON: "ON", OFF: "OFF", PTO: "PTO" };
    const curWeek = () => ui.schedWeek || C.weekOf(t0());
    V.schedule = function () {
      const ws = W();
      const wk = curWeek();
      const grid = C.scheduleWeek(ws, wk);
      const cov = C.scheduleCoverage(ws, wk);
      const hrs = C.scheduleHours(ws, wk, ws.schedule.hoursPerShift);
      const plan = C.laborPlan((ws.toolInputs || {}).labor || {});
      const short = cov.filter((c) => c.short);
      const isThis = wk === C.weekOf(t0());
      return (
        '<div class="view">' + head("Week of " + C.fmtDateY(wk) + (isThis ? " · this week" : ""), "Schedule", '<button class="btn ghost" data-act="sched-share">Share</button><button class="btn ghost" data-act="sched-copy">Copy last week</button>') +
        '<div class="row"><button class="btn sm ghost" data-act="sched-nav" data-d="-7" aria-label="Previous week">‹ Prev</button><button class="btn sm ghost" data-act="sched-nav" data-d="0"' + (isThis ? " disabled" : "") + '>This week</button><button class="btn sm ghost" data-act="sched-nav" data-d="7" aria-label="Next week">Next ›</button>' +
        (short.length ? '<span class="pill bad">Short ' + short.map((c) => c.day).join(", ") + "</span>" : cov.some((c) => c.need) ? '<span class="pill solid">Covered</span>' : "") + "</div>" +
        (ws.team.length
          ? '<section class="card stack"><p class="muted small">Tap a cell to step through AM → PM → ON (overnight) → OFF → PTO. Set how many people you need each day in the bottom row.</p><div class="scroll-x"><table class="matrix sched"><thead><tr><th>Person</th>' +
            cov.map((c) => "<th>" + c.day + '<br><span class="muted">' + C.parse(c.date).getDate() + "</span></th>").join("") + "<th>Hrs</th></tr></thead><tbody>" +
            ws.team.map((m) => "<tr><td>" + esc(m.name) + "</td>" + cov.map((c, i) => {
              const code = (grid[m.id] || [])[i] || "";
              return '<td><button class="lvl sc" data-act="sched-cell" data-id="' + m.id + '" data-i="' + i + '" data-c="' + code + '" aria-label="' + esc(m.name + ", " + c.day + ": " + (code || "not set")) + '">' + CODE_LABEL[code] + "</button></td>";
            }).join("") + '<td class="mono">' + hrs[m.id] + "</td></tr>").join("") +
            "</tbody><tfoot><tr><td>On shift</td>" + cov.map((c) => '<td><span class="pill ' + (c.short ? "bad" : c.need ? "solid" : "") + '" title="AM ' + c.by.AM + " · PM " + c.by.PM + " · ON " + c.by.ON + '">' + c.total + (c.need ? "/" + c.need : "") + "</span></td>").join("") + "<td></td></tr>" +
            '<tr><td>Need</td>' + cov.map((c, i) => '<td><input class="input need" inputmode="numeric" aria-label="People needed ' + c.day + '" value="' + (c.need == null ? "" : c.need) + '" data-act-change="sched-need" data-i="' + i + '"></td>').join("") + "<td></td></tr></tfoot></table></div>" +
            '<div class="row small muted"><span>Hours per shift</span><input class="input need" style="width:64px" inputmode="decimal" aria-label="Hours per shift" value="' + ws.schedule.hoursPerShift + '" data-act-change="sched-hours"><span>· ' + Object.values(hrs).reduce((a, b) => a + b, 0) + " scheduled hours this week</span></div>" +
            (plan ? '<div class="row small"><span class="muted">Labor planner says <b>' + plan.headcount + "</b> people per day.</span><button class=\"linkbtn small\" data-act=\"sched-plan\">Use as daily need</button></div>" : "") +
            "</section>"
          : '<div class="empty"><b>Add your team first</b><span>The schedule uses the people on your Team page.</span><a class="btn brown" href="#team">Go to Team</a></div>') +
        "</div>"
      );
    };
    function setGrid(wk, fn) {
      const sc = W().schedule;
      const grid = Object.assign({}, sc.weeks[wk]);
      fn(grid);
      sc.weeks = Object.assign({}, sc.weeks, { [wk]: grid });
      const keys = Object.keys(sc.weeks).sort();
      while (keys.length > 16) delete sc.weeks[keys.shift()];
    }
    A["sched-cell"] = (el) => {
      const wk = curWeek();
      const next = C.SCHED_CODES[(C.SCHED_CODES.indexOf(el.dataset.c) + 1) % C.SCHED_CODES.length];
      setGrid(wk, (g) => {
        const row = (g[el.dataset.id] || ["", "", "", "", "", "", ""]).slice();
        row[Number(el.dataset.i)] = next;
        g[el.dataset.id] = row;
      });
      save("schedule");
    };
    A["sched-nav"] = (el) => {
      const d = Number(el.dataset.d);
      ui.schedWeek = d === 0 ? C.weekOf(t0()) : C.addDays(curWeek(), d);
      api.render();
    };
    A["sched-copy"] = () => {
      const wk = curWeek();
      const prev = C.scheduleWeek(W(), C.addDays(wk, -7));
      if (!Object.keys(prev).length) return toast("Last week is empty.");
      setGrid(wk, (g) => Object.assign(g, JSON.parse(JSON.stringify(prev))));
      save("schedule");
      toast("Copied last week's schedule");
    };
    A["sched-share"] = () => shareSheet("Schedule", C.scheduleText(W(), curWeek()), null);
    A["sched-plan"] = () => {
      const p = C.laborPlan((W().toolInputs || {}).labor || {});
      W().schedule.needs = [0, 1, 2, 3, 4, 5, 6].map(() => p.headcount);
      save("schedule");
    };
    CH["sched-need"] = (el) => {
      const n = W().schedule.needs.slice();
      while (n.length < 7) n.push(null);
      n[Number(el.dataset.i)] = C.num(el.value);
      W().schedule.needs = n;
      save("schedule");
    };
    CH["sched-hours"] = (el) => {
      W().schedule.hoursPerShift = C.num(el.value) || 8;
      save("schedule");
    };

    // ================================================================
    // FEEDBACK & MANAGER 1:1
    // ================================================================
    V.feedback = function () {
      const ws = W();
      const list = sortDesc(ws.feedback, "date");
      const d90 = ws.feedback.filter((f) => C.daysBetween(f.date, t0()) <= 90);
      const open = ws.feedback.filter((f) => !f.actedOn && (f.kind === "Coaching" || f.kind === "Concern" || f.kind === "Ask"));
      const mgr = ws.people.find((p) => p.relation === "Manager");
      return (
        '<div class="view">' + head("What your leaders tell you", "Feedback & 1:1", '<button class="btn ghost" data-act="new-feedback">' + icon("plus") + 'Log feedback</button><button class="btn brown" data-act="mgr-agenda">Prep my 1:1</button>') +
        '<p class="muted">Write feedback down the day you get it, then show you acted on it. Closing the loop on coaching is one of the clearest signals a manager looks for before a promotion.</p>' +
        '<div class="tiles"><div class="tile"><span class="eyebrow">Praise · 90d</span><b>' + d90.filter((f) => f.kind === "Praise").length + '</b></div><div class="tile"><span class="eyebrow">Coaching · 90d</span><b>' + d90.filter((f) => f.kind === "Coaching").length + '</b></div><div class="tile"><span class="eyebrow">Open to act on</span><b>' + open.length + '</b></div><div class="tile"><span class="eyebrow">Last manager 1:1</span><b style="font-size:1.1rem">' + (mgr && C.lastTouch(mgr) ? esc(C.fmtDate(C.lastTouch(mgr))) : "—") + "</b></div></div>" +
        (list.length
          ? '<div class="list">' + list.map((f) => '<div class="li" style="cursor:default"><span class="row between"><span class="row"><span class="pill ' + (f.kind === "Praise" ? "solid" : f.kind === "Concern" ? "bad" : "brown") + '">' + esc(f.kind) + '</span><span class="small muted">' + esc((f.from ? f.from + " · " : "") + C.fmtDate(f.date)) + "</span></span>" +
              (f.kind !== "Praise" ? '<label class="check small"><input type="checkbox" data-act-change="fb-done" data-id="' + f.id + '"' + (f.actedOn ? " checked" : "") + ">Acted on</label>" : "") + "</span><b>" + esc(f.text) + "</b>" +
              (f.action ? '<span class="small">→ ' + esc(f.action) + "</span>" : "") + (f.comp ? '<span class="small muted">' + esc(compName(f.comp)) + "</span>" : "") +
              '<span class="row"><button class="linkbtn small" data-act="edit-feedback" data-id="' + f.id + '">Edit</button>' + (f.kind !== "Praise" && !f.actedOn ? '<button class="linkbtn small" data-act="fb-step" data-id="' + f.id + '">Make it a plan step</button>' : "") + (f.kind === "Praise" ? '<button class="linkbtn small" data-act="fb-win" data-id="' + f.id + '">Log the win behind it</button>' : "") + "</span></div>").join("") + "</div>"
          : '<div class="empty"><b>No feedback logged</b><span>Next time your manager says "nice job" or "next time, try…", log it here.</span><button class="btn brown" data-act="new-feedback">Log feedback</button></div>') +
        "</div>"
      );
    };
    function feedbackForm(f) {
      const ws = W();
      f = f || { date: t0(), kind: "Coaching", from: ((ws.people.find((p) => p.relation === "Manager") || {}).name || "") };
      return (
        '<form data-form="feedback" data-id="' + esc(f.id || "") + '"><div class="fields2">' + fieldText("date", "Date", f.date, { type: "date" }) + fieldSelect("kind", "Kind", f.kind, C.FEEDBACK_KINDS) + "</div>" +
        '<label class="field" for="f-from"><span>From</span><input class="input" id="f-from" name="from" list="fb-people" value="' + esc(f.from || "") + '"><datalist id="fb-people">' + ws.people.map((p) => '<option value="' + esc(p.name) + '">').join("") + "</datalist></label>" +
        fieldText("text", "What they said", f.text, { area: true, req: true, rows: 3, ph: "As close to their words as you can" }) +
        fieldText("action", "What you'll do about it", f.action, { ph: "One specific change" }) +
        fieldSelect("comp", "Relates to", f.comp || "", [["", "—"]].concat(ws.competencies.map((c) => [c.id, c.name]))) +
        '<div class="sheet-foot">' + (f.id ? '<button type="button" class="btn danger sm" data-act="ask-del" data-kind="feedback" data-id="' + f.id + '">Delete</button>' : "") + '<span class="grow"></span><button type="button" class="btn ghost" data-act="close">Cancel</button><button class="btn brown">Save</button></div><div data-confirm></div></form>'
      );
    }
    A["new-feedback"] = () => openSheet("Log feedback", feedbackForm());
    A["edit-feedback"] = (el) => openSheet("Feedback", feedbackForm(byId(W().feedback, el.dataset.id)));
    F.feedback = (f) => {
      const id = f.dataset.id;
      const ws = W();
      const data = { date: val(f, "date") || t0(), kind: val(f, "kind"), from: val(f, "from"), text: val(f, "text"), action: val(f, "action"), comp: val(f, "comp") };
      if (id) Object.assign(byId(ws.feedback, id), data);
      else ws.feedback.push(Object.assign({ id: C.uid("f"), actedOn: false }, data));
      closeSheet();
      save("feedback");
      toast(data.kind === "Praise" ? "Logged. Is there a win behind it?" : "Logged. Close the loop when you've acted on it.");
    };
    CH["fb-done"] = (el) => {
      byId(W().feedback, el.dataset.id).actedOn = el.checked;
      save("feedback");
    };
    A["fb-step"] = (el) => {
      const f = byId(W().feedback, el.dataset.id);
      W().plan.push({ id: C.uid("p"), phase: "30", text: f.action || "Act on: " + f.text.slice(0, 90), done: false });
      save("plan");
      toast("Added to your 30-day plan");
    };
    A["fb-win"] = (el) => {
      const f = byId(W().feedback, el.dataset.id);
      openSheet("Log a win", api.winForm(null, { title: f.text.slice(0, 90), date: f.date, result: (f.from ? f.from + ": " : "") + f.text, competencies: f.comp ? [f.comp] : [] }));
    };
    A["mgr-agenda"] = () => {
      const d = addDraft("oneonone", "1:1 with my manager · " + C.fmtDate(t0()), C.managerAgenda(W()));
      go("drafts");
      openDraft(d);
    };

    // ================================================================
    // THIS WEEK'S TOP 3 (home + weekly review)
    // ================================================================
    function prioritiesCard() {
      const ws = W();
      const wk = C.weekOf(t0());
      const items = C.weekPriorities(ws, wk);
      const done = items.filter((p) => p.done).length;
      return '<section class="card stack"><div class="row between"><h2>This week\'s top 3</h2><span class="mono small muted">' + done + "/" + items.length + " done</span></div>" +
        (items.length ? '<div class="stack-s">' + items.map((p, i) => '<label class="check prio' + (p.done ? " done" : "") + '"><input type="checkbox" data-act-change="prio-done" data-i="' + i + '"' + (p.done ? " checked" : "") + "><span>" + esc(p.text) + '</span><button type="button" class="iconbtn" style="margin-left:auto;width:30px;height:30px" aria-label="Remove" data-act="prio-del" data-i="' + i + '">' + icon("close") + "</button></label>").join("") + "</div>" : '<p class="muted small">Pick the three things that would make this week a success. Keep them small enough to finish.</p>') +
        (items.length < 3 ? '<form class="row" data-form="prio"><input class="input" style="flex:1 1 200px" name="text" placeholder="Add a priority" aria-label="New priority" required><button class="btn sm ghost">Add</button></form>' : "") +
        "</section>";
    }
    function setPrios(fn) {
      const ws = W();
      const wk = C.weekOf(t0());
      const list = C.weekPriorities(ws, wk).map((p) => Object.assign({}, p));
      fn(list);
      ws.priorities = Object.assign({}, ws.priorities, { [wk]: list.slice(0, 3) });
      const keys = Object.keys(ws.priorities).sort();
      while (keys.length > 26) delete ws.priorities[keys.shift()];
      save("priorities");
    }
    F.prio = (f) => setPrios((l) => l.push({ text: val(f, "text"), done: false }));
    CH["prio-done"] = (el) => {
      setPrios((l) => (l[Number(el.dataset.i)].done = el.checked));
      if (el.checked) toast("Done. That's one of the three.");
    };
    A["prio-del"] = (el) => setPrios((l) => l.splice(Number(el.dataset.i), 1));
    const baseReview = V.review;
    V.review = function () {
      const html = baseReview();
      const last = C.weekPriorities(W(), C.weekOf(t0()));
      const card = '<section class="card stack-s"><span class="eyebrow">This week\'s top 3</span>' + (last.length ? last.map((p) => '<span class="small">' + (p.done ? "✓ " : "○ ") + esc(p.text) + "</span>").join("") : '<span class="small muted">You didn\'t set priorities this week. Set next week\'s on Home on Monday.</span>') + "</section>";
      return html.replace('<form class="card stack" data-form="review"', card + '<form class="card stack" data-form="review"');
    };

    // ================================================================
    // SHOUT-OUTS & NEW-HIRE CHECKLISTS (Team)
    // ================================================================
    A.kudos = (el) => {
      const ws = W();
      const id = el && el.dataset && el.dataset.id;
      openSheet("Shout-out", '<form data-form="kudos">' +
        fieldSelect("member", "Who", id || (ws.team[0] || {}).id || "", ws.team.map((m) => [m.id, m.name])) +
        fieldText("what", "For what", "", { req: true, ph: "Caught a mislabeled cold-chain pallet" }) +
        fieldText("impact", "Why it mattered", "", { ph: "Kept a customer's frozen order safe" }) +
        '<div class="field"><span>Message</span><div class="out" data-kudos></div><small>Specific beats generic: what they did and why it mattered.</small></div>' +
        '<label class="check"><input type="checkbox" name="log" checked> Log it as recognition on their record</label>' +
        '<div class="sheet-foot"><span class="grow"></span><button type="button" class="btn ghost" data-act="kudos-copy">' + icon("copy") + 'Copy</button><button class="btn brown">Save</button></div></form>');
      kudosPreview();
    };
    function kudosPreview() {
      const f = $("form[data-form=kudos]");
      if (!f) return;
      const m = byId(W().team, val(f, "member"));
      $("[data-kudos]", f).textContent = C.kudosText(m ? m.name : "", val(f, "what"), val(f, "impact"));
    }
    document.addEventListener("input", (ev) => { if (ev.target.closest && ev.target.closest("form[data-form=kudos]")) kudosPreview(); });
    document.addEventListener("change", (ev) => { if (ev.target.closest && ev.target.closest("form[data-form=kudos]")) kudosPreview(); });
    A["kudos-copy"] = () => copyText($("[data-kudos]").textContent);
    F.kudos = (f) => {
      const m = byId(W().team, val(f, "member"));
      if (m && f.elements.log.checked) {
        m.notes = (m.notes || []).concat([{ id: C.uid("n"), type: "Recognition", date: t0(), text: val(f, "what") + (val(f, "impact") ? " — " + val(f, "impact") : "") }]);
        save("team");
      }
      copyText($("[data-kudos]", f).textContent);
      closeSheet();
    };

    const baseMember = A.member;
    A.member = (el) => {
      baseMember(el);
      const m = byId(W().team, el.dataset.id);
      const body = $(".sheet .sheet-body");
      if (!m || !body) return;
      const wrap = document.createElement("section");
      wrap.className = "card stack";
      wrap.innerHTML = onboardingHtml(m);
      body.prepend(wrap);
    };
    function onboardingHtml(m) {
      const list = m.onboarding || [];
      if (!list.length) return '<div class="row between"><span><b>New hire?</b> <span class="muted small">Track their first 30 days.</span></span><button class="btn sm ghost" data-act="onb-start" data-id="' + m.id + '">Start 30-day checklist</button></div>';
      const done = list.filter((x) => x.done).length;
      const day = m.hiredAt ? C.daysBetween(m.hiredAt, t0()) + 1 : null;
      return '<div class="row between"><b>First 30 days</b><span class="mono small muted">' + (day ? "Day " + day + " · " : "") + done + "/" + list.length + '</span></div><div class="progress"><i style="width:' + Math.round((done / list.length) * 100) + '%"></i></div><div class="ms">' +
        list.map((x, i) => '<label><input type="checkbox" data-act-change="onb" data-id="' + m.id + '" data-i="' + i + '"' + (x.done ? " checked" : "") + "><span>" + esc(x.text) + "</span></label>").join("") + "</div>";
    }
    A["onb-start"] = (el) => {
      const m = byId(W().team, el.dataset.id);
      m.onboarding = C.NEW_HIRE_CHECKLIST.map((text) => ({ text, done: false }));
      m.hiredAt = m.hiredAt || t0();
      persist("team");
      el.closest("section").innerHTML = onboardingHtml(m);
    };
    CH.onb = (el) => {
      const m = byId(W().team, el.dataset.id);
      m.onboarding[Number(el.dataset.i)].done = el.checked;
      persist("team");
      const sec = el.closest("section");
      if (sec) sec.innerHTML = onboardingHtml(m);
      if (m.onboarding.every((x) => x.done)) toast(m.name + " is fully onboarded. Worth a shout-out.", "Shout-out", () => A.kudos({ dataset: { id: m.id } }));
    };

    return {
      homeTop: prioritiesCard,
      deletable: { feedback: ["feedback", "this feedback"] },
    };
  });
})();
