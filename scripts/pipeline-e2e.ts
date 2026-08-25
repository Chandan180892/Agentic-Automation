/** Drives the real orchestrator against the database, exactly as the UI does. */
import { db } from "../src/lib/db";
import { runPipeline } from "../src/lib/agents/pipeline";

const results: string[] = [];
let failures = 0;
const check = (n: string, c: boolean, e = "") => {
  if (!c) failures++;
  results.push(`${c ? "PASS" : "FAIL"} ${n}${e ? ` — ${e}` : ""}`);
};

async function pipelineFor(story: { key: string; title: string; description: string; criteria: string[] }) {
  const ws = await db.workspace.create({
    data: {
      name: "E2E",
      slug: `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      jiraProjectKey: "PAY",
      xrayProjectKey: "PAY",
      bitbucketWorkspace: "acme",
      bitbucketRepo: "payments-web",
    },
  });
  const sprint = await db.sprint.create({
    data: { workspaceId: ws.id, name: "E2E sprint", startsAt: new Date(), endsAt: new Date(Date.now() + 864e5) },
  });
  const row = await db.story.create({
    data: {
      sprintId: sprint.id,
      key: story.key,
      title: story.title,
      description: story.description,
      acceptanceCriteria: JSON.stringify(story.criteria),
    },
  });
  const run = await db.run.create({
    data: { workspaceId: ws.id, sprintId: sprint.id, storyId: row.id, agent: "qe-pipeline", status: "running" },
  });
  await runPipeline({ runId: run.id, storyId: row.id });
  const full = await db.run.findUniqueOrThrow({
    where: { id: run.id },
    include: { stages: { orderBy: { order: "asc" } }, assets: true, testCases: true, publications: true, events: true },
  });
  return { ws, full };
}

async function main() {
  // ---- a well-specified story should reach the reviewer and propose publications ----
  const good = await pipelineFor({
    key: "PAY-812",
    title: "Idempotency keys on checkout submit",
    description: "A double-click on Pay must not create two orders.",
    criteria: [
      "Submitting the same idempotency key twice creates exactly one order.",
      "The second response returns the original order, not an error.",
    ],
  });

  check("all six stages recorded", good.full.stages.length === 6, `${good.full.stages.length}`);
  check("stages ran in order", good.full.stages.map((s) => s.order).join(",") === "1,2,3,4,5,6");
  check("run reached needs_review", good.full.status === "needs_review", good.full.status);
  check("spec files were written", good.full.assets.filter((a) => !a.reused).length > 0);
  check("Xray test cases were produced", good.full.testCases.length > 0, `${good.full.testCases.length}`);
  check("every test case names its criterion", good.full.testCases.every((t) => t.criterion.length > 0));
  check(
    "publications proposed for Xray and Bitbucket",
    good.full.publications.some((p) => p.target === "xray-tests") &&
      good.full.publications.some((p) => p.target === "bitbucket-branch")
  );
  check("nothing was published without approval", good.full.publications.every((p) => p.status === "proposed"));
  check("no test case claims an Xray key yet", good.full.testCases.every((t) => !t.xrayKey && !t.published));
  check("the log names each stage", new Set(good.full.events.map((e) => e.stage)).size >= 5);

  // ---- an unspecified story must stop, not guess ----
  const vagueRun = await pipelineFor({
    key: "PAY-830",
    title: "Make refunds better",
    description: "Refunds should be improved.",
    criteria: [],
  });
  check("an unspecified story blocks the run", vagueRun.full.status === "blocked", vagueRun.full.status);
  check("it produced no spec files", vagueRun.full.assets.length === 0);
  check("it produced no test cases", vagueRun.full.testCases.length === 0);
  check(
    "it proposed no Xray or Bitbucket write",
    !vagueRun.full.publications.some((p) => p.target !== "jira-comment")
  );
  check("the run says why it stopped", (vagueRun.full.error ?? "").length > 10, vagueRun.full.error ?? "");

  await db.workspace.deleteMany({ where: { id: { in: [good.ws.id, vagueRun.ws.id] } } });
  await db.$disconnect();

  console.log(results.join("\n"));
  console.log(`\n${results.length - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);

}

void main();
