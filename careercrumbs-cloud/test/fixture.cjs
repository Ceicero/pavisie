// Example workspace for tests: realistic jobs, answers and stories.
const CC = require("../src/logic.js");
const { today, addDays, emptyWorkspace, storyToStar } = CC;
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

module.exports = { exampleWorkspace };
