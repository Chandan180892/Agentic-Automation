import { db } from "@/lib/db";
import { authenticateRunner, unauthorized } from "@/lib/runner-auth";
import { logEvent } from "@/lib/agents/runtime";

export const dynamic = "force-dynamic";

const ASSET_KINDS = new Set(["spec", "fixture", "pageobject", "data", "report", "patch"]);

/** The runner reports the outcome and uploads whatever it produced. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const runner = await authenticateRunner(req);
  if (!runner) return unauthorized();
  const { id } = await params;

  const job = await db.job.findFirst({
    where: { id, runnerId: runner.id, run: { workspaceId: runner.workspaceId } },
    include: { run: true },
  });
  if (!job) return Response.json({ error: "Job not claimed by this runner." }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    status?: "passed" | "failed";
    result?: unknown;
    assets?: { path: string; kind?: string; content: string }[];
    failureOutput?: string;
  };
  const status = body.status === "failed" ? "failed" : "passed";

  for (const a of (body.assets ?? []).slice(0, 50)) {
    if (!a?.path || typeof a.content !== "string") continue;
    await db.asset.create({
      data: {
        jobId: job.id,
        path: String(a.path).slice(0, 300),
        kind: ASSET_KINDS.has(String(a.kind)) ? String(a.kind) : "report",
        content: a.content.slice(0, 400_000),
        bytes: a.content.length,
      },
    });
  }

  await db.job.update({
    where: { id: job.id },
    data: {
      status,
      finishedAt: new Date(),
      resultJson: JSON.stringify({ ...(body.result ?? {}), failureOutput: body.failureOutput ?? null }),
    },
  });

  await db.runner.update({
    where: { id: runner.id },
    data: { activeJobs: { decrement: 1 }, lastSeenAt: new Date() },
  });
  await db.runner.updateMany({ where: { id: runner.id, activeJobs: { lt: 0 } }, data: { activeJobs: 0 } });

  if (job.storyId) {
    await db.story.update({
      where: { id: job.storyId },
      data: { status: status === "passed" ? "green" : "failing" },
    });
  }

  await logEvent(
    job.runId,
    status === "passed" ? `job finished green on ${runner.name}` : `job failed on ${runner.name}`,
    status === "passed" ? "ok" : "error",
    "runner",
    job.id
  );

  // The parent run closes once no job is still outstanding.
  const outstanding = await db.job.count({
    where: { runId: job.runId, status: { in: ["queued", "claimed", "running"] } },
  });
  if (outstanding === 0) {
    const anyFailed = await db.job.count({ where: { runId: job.runId, status: "failed" } });
    await db.run.update({
      where: { id: job.runId },
      data: { status: anyFailed ? "needs_review" : "succeeded", finishedAt: new Date() },
    });
    await logEvent(
      job.runId,
      anyFailed ? `${anyFailed} job(s) failed — qe-auto-heal can take it from here.` : "all jobs green",
      anyFailed ? "warn" : "ok",
      "system"
    );
  }

  return Response.json({ ok: true, status });
}
