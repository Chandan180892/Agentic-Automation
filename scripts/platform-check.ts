/**
 * The production machinery: the job queue and worker, crash recovery, the one-at-a-time
 * guarantees, retention, environment validation and the model client's compatibility rules.
 */
import { db } from "../src/lib/db";
import { enqueue, claim, finish, sweep, prune, JobConflict } from "../src/lib/jobs/queue";
import { startWorker } from "../src/lib/jobs/worker";
import { env, resetEnvForTests, checkProductionEnv } from "../src/lib/env";
import { supportsForcedTool } from "../src/lib/agents/llm";
import { startCycle } from "../src/lib/agents/autopilot";

const results: string[] = [];
let failures = 0;
const check = (n: string, c: boolean, e = "") => {
  if (!c) failures++;
  results.push(`${c ? "PASS" : "FAIL"} ${n}${e ? ` — ${e}` : ""}`);
};

async function waitFor(fn: () => Promise<boolean>, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function main() {
  process.env.AUTOPILOT_PACE_MS = "0";
  const ws = await db.workspace.create({ data: { name: "Platform", slug: `platform-${Date.now()}`, jiraProjectKey: "PAY" } });
  const sprint = await db.sprint.create({
    data: {
      workspaceId: ws.id,
      name: "Platform sprint",
      startsAt: new Date(),
      endsAt: new Date(Date.now() + 864e5),
      stories: {
        create: [
          {
            key: "PAY-812",
            title: "Idempotency keys",
            acceptanceCriteria: JSON.stringify(["Submitting the same key twice creates exactly one order.", "The second response returns the original order."]),
            points: 3,
          },
        ],
      },
    },
    include: { stories: true },
  });
  const story = sprint.stories[0];

  // ---- a queued pipeline is picked up and completed by the worker ----
  const run = await db.run.create({
    data: { workspaceId: ws.id, sprintId: sprint.id, storyId: story.id, agent: "qe-pipeline", status: "queued" },
  });
  const job = await enqueue({ workspaceId: ws.id, kind: "story-pipeline", payload: { runId: run.id, storyId: story.id }, runId: run.id });
  const worker = startWorker({ concurrency: 2, leaseMs: 5000, pollMs: 100 });
  const done = await waitFor(async () => (await db.job.findUnique({ where: { id: job.id } }))?.status === "succeeded");
  check("the worker runs a queued pipeline to completion", done);
  const finishedRun = await db.run.findUniqueOrThrow({ where: { id: run.id } });
  check("the run leaves the queue and finishes", finishedRun.status === "needs_review", finishedRun.status);
  check("the worker reports a heartbeat", (await db.workerHeartbeat.count({ where: { id: worker.id } })) === 1);

  // ---- an autopilot cycle runs as a job too ----
  const cycle = await startCycle({ workspaceId: ws.id, sprintId: sprint.id, status: "queued" });
  const apJob = await enqueue({
    workspaceId: ws.id,
    kind: "autopilot",
    payload: { runId: cycle.id, sprintId: sprint.id, campaign: null },
    runId: cycle.id,
    dedupeKey: `autopilot:${ws.id}`,
  });

  // ---- only one autopilot per workspace, enforced by the database ----
  let conflict: JobConflict | null = null;
  try {
    await enqueue({ workspaceId: ws.id, kind: "autopilot", payload: {}, dedupeKey: `autopilot:${ws.id}` });
  } catch (err) {
    if (err instanceof JobConflict) conflict = err;
  }
  check("a second autopilot is refused while one is active", conflict !== null && conflict.existing.runId === cycle.id);

  const apDone = await waitFor(async () => (await db.job.findUnique({ where: { id: apJob.id } }))?.status === "succeeded", 120_000);
  check("the worker runs an autopilot cycle", apDone);
  check("the cycle succeeded", (await db.run.findUniqueOrThrow({ where: { id: cycle.id } })).status === "succeeded");
  const again = await enqueue({ workspaceId: ws.id, kind: "autopilot", payload: { runId: "none", sprintId: sprint.id, campaign: null }, dedupeKey: `autopilot:${ws.id}` })
    .then(() => true)
    .catch(() => false);
  check("the key frees up once the job ends", again);
  await db.job.deleteMany({ where: { workspaceId: ws.id, status: "queued" } });

  await worker.stop(5000);
  check("a stopped worker removes its heartbeat", (await db.workerHeartbeat.count({ where: { id: worker.id } })) === 0);

  // ---- two workers never claim the same job ----
  const a = await enqueue({ workspaceId: ws.id, kind: "story-pipeline", payload: {} });
  const b = await enqueue({ workspaceId: ws.id, kind: "story-pipeline", payload: {} });
  const [c1, c2] = await Promise.all([claim("w-a", 60_000), claim("w-b", 60_000)]);
  check("concurrent claims get different jobs", Boolean(c1 && c2 && c1.id !== c2.id), `${c1?.id} ${c2?.id}`);
  check("a claim records the attempt", c1?.attempts === 1);
  await finish(a.id, c1?.id === a.id ? "w-a" : "w-b", { ok: true });
  await finish(b.id, c1?.id === b.id ? "w-a" : "w-b", { ok: true });

  // ---- a retryable failure goes back to the queue with a delay ----
  const r = await enqueue({ workspaceId: ws.id, kind: "story-pipeline", payload: {}, maxAttempts: 3 });
  const rc = await claim("w-r", 60_000);
  await finish(r.id, "w-r", { ok: false, error: "rate limited", retryable: true });
  const rj = await db.job.findUniqueOrThrow({ where: { id: r.id } });
  check("a retryable failure is requeued", rc?.id === r.id && rj.status === "queued" && rj.runAfter.getTime() > Date.now());
  await db.job.delete({ where: { id: r.id } });

  // ---- crash recovery: an abandoned job and its run are failed with a reason ----
  const lostRun = await db.run.create({ data: { workspaceId: ws.id, agent: "qe-pipeline", status: "running" } });
  await db.stage.create({ data: { runId: lostRun.id, agent: "spec-author", order: 4, status: "running" } });
  const lost = await db.job.create({
    data: {
      workspaceId: ws.id,
      kind: "story-pipeline",
      status: "running",
      lockedBy: "dead-worker",
      lockedUntil: new Date(Date.now() - 1000),
      runId: lostRun.id,
      dedupeKey: `lost-${Date.now()}`,
    },
  });
  const swept = await sweep();
  const lostJob = await db.job.findUniqueOrThrow({ where: { id: lost.id } });
  const lostAfter = await db.run.findUniqueOrThrow({ where: { id: lostRun.id }, include: { stages: true } });
  check("the sweep finds the abandoned job", swept.interrupted >= 1);
  check("the abandoned job is failed and its key released", lostJob.status === "failed" && lostJob.dedupeKey === null);
  check("its run is failed with a reason a person can act on", lostAfter.status === "failed" && /Run it again/.test(lostAfter.error ?? ""));
  check("its open stages are closed", lostAfter.stages.every((s) => s.status === "failed" || s.status === "skipped"));

  // ---- a run left running with no job is recovered once stale ----
  const orphan = await db.run.create({
    data: { workspaceId: ws.id, agent: "qe-pipeline", status: "running", startedAt: new Date(Date.now() - 20 * 60_000) },
  });
  await sweep();
  check("a stale orphaned run is failed", (await db.run.findUniqueOrThrow({ where: { id: orphan.id } })).status === "failed");

  // ---- retention ----
  const oldRun = await db.run.create({ data: { workspaceId: ws.id, agent: "qe-pipeline", status: "succeeded" } });
  await db.event.create({ data: { runId: oldRun.id, message: "old", ts: new Date(Date.now() - 40 * 86_400_000) } });
  await db.event.create({ data: { runId: oldRun.id, message: "new" } });
  await prune(30);
  const left = await db.event.findMany({ where: { runId: oldRun.id } });
  check("retention deletes old log lines and keeps recent ones", left.length === 1 && left[0].message === "new");

  // ---- environment validation ----
  const saved = { ...process.env };
  process.env.DATABASE_URL = "file:./dev.db";
  resetEnvForTests();
  let rejected = false;
  try {
    env();
  } catch {
    rejected = true;
  }
  check("a non-Postgres DATABASE_URL is rejected at boot", rejected);
  Object.assign(process.env, saved);
  (process.env as Record<string, string>).NODE_ENV = "production";
  process.env.AUTH_SECRET = "short";
  resetEnvForTests();
  let refused = false;
  try {
    checkProductionEnv();
  } catch {
    refused = true;
  }
  check("production refuses a weak AUTH_SECRET", refused);
  process.env.AUTH_SECRET = "x".repeat(40);
  process.env.ALLOW_DEMO_LOGIN = "true";
  resetEnvForTests();
  const warnings = checkProductionEnv();
  check("production warns when demo sign-in is on", warnings.some((w) => w.includes("ALLOW_DEMO_LOGIN")));
  Object.assign(process.env, saved);
  (process.env as Record<string, string>).NODE_ENV = saved.NODE_ENV ?? "development";
  resetEnvForTests();

  // ---- model client compatibility ----
  check("forced tool choice is used where the model supports it", supportsForcedTool("claude-sonnet-5") && supportsForcedTool("claude-opus-5"));
  check("forced tool choice is avoided where the model rejects it", !supportsForcedTool("claude-opus-5-5") && !supportsForcedTool("claude-fable-5-1"));

  await db.workspace.delete({ where: { id: ws.id } });
  console.log(results.join("\n"));
  console.log(`\n${results.length - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
