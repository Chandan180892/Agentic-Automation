/** Drives whole autopilot cycles against a real database and checks that the loop learns. */
import { db } from "../src/lib/db";
import { startCycle, runCycle } from "../src/lib/agents/autopilot";

const results: string[] = [];
let failures = 0;
const check = (n: string, c: boolean, e = "") => {
  if (!c) failures++;
  results.push(`${c ? "PASS" : "FAIL"} ${n}${e ? ` — ${e}` : ""}`);
};

async function workspace() {
  const ws = await db.workspace.create({
    data: { name: "Autopilot E2E", slug: `ap-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` },
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
  for (const k of ["no-fixed-waits", "stable-selectors", "behaviour-per-criterion", "known-defect-pay-806"]) {
    check(`cycle 1 learned ${k}`, keys1.has(k));
  }
  check(
    "lessons are scoped to the agent that could prevent them",
    lessons1.find((l) => l.key === "no-fixed-waits")?.scope === "spec-author" &&
      lessons1.find((l) => l.key === "behaviour-per-criterion")?.scope === "story-analyzer"
  );

  // ---- cycle 2: the same sprint, with what cycle 1 learned ----
  const c2 = await cycle(ws.id, sprint.id);
  check("cycle 2 applies the lessons", c2.out.metrics.lessonsApplied >= 4, `${c2.out.metrics.lessonsApplied}`);
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
    ["no-fixed-waits", "stable-selectors", "behaviour-per-criterion"].every((k) => c2.out.learning?.confirmed.includes(k)),
    c2.out.learning?.confirmed.join(",")
  );
  const before = lessons1.find((l) => l.key === "no-fixed-waits")!.confidence;
  const after = (await db.lesson.findFirstOrThrow({ where: { workspaceId: ws.id, key: "no-fixed-waits" } })).confidence;
  check("a confirmed lesson gains confidence", after > before, `${before} → ${after}`);
  check("the report compares with the previous cycle", /Against cycle 1/.test(c2.out.report?.summary ?? ""));

  // ---- self-correction: a lesson that is applied but does not help loses confidence ----
  const { ws: ws2, sprint: sprint2 } = await workspace();
  // Mis-scoped on purpose: the verifier cannot stop spec-author writing sleeps, so the problem recurs.
  await db.lesson.create({
    data: { workspaceId: ws2.id, key: "no-fixed-waits", scope: "verifier", category: "heal", rule: "Avoid fixed waits.", confidence: 0.5 },
  });
  const c3 = await cycle(ws2.id, sprint2.id);
  const contradicted = await db.lesson.findFirstOrThrow({ where: { workspaceId: ws2.id, key: "no-fixed-waits" } });
  check("an applied lesson whose problem recurs is contradicted", c3.out.learning?.contradicted.includes("no-fixed-waits") ?? false);
  check("a contradicted lesson loses confidence", contradicted.confidence < 0.5, `${contradicted.confidence}`);
  await db.lesson.update({ where: { id: contradicted.id }, data: { confidence: 0.3 } });
  const c4 = await cycle(ws2.id, sprint2.id);
  const retired = await db.lesson.findFirstOrThrow({ where: { workspaceId: ws2.id, key: "no-fixed-waits" } });
  check("a lesson that keeps failing retires", retired.status === "retired" && (c4.out.learning?.retired.includes("no-fixed-waits") ?? false), `${retired.status} ${retired.confidence}`);

  await db.workspace.deleteMany({ where: { id: { in: [ws.id, ws2.id] } } });

  console.log(results.join("\n"));
  console.log(`\n${results.length - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
