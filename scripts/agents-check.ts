/**
 * Exercises every agent through the real runtime. With no ANTHROPIC_API_KEY this checks the
 * simulator path and the schema contracts; with a key set it makes real model calls, so the
 * same script doubles as a live smoke test after deployment.
 */
import { invokeAgent, agentsAreLive } from "../src/lib/agents/runtime";
import { AGENT_LIST } from "../src/lib/agents/registry";
import { SUB_AGENT_LIST } from "../src/lib/agents/pipeline-registry";

const results: string[] = [];
let failures = 0;

function check(name: string, cond: boolean, extra = "") {
  if (!cond) failures++;
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
}

const STORY = {
  key: "PAY-812",
  title: "Idempotency keys on checkout submit",
  description: "A double-click on Pay must not create two orders.",
  acceptanceCriteria: ["Submitting the same key twice creates exactly one order."],
  points: 5,
};

async function main() {
  console.log(`mode: ${agentsAreLive() ? "LIVE (calling the model)" : "SIMULATED (no API key)"}\n`);
  check("registry exposes the five top-level agents", AGENT_LIST.length === 5, `${AGENT_LIST.length}`);
  check("pipeline exposes six sub-agents", SUB_AGENT_LIST.length === 6, `${SUB_AGENT_LIST.length}`);

  // sprint-planner
  const plan = await invokeAgent<{ commitment: unknown[]; totalPoints: number; draftedAcceptanceCriteria: unknown[] }>(
    "sprint-planner",
    {
      sprintName: "Sprint 24",
      capacityPoints: 10,
      recentVelocity: [9, 11, 10],
      stories: [STORY, { key: "PAY-830", title: "Partial refunds", description: "", acceptanceCriteria: [], points: 8 }],
    }
  );
  check("sprint-planner returns a commitment", plan.output.commitment.length === 2);
  check("sprint-planner respects capacity", plan.output.totalPoints <= 10, `${plan.output.totalPoints}`);
  check(
    "sprint-planner drafts missing acceptance criteria",
    plan.output.draftedAcceptanceCriteria.length >= 1
  );

  // qe-auto-heal — a selector failure is safe to patch
  const healSelector = await invokeAgent<{ shouldPatch: boolean; category: string }>("qe-auto-heal", {
    specPath: "tests/checkout.spec.ts",
    specContent: "await page.click('[data-test=submit]');",
    failureOutput: "locator '[data-test=submit]' resolved to 0 elements",
    recentDiff: "- data-test=submit\n+ data-test=checkout-submit",
  });
  check("qe-auto-heal patches a selector drift", healSelector.output.shouldPatch === true, healSelector.output.category);

  // qe-auto-heal — a correct assertion must NOT be rewritten
  const healBug = await invokeAgent<{ shouldPatch: boolean; category: string }>("qe-auto-heal", {
    specPath: "tests/checkout.spec.ts",
    specContent: "expect(orderCount).toBe(1); // idempotent",
    failureOutput: "AssertionError: expected 1 order, received 2 orders",
    recentDiff: "",
  });
  check(
    "qe-auto-heal refuses to rewrite a correct assertion",
    healBug.output.shouldPatch === false,
    `category=${healBug.output.category}`
  );

  // batch-heal
  const bh = await invokeAgent<{ groups: unknown[]; escalations: unknown[]; prTitle: string }>("batch-heal", {
    failures: [
      { specPath: "a.spec.ts", failureOutput: "locator not found", specContent: "" },
      { specPath: "b.spec.ts", failureOutput: "locator not found", specContent: "" },
      { specPath: "c.spec.ts", failureOutput: "AssertionError: expected 1, got 2", specContent: "" },
    ],
    recentDiff: "",
  });
  check("batch-heal groups a shared root cause", bh.output.groups.length >= 1);
  check("batch-heal escalates the assertion failure", bh.output.escalations.length >= 1);
  check("batch-heal names the PR", bh.output.prTitle.length > 5);

  // qe-insights
  const ins = await invokeAgent<{ flakes: unknown[]; recommendation: string }>("qe-insights", {
    window: "last 30 runs",
    runs: [
      { specPath: "flaky.spec.ts", status: "passed", durationMs: 900, storyKey: "PAY-799" },
      { specPath: "flaky.spec.ts", status: "failed", durationMs: 900, storyKey: "PAY-799" },
      { specPath: "solid.spec.ts", status: "passed", durationMs: 300, storyKey: "PAY-812" },
    ],
  });
  check("qe-insights spots the flaky spec", ins.output.flakes.length === 1);
  check("qe-insights makes a recommendation", ins.output.recommendation.length > 10);

  // input validation is enforced
  let rejected = false;
  try {
    await invokeAgent("sprint-planner", { sprintName: "x" });
  } catch {
    rejected = true;
  }
  check("bad input is rejected before reaching the model", rejected);

  console.log(results.join("\n"));
  console.log(`\n${results.length - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

void main();
