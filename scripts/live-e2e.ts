/**
 * The live path — real SDK, real request shapes — against a local fake of the Claude Messages
 * API that answers each sub-agent with schema-valid output built from the story in its prompt.
 *
 * It asserts what makes a live run cheap and right first time:
 * - stages with nothing to reason about make no model call (clarify, asset-resolver);
 * - each stage runs at its effort, light stages on the fast model when one is set;
 * - the system prompt carries a cache breakpoint and cost is recorded per run;
 * - the quality gate fixes what it can for free, and a blocking finding goes back to
 *   spec-author without paying for a verifier call.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const results: string[] = [];
let failures = 0;
const check = (n: string, c: boolean, e = "") => {
  if (!c) failures++;
  results.push(`${c ? "PASS" : "FAIL"} ${n}${e ? ` — ${e}` : ""}`);
};

interface Call {
  tool: string;
  model: string;
  effort?: string;
  cached: boolean;
  prompt: string;
}
const calls: Call[] = [];
let specDrafts = 0;

const CRITERIA = [
  "A full refund returns the whole amount to the card.",
  "A refund above the paid amount is rejected with the remaining amount.",
];
// Every stage's prompt carries the story; the fake answers for the criteria it names.
const criteriaIn = (prompt: string) => CRITERIA.filter((c) => prompt.includes(c));

function answer(tool: string, prompt: string): unknown {
  const criteria = criteriaIn(prompt);
  switch (tool) {
    case "submit_analysis":
      return {
        summary: `${criteria.length} criteria, all testable.`,
        testable: true,
        behaviours: criteria.map((c, i) => ({ name: `Behaviour ${i + 1}`, criterion: c, kind: "happy-path", risk: "high" })),
        ambiguities: [],
        outOfScope: [],
      };
    case "submit_strategy":
      return {
        summary: `${criteria.length} criteria planned.`,
        approach: "API first: the rules are provable below the UI.",
        levels: [{ level: "api", share: 100, why: "Business rules." }],
        criteria: criteria.map((c) => ({
          criterion: c,
          techniques: ["boundary-value", "equivalence-partitioning"],
          level: "api",
          priority: "P1",
          risk: "high",
          automate: true,
          why: "Money is involved.",
          preconditions: ["an order exists"],
          testData: [],
          scenarios: [
            { title: "accepted", kind: "positive", coveredBy: "" },
            { title: "rejected", kind: "negative", coveredBy: "" },
          ],
        })),
        risks: [],
        scopeNotes: [],
        nonFunctional: [],
      };
    case "submit_specs": {
      specDrafts++;
      // First draft makes two classic mistakes: a fixed sleep (the gate fixes it) and a
      // placeholder (blocking — it has to go back to the author).
      const first = specDrafts === 1;
      const tests = criteria
        .map(
          (c, i) => `test("[Positive] criterion ${i + 1}", async ({ request }) => {
  // covers: ${c}
  const res = await request.post("/api/refunds", { data: { orderId: crypto.randomUUID(), amount: 10 } });${first && i === 0 ? "\n  await page.waitForTimeout(500);\n  // TODO: assert the ledger entry" : ""}
  expect(res.status()).toBe(201);
  expect(await res.json()).toMatchObject({ status: "refunded" });
});`
        )
        .join("\n\n");
      return {
        summary: `Wrote ${criteria.length} test(s).`,
        files: [{ path: "tests/live-1.spec.ts", kind: "spec", content: `import { test, expect } from "@playwright/test";\n\n${tests}\n` }],
        testCases: criteria.map((c, i) => ({
          summary: `[Positive] criterion ${i + 1}`,
          testType: "Manual",
          priority: "High",
          criterion: c,
          labels: ["positive"],
          gherkin: "",
          steps: [{ action: "POST /api/refunds", data: "amount 10", expected: "201 and status refunded" }],
        })),
        branchName: "qe/LIVE-1-specs",
      };
    }
    case "submit_verification":
      return {
        summary: "Every criterion covered.",
        passed: true,
        coverage: criteria.map((c) => ({ criterion: c, covered: true, by: ["[Positive]"] })),
        defects: [],
      };
    case "submit_review":
      return {
        summary: "Approved.",
        verdict: "approve",
        rationale: "Covered, no defects.",
        changesRequested: [],
        publishReady: true,
        prTitle: "test(LIVE-1): refund specs",
        prDescription: "Adds API specs for every acceptance criterion of LIVE-1.",
      };
    default:
      return {};
  }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (req.url?.split("?")[0] !== "/v1/messages") {
    res.writeHead(404);
    return res.end("{}");
  }
  const tool = body.tools?.[0]?.name ?? "";
  const prompt = typeof body.messages?.[0]?.content === "string" ? body.messages[0].content : "";
  calls.push({
    tool,
    model: body.model,
    effort: body.output_config?.effort,
    cached: Boolean(body.system?.[0]?.cache_control),
    prompt,
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id: `msg_${calls.length}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "tool_use", id: `toolu_${calls.length}`, name: tool, input: answer(tool, prompt) }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
    })
  );
}

async function main() {
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ANTHROPIC_API_KEY = "sk-ant-fake";
  process.env.ANTHROPIC_MODEL = "claude-sonnet-5";
  process.env.ANTHROPIC_FAST_MODEL = "claude-haiku-4-5";
  process.env.MODEL_MAX_RETRIES = "0";
  delete process.env.BITBUCKET_USERNAME;

  const { db } = await import("../src/lib/db");
  const { runPipeline } = await import("../src/lib/agents/pipeline");
  const { buildStoryReport } = await import("../src/lib/agents/report");
  const { costUsd } = await import("../src/lib/agents/llm");

  try {
    const ws = await db.workspace.create({ data: { name: "Live E2E", slug: `live-e2e-${Date.now()}`, jiraProjectKey: "LIVE" } });
    const sprint = await db.sprint.create({ data: { workspaceId: ws.id, name: "Live", startsAt: new Date(), endsAt: new Date(Date.now() + 864e5) } });
    const story = await db.story.create({
      data: {
        sprintId: sprint.id,
        key: "LIVE-1",
        title: "Refund a paid order",
        description: "Support can refund a paid order in full or in part.",
        acceptanceCriteria: JSON.stringify(CRITERIA),
      },
    });
    const run = await db.run.create({ data: { workspaceId: ws.id, sprintId: sprint.id, storyId: story.id, agent: "qe-pipeline", status: "running" } });
    await runPipeline({ runId: run.id, storyId: story.id });
    const full = await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { assets: true, events: true } });

    const tools = calls.map((c) => c.tool);
    check("the run reaches review", full.status === "needs_review", `${full.status} ${full.error ?? ""}`);
    check("clarify makes no model call when nothing is ambiguous", !tools.includes("submit_questions"));
    check("asset-resolver makes no model call without a repository", !tools.includes("submit_asset_plan"));
    check("a blocking gate finding skips the first verifier call",
      tools.join(",") === "submit_analysis,submit_strategy,submit_specs,submit_specs,submit_verification,submit_review", tools.join(","));
    check("six model calls in total", full.modelCalls === 6, `${full.modelCalls}`);

    const by = (t: string) => calls.find((c) => c.tool === t);
    check("story-analyzer runs on the fast model", by("submit_analysis")?.model === "claude-haiku-4-5");
    check("the fast model gets no effort (Haiku does not take it)", by("submit_analysis")?.effort === undefined);
    check("test-strategist runs at medium effort", by("submit_strategy")?.effort === "medium" && by("submit_strategy")?.model === "claude-sonnet-5");
    check("spec-author runs at high effort", by("submit_specs")?.effort === "high");
    check("verifier runs at medium effort", by("submit_verification")?.effort === "medium");
    check("reviewer runs at high effort", by("submit_review")?.effort === "high");
    check("every call puts a cache breakpoint on the system prompt", calls.every((c) => c.cached));

    const u = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 };
    const expected = (costUsd("claude-haiku-4-5", u) ?? 0) + 5 * (costUsd("claude-sonnet-5", u) ?? 0);
    check("the run's cost is recorded at list prices", Math.abs(full.costMicroUsd / 1e6 - expected) < 1e-5, `$${(full.costMicroUsd / 1e6).toFixed(5)} vs $${expected.toFixed(5)}`);

    const specsPrompt = calls.filter((c) => c.tool === "submit_specs")[1]?.prompt ?? "";
    check("the revision is told about the blocking finding", /No placeholders/.test(specsPrompt), specsPrompt.slice(0, 0));
    const spec = full.assets.find((a) => a.path === "tests/live-1.spec.ts")?.content ?? "";
    check("the stored spec has no sleeps or placeholders", spec.length > 0 && !/waitForTimeout|TODO/.test(spec));
    check("the gate logged its fixes", full.events.some((e) => e.source === "quality-gate" && e.message.startsWith("fixed No fixed sleeps")));

    const report = await buildStoryReport(run.id);
    check("the report carries the quality gate result", report?.quality?.blocking === 0, report?.quality?.summary);
    check("the report carries the cost", (report?.cost.calls ?? 0) === 6 && (report?.cost.usd ?? 0) > 0);

    await db.workspace.delete({ where: { id: ws.id } }).catch(() => {});
  } finally {
    server.close();
    await db.$disconnect();
  }

  console.log(results.join("\n"));
  console.log(`\n${results.length - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
