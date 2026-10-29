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
