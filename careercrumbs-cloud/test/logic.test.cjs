const test = require("node:test");
const assert = require("node:assert/strict");
const CC = require("../src/logic.js");
const { exampleWorkspace } = require("./fixture.cjs");

const NOW = new Date(2026, 10, 1, 10); // Sun Nov 1 2026

test("question bank: unique ids, every question has a pack, STAR ones have a tip", () => {
  const ids = CC.BANK.map((q) => q.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const q of CC.BANK) {
    assert.ok(CC.PACKS[q.pack], q.id);
    if (q.star) assert.ok(q.tip.length > 20, q.id);
  }
  assert.ok(CC.BANK.length >= 40);
});

test("speaking time and length hints", () => {
  assert.equal(CC.wordCount("I trained two new hires, fast."), 6);
  assert.equal(CC.speakTime(140), "1:00");
  assert.equal(CC.speakTime(35), "0:15");
  const q = CC.BANK.find((x) => x.id === "c1");
  assert.equal(CC.lengthHint(q, 20), "Short. Add a detail or an example.");
  assert.equal(CC.lengthHint(q, 150), "Good length.");
  assert.equal(CC.lengthHint(q, 400), "Long. Try cutting it to two minutes or less.");
});

test("STAR answers join into readable text; status tracks drafts and ready", () => {
  const ws = CC.normalize({});
  ws.interview.answers.b1 = { mode: "star", s: "Busy night.", t: "", a: "I split the aisles", r: "Done early" };
  assert.equal(CC.answerText(ws.interview.answers.b1), "Busy night. I split the aisles. Done early");
  assert.equal(CC.status(ws, "b1"), "draft");
  ws.interview.answers.b1.ready = true;
  assert.equal(CC.status(ws, "b1"), "ready");
  assert.equal(CC.status(ws, "c1"), "none");
});

