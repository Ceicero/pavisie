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
  assert.match(ics, /DTSTART:20261103T100000\r\nDTEND:20261103T110000/);
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
  assert.match(ics, /DTSTART:20261102T090000\r\nDTEND:20261102T091500/);
  assert.match(ics, /TRIGGER:PT0M/);
  const after = CC.reminderEvents([CC.markCheckedIn(jobs[0], "a3")], NOW);
  assert.equal(after.length, 2);
});
