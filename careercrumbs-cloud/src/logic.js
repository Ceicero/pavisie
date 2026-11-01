// CareerCrumbs: pure helpers for a job search. No DOM, no storage, no AI.
(function (root) {
  "use strict";

  // ---------- ids, dates, text ----------
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
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const fmtDate = (s) => (s ? MONTHS[parse(s).getMonth()] + " " + parse(s).getDate() : "");
  const fmtDateY = (s) => (s ? fmtDate(s) + ", " + parse(s).getFullYear() : "");
  const fmtTime = (dt) => {
    const m = String(dt || "").match(/T(\d{2}):(\d{2})/);
    if (!m) return "";
    const h = Number(m[1]);
    return (h % 12 || 12) + ":" + m[2] + (h < 12 ? " am" : " pm");
  };
  const fmtWhen = (dt) => (dt ? DAYS[parse(dt).getDay()] + " " + fmtDate(dt) + (fmtTime(dt) ? ", " + fmtTime(dt) : "") : "");
  const relDays = (s, now) => {
    const n = daysBetween(today(now), s);
    if (n === 0) return "today";
    if (n === 1) return "tomorrow";
    if (n === -1) return "yesterday";
    return n > 0 ? "in " + n + " days" : Math.abs(n) + " days ago";
  };
  const clean = (s) => String(s || "").trim().replace(/\s+/g, " ").replace(/[.\s]+$/, "");
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const lower1 = (s) => (s && !/^[A-Z]{2}/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
  const firstName = (s) => String(s || "").trim().split(/\s+/)[0] || "";

  // ---------- question bank ----------
  // Written for everyday jobs: warehouse, retail, customer service, team lead.
  const PACKS = {
    common: "Common",
    behavioral: "Behavioral",
    warehouse: "Warehouse & operations",
    service: "Customer service & retail",
    lead: "Lead & supervisor",
    ask: "Questions to ask them",
    mine: "My questions",
  };
  const STAR_TIP = "Use a real example. Situation and task in one or two sentences, most of your time on what you did, then the result. A number makes it stick.";
  const Q = (id, pack, q, tip, star) => ({ id, pack, q, tip: tip || (star ? STAR_TIP : ""), star: !!star });
  const BANK = [
    Q("c1", "common", "Tell me about yourself.", "Present, past, future in about a minute: what you do now, one or two things from before that fit this job, and why you want this one. Keep your personal life out of it."),
    Q("c2", "common", "Why do you want to work here?", "Name something specific about this company or job: the schedule, the team, what they're known for, a chance to grow. Then connect it to you."),
    Q("c3", "common", "Why should we hire you?", "Three reasons that match the job posting, each backed by something you've done. End with how quickly you'll be useful."),
    Q("c4", "common", "What are your greatest strengths?", "Pick two that the job needs and give a quick example of each. Reliable, fast, accurate and good with people all count if you can prove them."),
    Q("c5", "common", "What's a weakness you're working on?", "Pick a real one that won't sink you for this job, then spend most of the answer on what you're doing about it."),
    Q("c6", "common", "Why are you leaving your current job?", "Stay positive and look forward: more hours, growth, a better fit, a shorter commute. Never criticise your current employer."),
    Q("c7", "common", "Tell me about a gap in your work history.", "Be brief and honest: caregiving, school, health, a move, a hard job market. Then say what you did to stay sharp and that you're ready now."),
    Q("c8", "common", "What is your availability?", "Know your real answer before the interview: days, shifts, weekends, overtime, start date. Being flexible helps, but don't promise what you can't keep."),
    Q("c9", "common", "What are your pay expectations?", "Look up the going rate first. Give a range you'd be happy with, or say you're open and ask what the range is for the role."),
    Q("c10", "common", "Where do you see yourself in a few years?", "Show you'd like to stay and grow: get great at this job, then take on more, like training others or leading a shift."),
    Q("b1", "behavioral", "Tell me about a time you had a conflict with a coworker.", "", true),
    Q("b2", "behavioral", "Tell me about a mistake you made at work and what you did about it.", "Own it quickly, spend most of the answer on how you fixed it, and finish with what you do differently now.", true),
    Q("b3", "behavioral", "Describe a time you worked under pressure or a tight deadline.", "", true),
    Q("b4", "behavioral", "Tell me about a time you went above and beyond.", "", true),
    Q("b5", "behavioral", "Tell me about a time you worked on a team to reach a goal.", "Say what the team did and what you did. Use I for your part.", true),
    Q("b6", "behavioral", "Tell me about a time you disagreed with your manager.", "Show you raised it respectfully, listened, and still did the work. A good ending is that you found a better way together.", true),
    Q("b7", "behavioral", "Tell me about a time you had to learn something new quickly.", "", true),
    Q("b8", "behavioral", "Tell me about a time you took initiative without being asked.", "", true),
    Q("b9", "behavioral", "How do you handle a lot of tasks at once?", "Give your method (what comes first and why), then a short example of a busy day where it worked.", true),
    Q("b10", "behavioral", "Tell me about a time you got critical feedback.", "Show you listened without getting defensive, made a change, and what improved.", true),
    Q("w1", "warehouse", "Tell me about a time you spotted a safety hazard.", "Safety answers win warehouse interviews. Say what you saw, that you stopped or reported it, and what changed.", true),
    Q("w2", "warehouse", "How do you keep up with productivity targets?", "Mention a rate you've hit if you have one (units or orders per hour), and how: staying organised, learning the layout, not cutting corners on accuracy."),
    Q("w3", "warehouse", "How do you make sure your work is accurate?", "Double-checking labels and counts, scanning carefully, fixing mistakes right away. An example of catching an error is gold.", true),
    Q("w4", "warehouse", "This job is physical and the shifts can be long. How do you handle that?", "Be honest and confident: past physical work, how you pace yourself, that you're reliable on long or early shifts."),
    Q("w5", "warehouse", "What equipment have you used?", "List what you've actually used: RF scanner, pallet jack, forklift (certified?), label printers, warehouse software. Say you learn new equipment quickly."),
    Q("w6", "warehouse", "Tell me about a time it got really busy. How did you handle the rush?", "", true),
    Q("w7", "warehouse", "What would you do if you saw a coworker skipping a safety rule?", "Speak up respectfully in the moment, and tell a lead if it continues. Safety comes before friendship or speed."),
    Q("s1", "service", "Tell me about a time you dealt with an upset customer.", "Stay calm, listen, apologise for the experience, fix what you can, and get help when you can't. Finish with how the customer left.", true),
    Q("s2", "service", "What does great customer service mean to you?", "Give your definition in one line, then a quick example of you doing it."),
    Q("s3", "service", "How do you handle several customers needing you at once?", "Acknowledge everyone, help in order, call for backup when needed. A real example helps.", true),
    Q("s4", "service", "Tell me about a time you made a customer's day.", "", true),
    Q("s5", "service", "How do you handle cash and keep your drawer accurate?", "Count carefully, follow the procedures, and speak up right away if something's off. Mention any time you were balanced or trusted with closing."),
    Q("l1", "lead", "How do you motivate a team?", "Specific recognition, clear goals for the shift, fairness, and leading by example. Back it with a moment it worked.", true),
    Q("l2", "lead", "Tell me about a time you dealt with an underperforming team member.", "Private conversation, clear expectations, support or training, follow-up. Show you were fair and firm.", true),
    Q("l3", "lead", "How do you handle call-outs when you're short-staffed?", "Re-prioritise, move people to the most important work, jump in yourself, and communicate early with your manager.", true),
    Q("l4", "lead", "Tell me about a time you resolved a conflict between two team members.", "", true),
    Q("l5", "lead", "How do you give feedback to someone who isn't meeting expectations?", "Specific, private, soon after it happens, focused on the behaviour and the fix. Follow up."),
    Q("l6", "lead", "What would you do in your first 90 days in this role?", "Learn the people and the numbers first, find one or two quick wins, then build a plan with your manager."),
    Q("a1", "ask", "What does a great first 90 days look like in this role?", "Shows you plan to do well. Write down their answer."),
    Q("a2", "ask", "How do you measure success for this position?", ""),
    Q("a3", "ask", "What do you like most about working here?", ""),
    Q("a4", "ask", "What's the biggest challenge the team is facing right now?", ""),
    Q("a5", "ask", "How do people grow here? Is there training or a path to lead?", ""),
    Q("a6", "ask", "What are the next steps, and when should I expect to hear back?", "Always ask this one. It tells you when to follow up."),
  ];

  // Words per minute for a relaxed interview pace.
  const WPM = 140;
  function answerText(a) {
    if (!a) return "";
    if (a.mode === "star") return ["s", "t", "a", "r"].map((k) => clean(a[k])).filter(Boolean).join(". ");
    return String(a.text || "").trim();
  }
  const wordCount = (s) => (String(s || "").match(/[A-Za-z0-9’']+/g) || []).length;
  function speakTime(words) {
    const sec = Math.round((words / WPM) * 60);
    return Math.floor(sec / 60) + ":" + pad(sec % 60);
  }
  // Coaching on length only; never on content.
  function lengthHint(q, words) {
    if (!words) return "";
    if (q.pack === "ask") return "";
    const sec = (words / WPM) * 60;
    const long = q.star ? 150 : 100;
    if (sec < 20) return "Short. Add a detail or an example.";
    if (sec > long) return "Long. Try cutting it to two minutes or less.";
    return "Good length.";
  }

  // ---------- jobs ----------
  const STATUSES = ["Saved", "Applied", "Interview", "Offer", "Closed"];
  function setStatus(job, status, now) {
    const at = (now || new Date()).toISOString();
    const next = Object.assign({}, job, { status });
    next.history = (job.history || []).concat([{ status, at }]);
    if (status === "Applied" && !job.appliedAt) next.appliedAt = at.slice(0, 10);
    return next;
  }
  function jobBadge(job, now) {
    const t = today(now);
    if (job.status === "Closed" || job.status === "Offer") return null;
    if (job.interviewAt && job.interviewAt.slice(0, 10) >= t) {
      const n = daysBetween(t, job.interviewAt);
      return { tone: n <= 1 ? "warn" : "brown", text: "Interview " + (n <= 1 ? relDays(job.interviewAt, now) : fmtWhen(job.interviewAt)) + (n <= 1 && fmtTime(job.interviewAt) ? " " + fmtTime(job.interviewAt) : "") };
    }
    if (job.followUpAt) {
      const n = daysBetween(t, job.followUpAt);
      if (n < 0) return { tone: "bad", text: "Follow-up overdue by " + -n + (n === -1 ? " day" : " days") };
      if (n === 0) return { tone: "warn", text: "Follow up today" };
      return { tone: "", text: "Follow up " + relDays(job.followUpAt, now) };
    }
    return null;
  }
  // What needs doing today, most urgent first.
  function todo(ws, now) {
    const t = today(now);
    const out = [];
    for (const j of ws.jobs) {
      if (j.status === "Closed") continue;
      if (j.interviewAt) {
        const n = daysBetween(t, j.interviewAt);
        if (n >= 0 && n <= 3) out.push({ tone: n <= 1 ? "warn" : "", job: j.id, act: "prep", title: "Prepare: " + j.title + " at " + j.company, sub: "Interview " + relDays(j.interviewAt, now) + (fmtTime(j.interviewAt) ? " at " + fmtTime(j.interviewAt) : "") });
        if (n < 0 && n >= -3 && !j.thankYouSent && j.status === "Interview") out.push({ tone: "warn", job: j.id, act: "messages", title: "Send a thank-you to " + j.company, sub: "Interviewed " + relDays(j.interviewAt, now) + ". Within 24 hours is best." });
      }
      if (j.followUpAt && daysBetween(t, j.followUpAt) <= 0) out.push({ tone: daysBetween(t, j.followUpAt) < 0 ? "bad" : "warn", job: j.id, act: "messages", title: "Follow up with " + j.company, sub: j.title + " · " + (daysBetween(t, j.followUpAt) < 0 ? "overdue" : "due today") });
    }
    const rank = { bad: 0, warn: 1, "": 2 };
    return out.sort((a, b) => rank[a.tone] - rank[b.tone]);
  }
  function nextInterview(ws, now) {
    const t = today(now);
    return ws.jobs.filter((j) => j.interviewAt && j.interviewAt.slice(0, 10) >= t && j.status !== "Closed").sort((a, b) => (a.interviewAt < b.interviewAt ? -1 : 1))[0] || null;
  }

  // Message templates. Plain, polite and short; [brackets] mark what to fill in.
  function messages(job, profile) {
    const me = clean(profile.name) || "[Your name]";
    const hi = job.contact ? "Hi " + firstName(job.contact) + "," : "Hello,";
    const role = job.title || "[role]";
    const co = job.company || "[company]";
    return [
      { id: "followup", label: "Follow up on my application", subject: "Following up: " + role + " application", body: hi + "\n\nI applied for the " + role + " position" + (job.appliedAt ? " on " + fmtDate(job.appliedAt) : "") + " and wanted to follow up. I'm still very interested and I'm available to interview at your convenience.\n\nThank you for your time,\n" + me },
      { id: "thanks", label: "Thank you after the interview", subject: "Thank you: " + role + " interview", body: hi + "\n\nThank you for meeting with me" + (job.interviewAt ? " " + (daysBetween(job.interviewAt.slice(0, 10), today()) <= 0 ? "today" : "on " + fmtDate(job.interviewAt)) : "") + " about the " + role + " position. I enjoyed learning about [something you discussed], and I'm even more excited about the chance to join " + co + ".\n\n[One line on why you're a good fit.]\n\nPlease let me know if you need anything else from me.\n\nBest,\n" + me },
      { id: "confirm", label: "Confirm an interview time", subject: "Interview confirmation: " + role, body: hi + "\n\nThank you for the invitation. I'm confirming my interview for the " + role + " position" + (job.interviewAt ? " on " + fmtWhen(job.interviewAt) : " on [day and time]") + ". Please let me know if there's anything I should bring.\n\nSee you then,\n" + me },
      { id: "status", label: "Check on a decision", subject: "Checking in: " + role, body: hi + "\n\nI hope you're well. I'm checking in on the " + role + " position. I'm still very interested in joining " + co + " and would be glad to answer any other questions.\n\nThank you,\n" + me },
      { id: "decline", label: "Withdraw politely", subject: role + " application", body: hi + "\n\nThank you for considering me for the " + role + " position. I've decided to accept another offer, so I'd like to withdraw my application. I appreciate your time and hope our paths cross again.\n\nBest,\n" + me },
    ];
  }

  // ---------- stories & résumé ----------
  const VERB_MAP = [
    [/^(led|lead|leading)\b/i, "Led"],
    [/^(train|trained|training|coach|coached|coaching)\b/i, "Trained"],
    [/^(reduce|reduced|cut|lower|lowered)\b/i, "Reduced"],
    [/^(improve|improved|raise|raised|increase|increased|boost|boosted)\b/i, "Improved"],
    [/^(build|built|create|created|set up|launch|launched|started)\b/i, "Built"],
    [/^(fix|fixed|solve|solved|resolve|resolved)\b/i, "Resolved"],
    [/^(help|helped|assist|assisted)\b/i, "Helped"],
    [/^(handle|handled|manage|managed|ran|run)\b/i, "Managed"],
  ];
  // Template only: the person's own words, and a [placeholder] where something is missing.
  function bulletFromStory(s) {
    let action = clean(s.action) || clean(s.title) || "[what you did]";
    let lead = "";
    for (const [re, verb] of VERB_MAP) {
      if (re.test(action)) {
        lead = verb;
        action = action.replace(re, "").trim();
        break;
      }
    }
    let text = lead ? lead + " " + lower1(action) : cap(action);
    const result = clean(s.result);
    text += result ? ", resulting in " + lower1(result) : ", resulting in [the result — add a number if you have one]";
    return text + ".";
  }
  function storyToStar(s) {
    return { mode: "star", s: clean(s.situation), t: clean(s.task), a: clean(s.action), r: clean(s.result), storyId: s.id };
  }

  // ---------- readiness ----------
  function bankFor(ws, packs) {
    const custom = (ws.interview.custom || []).map((c) => Object.assign({ pack: "mine", tip: "" }, c));
    return BANK.concat(custom).filter((q) => !packs || packs.includes(q.pack));
  }
  function status(ws, qid) {
    const a = ws.interview.answers[qid];
    if (!a) return "none";
    if (a.ready) return "ready";
    return answerText(a) ? "draft" : "none";
  }
  function readiness(ws, qs) {
    const list = qs.filter((q) => q.pack !== "ask");
    const ready = list.filter((q) => status(ws, q.id) === "ready").length;
    const draft = list.filter((q) => status(ws, q.id) === "draft").length;
    return { ready, draft, total: list.length, pct: list.length ? Math.round(((ready + draft * 0.5) / list.length) * 100) : 0 };
  }
  function jobQuestions(ws, job) {
    const packs = ["common", "behavioral"].concat(ws.profile.packs || []);
    const base = BANK.filter((q) => packs.includes(q.pack) && q.pack !== "ask");
    const mine = (ws.interview.custom || []).filter((c) => c.jobId === job.id).map((c) => Object.assign({ pack: "mine", tip: "" }, c));
    const ask = BANK.filter((q) => q.pack === "ask");
    return mine.concat(base, ask);
  }

  // One page to read in the parking lot before you walk in.
  function cheatSheet(ws, job, now) {
    const ans = (id) => answerText(ws.interview.answers[id]);
    const L = [(job.title || "Interview") + " — " + (job.company || ""), job.interviewAt ? fmtWhen(job.interviewAt) : "", ""].filter((x, i) => x || i === 2);
    if (job.contact) L.push("Meeting with: " + job.contact);
    if (job.notes) L.push("Notes: " + clean(job.notes));
    L.push("", "TELL ME ABOUT YOURSELF", ans("c1") || "[Write this one first in Interview]");
    L.push("", "WHY THIS JOB", ans("c2") || "[Why you want this job]");
    const mine = (ws.interview.custom || []).filter((c) => c.jobId === job.id);
    if (mine.length) {
      L.push("", "QUESTIONS FROM THE POSTING");
      for (const c of mine) L.push("- " + c.q + (ans(c.id) ? "\n  " + ans(c.id) : ""));
    }
    const stories = ws.stories.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 4);
    if (stories.length) {
      L.push("", "MY STORIES (have these ready)");
      for (const s of stories) L.push("- " + s.title + (clean(s.result) ? " → " + clean(s.result) : ""));
    }
    const asks = BANK.filter((q) => q.pack === "ask" && (ws.interview.answers[q.id] || {}).pick).map((q) => q.q);
    L.push("", "MY QUESTIONS FOR THEM");
    L.push((asks.length ? asks : BANK.filter((q) => q.pack === "ask").slice(0, 3).map((q) => q.q)).map((q) => "- " + q).join("\n"));
    L.push("", "BRING", "- Copies of your résumé, ID, a pen", "- Arrive 10 minutes early");
    return L.join("\n");
  }

  // ---------- calendar ----------
  function icsEscape(s) {
    return String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  }
  function interviewIcs(job, now) {
    const stamp = (now || new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
    const dt = job.interviewAt;
    const timed = /T\d{2}:\d{2}/.test(dt);
    const start = timed ? dt.replace(/[-:]/g, "").slice(0, 13) + "00" : dt.slice(0, 10).replace(/-/g, "");
    let end;
    if (timed) {
      const d = new Date(dt);
      d.setHours(d.getHours() + 1);
      end = iso(d).replace(/-/g, "") + "T" + pad(d.getHours()) + pad(d.getMinutes()) + "00";
    } else end = addDays(dt.slice(0, 10), 1).replace(/-/g, "");
    const v = timed ? "" : ";VALUE=DATE";
    return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//CareerCrumbs//EN", "BEGIN:VEVENT", "UID:cc-" + job.id + "@careercrumbs", "DTSTAMP:" + stamp, "DTSTART" + v + ":" + start, "DTEND" + v + ":" + end, "SUMMARY:" + icsEscape("Interview: " + job.title + " at " + job.company), "DESCRIPTION:" + icsEscape((job.contact ? "With " + job.contact + ". " : "") + "Bring résumé copies and ID. Send a thank-you within 24 hours."), "BEGIN:VALARM", "TRIGGER:-PT2H", "ACTION:DISPLAY", "DESCRIPTION:Interview in 2 hours", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n") + "\r\n";
  }

  // ---------- workspace ----------
  const emptyWorkspace = () => ({
    profile: { name: "", targetRole: "", packs: [] },
    jobs: [],
    stories: [],
    interview: { answers: {}, custom: [], practice: [] },
    storySeq: 0,
  });
  function normalize(ws) {
    const b = emptyWorkspace();
    const out = Object.assign({}, b, ws || {});
    out.profile = Object.assign({}, b.profile, (ws && ws.profile) || {});
    if (!Array.isArray(out.profile.packs)) out.profile.packs = [];
    out.jobs = (Array.isArray(out.jobs) ? out.jobs : []).map((j) => Object.assign({ status: "Saved", history: [] }, j));
    out.stories = Array.isArray(out.stories) ? out.stories : [];
    const iv = (ws && ws.interview) || {};
    out.interview = {
      answers: iv.answers && typeof iv.answers === "object" && !Array.isArray(iv.answers) ? Object.assign({}, iv.answers) : {},
      custom: Array.isArray(iv.custom) ? iv.custom : [],
      practice: Array.isArray(iv.practice) ? iv.practice : [],
    };
    out.storySeq = Math.max(Number(out.storySeq) || 0, out.stories.reduce((m, s) => Math.max(m, s.n || 0), 0));
    return out;
  }
  function exampleWorkspace(now) {
    const t = today(now);
    const d = (n) => addDays(t, n);
    const ws = emptyWorkspace();
    ws.profile = { name: "", targetRole: "Warehouse associate", packs: ["warehouse", "service"] };
    ws.stories = [
      { id: "s1", n: 1, date: d(-40), title: "Caught a mislabeled pallet before it shipped", situation: "A pallet of frozen goods came in with the wrong label during a rush", task: "Get it put away correctly without slowing the line", action: "Stopped and checked it against the order, then flagged it to my lead and relabelled it", result: "The right product reached the customer and nothing was refunded" },
      { id: "s2", n: 2, date: d(-90), title: "Trained two new hires in my first year", situation: "We had two new people start during the holiday rush", task: "Help them get up to speed fast", action: "Showed them the layout, shadowed their first shifts and made a cheat sheet of bin locations", result: "Both were picking on their own by the end of week one" },
      { id: "s3", n: 3, date: d(-150), title: "Calmed down an upset customer", situation: "A customer's order was missing items and they were angry at the counter", task: "Fix it and keep them as a customer", action: "Listened, apologised, found the missing items and walked them out myself", result: "They thanked me and left a good review mentioning me" },
    ];
    ws.storySeq = 3;
    ws.jobs = [
      { id: "j1", title: "Warehouse associate", company: "Northwind Logistics (example)", status: "Interview", appliedAt: d(-9), interviewAt: d(2) + "T10:00", contact: "Jamie Lee", notes: "Night shift, forklift a plus", link: "", history: [{ status: "Saved", at: d(-10) + "T12:00:00.000Z" }, { status: "Applied", at: d(-9) + "T12:00:00.000Z" }, { status: "Interview", at: d(-3) + "T12:00:00.000Z" }] },
      { id: "j2", title: "Stock associate", company: "Contoso Market (example)", status: "Applied", appliedAt: d(-6), followUpAt: d(0), contact: "", notes: "", link: "", history: [{ status: "Applied", at: d(-6) + "T12:00:00.000Z" }] },
      { id: "j3", title: "Shift lead", company: "Fabrikam Foods (example)", status: "Saved", notes: "Posting closes soon", link: "", history: [{ status: "Saved", at: d(-1) + "T12:00:00.000Z" }] },
    ];
    ws.interview.answers = {
      c1: { mode: "free", text: "I've worked in warehouses for two years, most recently picking and packing grocery orders where I kept a 99% accuracy rate. Before that I worked retail, so I'm used to fast-paced shifts and helping customers. I'm looking for a role with steady hours where I can learn equipment and grow into training others.", ready: true },
      b1: { mode: "star", s: "Two of us kept clashing over who restocked the cooler", t: "Stop it slowing the shift", a: "I asked to talk on break, we split the cooler by aisle and wrote it on the board", r: "No more arguments and restocking got faster", ready: false },
      w1: Object.assign(storyToStar(ws.stories[0]), { ready: true }),
    };
    ws.interview.custom = [{ id: "m1", q: "Are you comfortable working nights and weekends?", jobId: "j1" }];
    return ws;
  }

  const api = {
    uid, iso, today, parse, addDays, daysBetween, fmtDate, fmtDateY, fmtTime, fmtWhen, relDays, clean, firstName,
    PACKS, BANK, WPM, answerText, wordCount, speakTime, lengthHint,
    STATUSES, setStatus, jobBadge, todo, nextInterview, messages,
    bulletFromStory, storyToStar, bankFor, status, readiness, jobQuestions, cheatSheet, interviewIcs,
    emptyWorkspace, normalize, exampleWorkspace,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CC = api;
})(typeof window !== "undefined" ? window : globalThis);
