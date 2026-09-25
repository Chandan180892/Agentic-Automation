/** Drives whole autopilot cycles against a real database and checks that the loop learns. */
import { db } from "../src/lib/db";
import { startCycle, runCycle, runCampaign } from "../src/lib/agents/autopilot";

const results: string[] = [];
let failures = 0;
const check = (n: string, c: boolean, e = "") => {
  if (!c) failures++;
  results.push(`${c ? "PASS" : "FAIL"} ${n}${e ? ` — ${e}` : ""}`);
};

async function workspace(lessonApproval = "auto") {
  const ws = await db.workspace.create({
    data: {
      name: "Autopilot E2E",
      slug: `ap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      jiraProjectKey: "PAY",
      lessonApproval,
    },
  });
  const sprint = await db.sprint.create({
    data: {
      workspaceId: ws.id,
      name: "Autopilot sprint",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 864e5),
      capacityPoints: 34,
      stories: {
        create: [
          {
            key: "PAY-812",
            title: "Idempotency keys on checkout submit",
            acceptanceCriteria: JSON.stringify([
              "Submitting the same idempotency key twice creates exactly one order.",
              "The second response returns the original order, not an error.",
              "A key expires after 24 hours and is then reusable.",
              "A request without an idempotency key is rejected with a 400 naming the missing header.",
            ]),
            points: 5,
            priority: 0,
          },
          {
            key: "PAY-806",
            title: "Retry a failed card authorisation once",
            acceptanceCriteria: JSON.stringify([
              "A 5xx from the gateway is retried exactly once.",
              "A hard decline is surfaced immediately with the decline reason.",
            ]),
            points: 3,
            priority: 1,
          },
        ],
      },
    },
  });
  return { ws, sprint };
}

async function cycle(workspaceId: string, sprintId: string) {
  const run = await startCycle({ workspaceId, sprintId });
  const out = await runCycle({ runId: run.id, paceMs: 0 });
  return { run, out };
}

async function main() {
  const { ws, sprint } = await workspace();

  // ---- cycle 1: the baseline, with nothing learned yet ----
  const c1 = await cycle(ws.id, sprint.id);
  check("cycle 1 applies no lessons", c1.out.metrics.lessonsApplied === 0);
  check("cycle 1 executes the generated tests", c1.out.metrics.testsRun > 0, `${c1.out.metrics.testsRun} tests`);
  check("cycle 1 heals test drift", c1.out.metrics.healed > 0, `${c1.out.metrics.healed} healed`);
  check("cycle 1 needs a verifier revision", c1.out.metrics.revisions > 0);

  const children = await db.run.findMany({ where: { parentId: c1.run.id } });
  const agents = new Set(children.map((c) => c.agent));
  for (const a of ["sprint-planner", "qe-pipeline", "qe-auto-heal", "requirements-reviewer", "cycle-reporter", "learner"]) {
    check(`cycle 1 ran ${a} as a child run`, agents.has(a));
  }
  const stages = await db.stage.findMany({ where: { runId: c1.run.id }, orderBy: { order: "asc" } });
  check("all eight phases finished", stages.length === 8 && stages.every((s) => s.status === "passed" || s.status === "blocked"), stages.map((s) => `${s.agent}:${s.status}`).join(" "));

  // Healing must change selectors and waits, never an assertion.
  const healedSpecs = await db.asset.findMany({ where: { runId: { in: children.map((c) => c.id) }, kind: "spec" } });
  check("healed specs no longer sleep", healedSpecs.every((s) => !s.content.includes("waitForTimeout")));
  check("healed specs no longer select by styling class", healedSpecs.every((s) => !s.content.includes(".btn-primary")));
  check(
    "every assertion survived healing",
    healedSpecs.every((s) => (s.content.match(/await expect\(/g) ?? []).length === (s.content.match(/\btest\(/g) ?? []).length)
  );

  // The retry defect is the application's fault: it stays red and is escalated, not patched.
  const retry = c1.out.review?.criteria.find((c) => c.criterion.startsWith("A 5xx from the gateway"));
  check("the application defect is reported as not met", retry?.status === "not-met", retry?.status);
  check("a known defect means the sprint is not accepted", c1.out.review?.verdict === "reject", c1.out.review?.verdict);
  check(
    "no heal patched the defect",
    // A test can drift first (selector, patched) and then reach the defect (app-bug, never patched).
    c1.out.tests
      .filter((t) => t.cause === "app-bug")
      .every((t) => t.final === "failed" && t.heals.at(-1)?.category === "app-bug" && t.heals.every((h) => h.category !== "app-bug" || !h.patched))
  );
  check("the report leads with the verdict", /criteria met/.test(c1.out.report?.headline ?? ""), c1.out.report?.headline);

  const lessons1 = await db.lesson.findMany({ where: { workspaceId: ws.id } });
  const keys1 = new Set(lessons1.map((l) => l.key));
  for (const k of ["stable-selectors", "behaviour-per-criterion", "known-defect-pay-806"]) {
    check(`cycle 1 learned ${k}`, keys1.has(k));
  }
  // Fixed sleeps never reach execution: the pipeline's quality gate removes them for free, so
  // there is nothing to heal and nothing to learn.
  const drafted = await db.asset.findMany({ where: { runId: { in: children.filter((c) => c.agent === "qe-pipeline").map((c) => c.id) }, kind: "spec" } });
  check("the quality gate removed every fixed sleep before execution", drafted.length > 0 && drafted.every((s) => !s.content.includes("waitForTimeout")));
  check("so no lesson about sleeps is needed", !keys1.has("no-fixed-waits"));
  check(
    "lessons are scoped to the agent that could prevent them",
    lessons1.find((l) => l.key === "stable-selectors")?.scope === "spec-author" &&
      lessons1.find((l) => l.key === "behaviour-per-criterion")?.scope === "story-analyzer"
  );

  // ---- cycle 2: the same sprint, with what cycle 1 learned ----
  const c2 = await cycle(ws.id, sprint.id);
  check("cycle 2 applies the lessons", c2.out.metrics.lessonsApplied >= 3, `${c2.out.metrics.lessonsApplied}`);
  check(
    "first-run pass rate improves",
    c2.out.metrics.firstRunPassRate > c1.out.metrics.firstRunPassRate,
    `${c1.out.metrics.firstRunPassRate.toFixed(2)} → ${c2.out.metrics.firstRunPassRate.toFixed(2)}`
  );
  check("nothing needs healing any more", c2.out.metrics.healed === 0, `${c2.out.metrics.healed}`);
  check("no verifier revision is needed", c2.out.metrics.revisions === 0, `${c2.out.metrics.revisions}`);
  check("the defect is still reported — learning does not hide bugs", c2.out.metrics.appBugs > 0);
  check(
    "applied lessons that held are confirmed",
    ["stable-selectors", "behaviour-per-criterion"].every((k) => c2.out.learning?.confirmed.includes(k)),
    c2.out.learning?.confirmed.join(",")
  );
  const before = lessons1.find((l) => l.key === "stable-selectors")!.confidence;
  const after = (await db.lesson.findFirstOrThrow({ where: { workspaceId: ws.id, key: "stable-selectors" } })).confidence;
  check("a confirmed lesson gains confidence", after > before, `${before} → ${after}`);
  check("the report compares with the previous cycle", /Against cycle 1/.test(c2.out.report?.summary ?? ""));

  // ---- self-correction: a lesson that is applied but does not help loses confidence ----
  const { ws: ws2, sprint: sprint2 } = await workspace();
  // Mis-scoped on purpose: the verifier cannot stop spec-author choosing styling selectors, so the problem recurs.
  await db.lesson.create({
    data: { workspaceId: ws2.id, key: "stable-selectors", scope: "verifier", category: "heal", rule: "Avoid styling selectors.", confidence: 0.5 },
  });
  const c3 = await cycle(ws2.id, sprint2.id);
  const contradicted = await db.lesson.findFirstOrThrow({ where: { workspaceId: ws2.id, key: "stable-selectors" } });
  check("an applied lesson whose problem recurs is contradicted", c3.out.learning?.contradicted.includes("stable-selectors") ?? false);
  check("a contradicted lesson loses confidence", contradicted.confidence < 0.5, `${contradicted.confidence}`);
  await db.lesson.update({ where: { id: contradicted.id }, data: { confidence: 0.3 } });
  const c4 = await cycle(ws2.id, sprint2.id);
  const retired = await db.lesson.findFirstOrThrow({ where: { workspaceId: ws2.id, key: "stable-selectors" } });
  check("a lesson that keeps failing retires", retired.status === "retired" && (c4.out.learning?.retired.includes("stable-selectors") ?? false), `${retired.status} ${retired.confidence}`);

  // ---- lesson history ----
  const history = await db.lessonEvent.findMany({ where: { lesson: { workspaceId: ws.id } } });
  check("every new lesson records how it was learned", history.filter((e) => e.kind === "created").length >= 3);
  check("confirmations are recorded in the lesson's history", history.some((e) => e.kind === "confirmed"));

  // ---- defects become Jira bug proposals, once ----
  const bug1 = c1.out.bugs.find((b) => b.storyKey === "PAY-806");
  check("an application defect is proposed as a Jira bug", bug1?.status === "proposed", bug1?.status);
  const pub = bug1 ? await db.publication.findUnique({ where: { id: bug1.publicationId } }) : null;
  check("the bug proposal waits for approval", pub?.target === "jira-bug" && pub.status === "proposed");
  check("the bug names the criterion and keeps the test as written", /not met/.test(pub?.payloadJson ?? "") && /test was not changed/.test(pub?.payloadJson ?? ""));
  const bug2 = c2.out.bugs.find((b) => b.storyKey === "PAY-806");
  check("the same defect is not proposed twice", bug2?.status === "pending" && bug2.publicationId === bug1?.publicationId, bug2?.status);
  check(
    "no duplicate bug proposals exist",
    (await db.publication.count({ where: { target: "jira-bug", run: { workspaceId: ws.id } } })) === c1.out.bugs.length
  );

  // ---- stability ----
  check("the baseline cycle is not stable", c1.out.stable === false);
  check("a cycle that learns nothing new is stable", c2.out.stable === true);

  // ---- run until stable ----
  const { ws: ws3, sprint: sprint3 } = await workspace();
  const campaign = { id: `c-e2e-${Date.now()}`, index: 1, max: 5 };
  const first = await startCycle({ workspaceId: ws3.id, sprintId: sprint3.id, campaign });
  const ran = await runCampaign({ firstRunId: first.id, workspaceId: ws3.id, sprintId: sprint3.id, campaign, paceMs: 0 });
  check("run-until-stable stops once nothing new is learned", ran.reason === "stable", ran.reason);
  check("run-until-stable took two cycles", ran.cycles.length === 2, `${ran.cycles.length}`);

  // ---- a person approves lessons before they are used ----
  const { ws: ws4, sprint: sprint4 } = await workspace("review");
  const reviewCampaign = { id: `c-e2e-r-${Date.now()}`, index: 1, max: 5 };
  const r1 = await startCycle({ workspaceId: ws4.id, sprintId: sprint4.id, campaign: reviewCampaign });
  const reviewed = await runCampaign({ firstRunId: r1.id, workspaceId: ws4.id, sprintId: sprint4.id, campaign: reviewCampaign, paceMs: 0 });
  const pending = await db.lesson.findMany({ where: { workspaceId: ws4.id } });
  check("in review mode new lessons wait as proposed", pending.length >= 3 && pending.every((l) => l.status === "proposed"));
  check("the run stops when only approval would help", reviewed.reason === "awaiting-approval", reviewed.reason);
  const second = await db.run.findUniqueOrThrow({ where: { id: reviewed.cycles[1] } });
  check("a proposed lesson is never applied", JSON.parse(second.outputJson ?? "{}").metrics?.lessonsApplied === 0);

  const reject = pending.find((l) => l.key === "stable-selectors")!;
  await db.lesson.updateMany({ where: { workspaceId: ws4.id, key: { not: reject.key } }, data: { status: "active" } });
  await db.lesson.update({ where: { id: reject.id }, data: { status: "rejected" } });
  const r3 = await cycle(ws4.id, sprint4.id);
  check("approved lessons are applied", r3.out.metrics.lessonsApplied >= 2, `${r3.out.metrics.lessonsApplied}`);
  const stillRejected = await db.lesson.findUniqueOrThrow({ where: { id: reject.id } });
  check("a rejected lesson stays rejected when its evidence recurs", stillRejected.status === "rejected" && stillRejected.hits > reject.hits);
  check("the problem a rejected lesson would have fixed still needs healing", r3.out.metrics.healed > 0);

  await db.workspace.deleteMany({ where: { id: { in: [ws.id, ws2.id, ws3.id, ws4.id] } } });

  console.log(results.join("\n"));
  console.log(`\n${results.length - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