test("résumé bullet uses only the person's words", () => {
  assert.equal(CC.bulletFromStory({ action: "trained two new hires on picking.", result: "both picked solo by week one" }), "Trained two new hires on picking, resulting in both picked solo by week one.");
  assert.match(CC.bulletFromStory({ title: "Fixed the label printer" }), /^Resolved the label printer, resulting in \[the result/);
});

test("jobs: status history, badges and today's list", () => {
  const j = CC.setStatus({ id: "j", status: "Saved", history: [] }, "Applied", NOW);
  assert.equal(j.appliedAt, NOW.toISOString().slice(0, 10));
  assert.equal(j.history.length, 1);
  assert.equal(CC.jobBadge({ status: "Applied", followUpAt: "2026-11-05" }, NOW).text, "Follow up in 4 days");
  assert.equal(CC.jobBadge({ status: "Interview", interviewAt: "2026-11-02T10:00" }, NOW).text, "Interview tomorrow 10:00 am");
  const ws = CC.normalize(exampleWorkspace(NOW));
  const list = CC.todo(ws, NOW);
  assert.ok(list.some((x) => x.act === "prep"));
  assert.ok(list.some((x) => /Check in with Contoso/.test(x.title)));
  assert.equal(CC.nextInterview(ws, NOW).id, "j1");
});

test("message templates fill in what's known and bracket the rest", () => {
  const m = CC.messages({ title: "Picker", company: "Acme", contact: "Jamie Lee", appliedAt: "2026-10-20" }, { name: "Brandon" });
  const f = m.find((x) => x.id === "followup");
  assert.match(f.body, /^Hi Jamie,/);
  assert.match(f.body, /Picker position on Oct 20/);
  assert.match(f.body, /Brandon$/);
  assert.match(CC.messages({}, {}).find((x) => x.id === "thanks").body, /\[role\]/);
});

test("job prep: posting questions first, cheat sheet pulls answers and stories", () => {
  const ws = CC.normalize(exampleWorkspace(NOW));
  const qs = CC.jobQuestions(ws, ws.jobs[0]);
  assert.equal(qs[0].id, "m1");
  assert.ok(qs.some((q) => q.pack === "warehouse"));
  assert.ok(!qs.some((q) => q.pack === "lead"));
  const sheet = CC.cheatSheet(ws, ws.jobs[0], NOW);
  assert.match(sheet, /TELL ME ABOUT YOURSELF\nI've worked in warehouses/);
  assert.match(sheet, /QUESTIONS FROM THE POSTING\n- Are you comfortable/);
  assert.match(sheet, /MY STORIES/);
  const r = CC.readiness(ws, CC.bankFor(ws, ["common"]));
  assert.equal(r.ready, 1);
});

test("interview calendar file with a 2-hour reminder", () => {
  const ics = CC.interviewIcs({ id: "j1", title: "Picker", company: "Acme, Inc", interviewAt: "2026-11-03T10:00" }, NOW);
  const utc = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  assert.ok(ics.includes("DTSTART:" + utc(new Date(2026, 10, 3, 10)) + "\r\nDTEND:" + utc(new Date(2026, 10, 3, 11))));
  assert.match(ics, /DTSTART:\d{8}T\d{6}Z/);
  assert.match(ics, /SUMMARY:Interview: Picker at Acme\\, Inc/);
  assert.match(ics, /TRIGGER:-PT2H/);
});

test("normalize tolerates junk and old saves", () => {
  const ws = CC.normalize({ jobs: "x", interview: { answers: [] }, profile: { name: "B" } });
  assert.deepEqual(ws.jobs, []);
  assert.deepEqual(ws.interview.answers, {});
  assert.equal(ws.profile.name, "B");
  assert.deepEqual(ws.profile.packs, []);
});

test("example answers exist only for real bank questions", () => {
  for (const id of Object.keys(CC.EXAMPLES)) assert.ok(CC.BANK.some((q) => q.id === id), id);
  assert.ok(CC.wordCount(CC.EXAMPLES.c1) > 40);
});

test("check-ins: hourly 3 days, 1 week, 1 month; salaried starts at 1 week", () => {
  const hourly = CC.checkIns({ status: "Applied", appliedAt: "2026-11-01" });
  assert.deepEqual(hourly.map((c) => c.date), ["2026-11-04", "2026-11-08", "2026-12-01"]);
  assert.deepEqual(hourly.map((c) => c.label), ["3 days since you applied", "1 week since you applied", "1 month since you applied"]);
  const salaried = CC.checkIns({ status: "Applied", appliedAt: "2026-11-01", pay: "salaried" });
  assert.deepEqual(salaried.map((c) => c.date), ["2026-11-08", "2026-12-01"]);
  assert.deepEqual(CC.checkIns({ status: "Saved", appliedAt: "2026-11-01" }), []);
  assert.deepEqual(CC.checkIns({ status: "Offer", appliedAt: "2026-11-01" }), []);
});

test("check-ins: an interview takes over from the application schedule", () => {
  const job = { status: "Interview", appliedAt: "2026-10-20", interviewAt: "2026-10-26T10:00" };
  assert.deepEqual(CC.checkIns(job).map((c) => c.key), ["a3", "i3", "i7", "i30"]);
  const due = CC.dueCheckIn(job, NOW);
  assert.equal(due.key, "i3");
  assert.equal(due.message, "status");
  const done = CC.markCheckedIn(job, "i3");
  assert.deepEqual(Object.keys(done.checkins).sort(), ["a3", "i3"]);
  assert.equal(CC.dueCheckIn(done, NOW), null);
  assert.equal(CC.nextCheckIn(done, NOW).key, "i7");
  assert.equal(CC.jobBadge(done, NOW).text, "Next check-in tomorrow");
  assert.equal(CC.jobBadge(job, NOW).text, "Check in now · 3 days since your interview");
});

test("reminder calendar: 9am alerts with stable ids, past and done ones skipped", () => {
  const jobs = [{ id: "j1", title: "Picker", company: "Acme", status: "Applied", appliedAt: "2026-10-30" }];
  const ev = CC.reminderEvents(jobs, NOW);
  assert.deepEqual(ev.map((e) => e.date), ["2026-11-02", "2026-11-06", "2026-11-29"]);
  const ics = CC.remindersIcs(jobs, NOW);
  assert.match(ics, /UID:cc-j1-a3@careercrumbs/);
  const utc = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  assert.ok(ics.includes("DTSTART:" + utc(new Date(2026, 10, 2, 9)) + "\r\nDTEND:" + utc(new Date(2026, 10, 2, 9, 15))));
  assert.match(ics, /TRIGGER:PT0M/);
  const after = CC.reminderEvents([CC.markCheckedIn(jobs[0], "a3")], NOW);
  assert.equal(after.length, 2);
});

test("review: imported ids that could inject HTML are replaced, references follow", () => {
  const evil = 'x" onfocus="window.__pwn=1" autofocus x="';
  const ws = CC.normalize({
    jobs: [{ id: evil, title: "a", company: "b", interviewAt: 12345, appliedAt: "nope", status: "Hacked", link: "javascript:alert(1)" }],
    stories: [{ id: "s<1>", title: "t" }],
    interview: { custom: [{ id: "bad id!", q: "Q?", jobId: evil }], answers: { "bad id!": { text: "hi", storyId: "s<1>" }, '"><img>': { text: "x" } }, practice: [{ q: "bad id!", date: "2026-11-01", ok: true }, "junk"] },
  });
  const j = ws.jobs[0];
  assert.match(j.id, /^[\w-]+$/);
  assert.equal(j.interviewAt, "");
  assert.equal(j.appliedAt, "");
  assert.equal(j.status, "Saved");
  assert.equal(j.link, "");
  assert.match(ws.stories[0].id, /^[\w-]+$/);
  const q = ws.interview.custom[0];
  assert.match(q.id, /^[\w-]+$/);
  assert.equal(q.jobId, j.id);
  assert.equal(ws.interview.answers[q.id].text, "hi");
  assert.equal(ws.interview.answers[q.id].storyId, ws.stories[0].id);
  assert.equal(Object.keys(ws.interview.answers).length, 1);
  assert.equal(ws.interview.practice[0].q, q.id);
  // Nothing in the app should throw on what came out.
  assert.doesNotThrow(() => { CC.todo(ws); CC.nextInterview(ws); CC.jobBadge(j); CC.jobOrder(ws.jobs); CC.reminderEvents(ws.jobs); });
});

test("review: backups must look like CareerCrumbs and have something in them", () => {
  assert.equal(CC.checkBackup({ hello: 1 }).ok, false);
  assert.equal(CC.checkBackup("text").ok, false);
  assert.match(CC.checkBackup({ app: "CareerCrumbs", jobs: [] }).reason, /empty/);
  const ok = CC.checkBackup({ app: "CareerCrumbs", jobs: [{ title: "Picker", company: "Acme" }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.counts.jobs, 1);
});

test("review: applied date is the local date; overdue follow-ups get a badge", () => {
  const evening = new Date(2026, 10, 1, 21, 30);
  assert.equal(CC.setStatus({ status: "Saved", history: [] }, "Applied", evening).appliedAt, "2026-11-01");
  assert.equal(CC.jobBadge({ status: "Saved", followUpAt: "2026-10-30" }, NOW).text, "Follow-up overdue by 2 days");
});

test("review: résumé line grammar with a past-tense result", () => {
  assert.equal(CC.bulletFromStory({ action: "checked labels", result: "saved 2 hours" }), "Checked labels; saved 2 hours.");
  assert.equal(CC.bulletFromStory({ action: "checked labels", result: "fewer refunds" }), "Checked labels, resulting in fewer refunds.");
});

test("review: long calendar lines are folded at 75 octets", () => {
  const ics = CC.interviewIcs({ id: "j1", title: "Warehouse associate on the overnight inventory and receiving team", company: "Northwind Logistics Distribution Centre", interviewAt: "2026-11-03T10:00" }, NOW);
  for (const line of ics.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);
  assert.match(ics, /\r\n /);
});

test("review: job order puts upcoming interviews first and closed last", () => {
  const jobs = [
    { id: "a", status: "Closed", appliedAt: "2026-10-01" },
    { id: "b", status: "Applied", appliedAt: "2026-10-31" },
    { id: "c", status: "Interview", interviewAt: "2026-11-05T09:00" },
    { id: "d", status: "Interview", interviewAt: "2026-10-20T09:00" },
    { id: "e", status: "Interview", interviewAt: "2026-11-02T09:00" },
  ];
  assert.deepEqual(CC.jobOrder(jobs, NOW).map((j) => j.id), ["e", "c", "d", "b", "a"]);
});

test("review: shuffle keeps every item", () => {
  const a = [1, 2, 3, 4, 5];
  assert.deepEqual(CC.shuffle(a).sort(), a);
  assert.deepEqual(a, [1, 2, 3, 4, 5]);
});

test("review: first-run screen only for a truly empty workspace", () => {
  const ws = CC.normalize({});
  assert.equal(CC.isFresh(ws), true);
  ws.interview.practice.push({ q: "c1", date: "2026-11-01", ok: true });
  assert.equal(CC.isFresh(ws), false);
});
