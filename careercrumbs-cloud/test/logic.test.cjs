const test = require("node:test");
const assert = require("node:assert/strict");
const CC = require("../src/logic.js");

const NOW = new Date(2026, 9, 29, 10); // Thu Oct 29 2026

test("dates: weekOf returns the Monday", () => {
  assert.equal(CC.weekOf("2026-10-29"), "2026-10-26");
  assert.equal(CC.weekOf("2026-10-26"), "2026-10-26");
  assert.equal(CC.weekOf("2026-11-01"), "2026-10-26"); // Sunday belongs to the week before
  assert.equal(CC.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(CC.daysBetween("2026-10-29", "2026-11-05"), 7);
});

test("bullet uses the person's numbers and never invents one", () => {
  const b = CC.bulletFromWin({
    action: "reorganized frozen slotting by velocity.",
    result: "fewer refunds",
    metric: { label: "frozen INF rate", before: "4.1", after: "2.3", unit: "%" },
  });
  assert.equal(b, "Redesigned frozen slotting by velocity, moving frozen INF rate from 4.1% to 2.3% (-1.8 pts); fewer refunds.");
  const plain = CC.bulletFromWin({ action: "Trained two packers on receiving" });
  assert.match(plain, /^Trained two packers on receiving, resulting in \[result/);
  assert.doesNotMatch(plain, /\d/);
  assert.match(CC.bulletFromWin({}), /\[what you did\]/);
});

test("metric phrase: relative change for counts, points for percentages", () => {
  assert.equal(CC.metricPhrase({ label: "UPH", before: "80", after: "96", unit: "" }), "UPH from 80 to 96 (+20%)");
  assert.equal(CC.metricPhrase({ label: "x", before: "", after: "3" }), "");
});

test("readiness caps over-target ratings and lists gaps", () => {
  const ws = CC.emptyWorkspace();
  ws.competencies = [
    { id: "a", name: "A", rating: 4, target: 3 },
    { id: "b", name: "B", rating: 1, target: 3 },
  ];
  ws.wins = [{ id: "w", competencies: ["a"] }];
  const r = CC.readiness(ws);
  assert.equal(r.pct, 67);
  assert.equal(r.atTarget, 1);
  assert.equal(r.evidenced, 1);
  assert.equal(r.gaps[0].c.id, "b");
});

test("kpi status respects lower-is-better", () => {
  const k = { better: "lower", target: 2.5, entries: [{ week: "2026-10-19", value: 2.8 }, { week: "2026-10-26", value: 2.4 }] };
  const s = CC.kpiStatus(k);
  assert.equal(s.state, "on");
  assert.equal(s.trend, 1);
  const series = CC.kpiSeries(k, 3, NOW);
  assert.deepEqual(series.map((p) => p.value), [null, 2.8, 2.4]);
  const sp = CC.sparkPoints(series, 100, 30, 3, 2.5);
  assert.equal(sp.segments.length, 1);
  assert.equal(sp.segments[0].length, 2);
});

test("job status history and follow-up badge", () => {
  const j = CC.setJobStatus({ id: "j", status: "Saved", history: [] }, "Applied", NOW);
  assert.equal(j.history.length, 1);
  assert.equal(j.appliedAt, NOW.toISOString().slice(0, 10));
  assert.equal(CC.followUpBadge({ followUpAt: "2026-10-27", status: "Applied" }, NOW).tone, "bad");
  assert.equal(CC.followUpBadge({ followUpAt: "2026-10-29", status: "Applied" }, NOW).text, "Follow up today");
  assert.equal(CC.followUpBadge({ followUpAt: "2026-10-27", status: "Closed" }, NOW), null);
});

test("touchpoint cadence", () => {
  assert.equal(CC.touchDue({ cadenceDays: 7, touches: [{ date: "2026-10-20" }] }, NOW).label, "Overdue by 2 days");
  assert.equal(CC.touchDue({ cadenceDays: 7, touches: [{ date: "2026-10-27" }] }, NOW).due, false);
});

test("coverage counts certified and trainer levels only", () => {
  const ws = CC.emptyWorkspace();
  ws.stations = ["Pick", "Pack"];
  ws.team = [{ training: { Pick: 2, Pack: 1 } }, { training: { Pick: 3 } }];
  assert.deepEqual(CC.coverage(ws), { Pick: 2, Pack: 0 });
});

test("example workspace normalizes and drives every document template", () => {
  const ws = CC.normalize(CC.exampleWorkspace(NOW));
  assert.ok(CC.agenda(ws, NOW).length > 0);
  assert.match(CC.weeklyUpdate(ws, NOW), /WINS\n- Cut INF misses/);
  assert.match(CC.promotionCase(ws), /EVIDENCE BY COMPETENCY/);
  assert.match(CC.oneOnOneAgenda(ws.team[0], ws, NOW), /Goal: Become a shift lead/);
  assert.match(CC.bragDoc(ws, "2026-01-01", "2026-12-31"), /## Cut INF misses/);
  assert.equal(CC.winsByWeek(ws, 8, NOW).length, 8);
});

test("normalize tolerates junk and old saves", () => {
  const ws = CC.normalize({ wins: "nope", profile: { name: "B" }, kpis: [{ id: "k", name: "x" }] });
  assert.deepEqual(ws.wins, []);
  assert.equal(ws.profile.name, "B");
  assert.equal(ws.profile.targetRole, "Operations Manager");
  assert.deepEqual(ws.kpis[0].entries, []);
  assert.equal(ws.competencies.length, 10);
});

test("labor plan and what-if use only the inputs given", () => {
  const p = CC.laborPlan({ orders: 400, unitsPerOrder: 10, uph: 100, shiftHours: 8, overhead: 25, wage: 20, newUph: 125, daysPerWeek: 7 });
  assert.equal(p.units, 4000);
  assert.equal(p.pickHours, 40);
  assert.equal(p.totalHours, 50);
  assert.equal(p.headcount, 7);
  assert.equal(p.cost, 1000);
  assert.equal(p.whatIf.hoursSavedPerDay, 10);
  assert.equal(p.whatIf.dollarsPerYear, 10 * 7 * 52 * 20);
  assert.equal(CC.laborPlan({ orders: 1 }), null);
  const i = CC.impactCalc({ minutesPerOrder: 0.5, ordersPerDay: 400, daysPerWeek: 7, wage: 20 });
  assert.ok(Math.abs(i.hoursWeek - 23.333) < 0.01);
});

test("kpi paste accepts common spreadsheet formats", () => {
  const r = CC.parseKpiPaste("2026-10-26, 94\n10/19/2026\t91.5\nOct 12 2026  90%\nnonsense");
  assert.deepEqual(r.entries.map((e) => e.week), ["2026-10-12", "2026-10-19", "2026-10-26"]);
  assert.deepEqual(r.entries.map((e) => e.value), [90, 91.5, 94]);
  assert.equal(r.bad, 1);
});

test("ics export is valid all-day events with escaping", () => {
  const ics = CC.buildIcs([{ date: "2026-10-30", title: "1:1 with Sam, PM", desc: "line1\nline2", key: "t2" }], NOW);
  assert.match(ics, /BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261030\r\nDTEND;VALUE=DATE:20261031/);
  assert.match(ics, /SUMMARY:1:1 with Sam\\, PM/);
  assert.match(ics, /DESCRIPTION:line1\\nline2/);
});

test("interview stories, search, insights and v2 templates", () => {
  const ws = CC.normalize(CC.exampleWorkspace(NOW));
  const q1 = CC.INTERVIEW_QS[0];
  assert.equal(CC.suggestStories(ws, q1)[0].id, "w1");
  assert.equal(CC.interviewReadiness(ws).ready, 3);
  assert.match(CC.starAnswer(ws.wins[0]), /RESULT: Fewer refunds/);
  assert.ok(CC.searchAll(ws, "frozen").length >= 3);
  assert.deepEqual(CC.searchAll(ws, "f"), []);
  assert.match(CC.huddleText(ws, "2026-10-29", "AM"), /SAFETY: .+\n- /);
  assert.match(CC.handoffText(ws.shifts[0]), /orders\/labor hr/);
  assert.match(CC.a3Text(ws.problems[0]), /Why 5: Slotting/);
  assert.match(CC.quarterlyReview(ws, NOW), /TOP WINS/);
  assert.equal(CC.kpiHitRate(ws.kpis[0]).total, 8);
  assert.equal(CC.evidenceByMonth(ws, 6, NOW).keys.length, 6);
  assert.ok(CC.upcomingReminders(ws, 30, NOW).length > 0);
  assert.equal(CC.recognitionGaps(ws, 30, NOW).length, 2);
  assert.ok(CC.coachSummary(ws, NOW).competencies.length === 10);
});

test("normalize fills v2 areas on an old save", () => {
  const ws = CC.normalize({ wins: [] });
  assert.deepEqual(ws.interview, { stories: {}, practice: [] });
  assert.deepEqual(ws.shifts, []);
  assert.deepEqual(ws.toolInputs, {});
});
