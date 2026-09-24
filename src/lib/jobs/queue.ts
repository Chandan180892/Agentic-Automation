import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma";
import { log } from "@/lib/log";

export type JobKind = "story-pipeline" | "sprint-pipelines" | "autopilot";

export interface JobRow {
  id: string;
  workspaceId: string;
  kind: JobKind;
  payloadJson: string;
  attempts: number;
  maxAttempts: number;
  runId: string | null;
}

/** Another job with the same dedupe key is still active. */
export class JobConflict extends Error {
  constructor(readonly existing: { id: string; runId: string | null }) {
    super("A job like this is already queued or running.");
    this.name = "JobConflict";
  }
}

export async function enqueue(opts: {
  workspaceId: string;
  kind: JobKind;
  payload: unknown;
  runId?: string | null;
  dedupeKey?: string;
  maxAttempts?: number;
}) {
  try {
    return await db.job.create({
      data: {
        workspaceId: opts.workspaceId,
        kind: opts.kind,
        payloadJson: JSON.stringify(opts.payload),
        runId: opts.runId ?? null,
        dedupeKey: opts.dedupeKey ?? null,
        maxAttempts: opts.maxAttempts ?? 1,
      },
    });
  } catch (err) {
    if (opts.dedupeKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await db.job.findUnique({ where: { dedupeKey: opts.dedupeKey }, select: { id: true, runId: true } });
      throw new JobConflict(existing ?? { id: "", runId: null });
    }
    throw err;
  }
}

/**
 * Claims the oldest runnable job for this worker. `FOR UPDATE SKIP LOCKED` lets any number of
 * workers poll the same table without ever handing one job to two of them.
 */
export async function claim(workerId: string, leaseMs: number): Promise<JobRow | null> {
  const rows = await db.$queryRaw<JobRow[]>`
    UPDATE "Job"
       SET status = 'running',
           attempts = attempts + 1,
           "lockedBy" = ${workerId},
           "lockedUntil" = now() + (${leaseMs}::int * interval '1 millisecond'),
           "startedAt" = COALESCE("startedAt", now())
     WHERE id = (
       SELECT id FROM "Job"
        WHERE status = 'queued' AND "runAfter" <= now()
        ORDER BY "createdAt"
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING id, "workspaceId", kind, "payloadJson", attempts, "maxAttempts", "runId"`;
  return rows[0] ?? null;
}

/** Extends the lease. Returns false when the job is no longer ours (swept or cancelled). */
export async function renewLease(jobId: string, workerId: string, leaseMs: number) {
  const n = await db.$executeRaw`
    UPDATE "Job" SET "lockedUntil" = now() + (${leaseMs}::int * interval '1 millisecond')
     WHERE id = ${jobId} AND "lockedBy" = ${workerId} AND status = 'running'`;
  return n > 0;
}

export async function finish(jobId: string, workerId: string, outcome: { ok: true } | { ok: false; error: string; retryable?: boolean }) {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job || job.lockedBy !== workerId) return;
  if (!outcome.ok && outcome.retryable && job.attempts < job.maxAttempts) {
    // Back off 30s, 60s, 120s… and give the job back to the queue.
    const delay = 30_000 * 2 ** (job.attempts - 1);
    await db.job.update({
      where: { id: jobId },
      data: { status: "queued", lockedBy: null, lockedUntil: null, lastError: outcome.error, runAfter: new Date(Date.now() + delay) },
    });
    return;
  }
  await db.job.update({
    where: { id: jobId },
    data: {
      status: outcome.ok ? "succeeded" : "failed",
      lastError: outcome.ok ? null : outcome.error.slice(0, 4000),
      lockedBy: null,
      lockedUntil: null,
      dedupeKey: null,
      finishedAt: new Date(),
    },
  });
}

const INTERRUPTED =
  "Interrupted: the worker running this stopped (a restart, deploy or crash) before it finished. Nothing was published. Run it again.";

/** Marks a run and everything still open under it as failed. */
export async function failRunTree(runId: string, reason: string) {
  const ids = [runId, ...(await db.run.findMany({ where: { parentId: runId, status: { in: ["running", "queued"] } }, select: { id: true } })).map((r) => r.id)];
  await db.run.updateMany({ where: { id: { in: ids }, status: { in: ["running", "queued"] } }, data: { status: "failed", error: reason, finishedAt: new Date() } });
  // The stage that was working failed; the ones that never started were skipped.
  await db.stage.updateMany({ where: { runId: { in: ids }, status: "running" }, data: { status: "failed", finishedAt: new Date() } });
  await db.stage.updateMany({ where: { runId: { in: ids }, status: "pending" }, data: { status: "skipped" } });
  await db.event.create({ data: { runId, source: "system", stage: "system", level: "error", message: reason } });
}

/**
 * Crash recovery. A job whose lease ran out belongs to a worker that is gone: fail it and its
 * run with a reason a person can act on. Runs left "running" with no live job (from before jobs
 * existed, or from a request that died) are failed the same way once they are clearly stale.
 */
export async function sweep(staleRunMs = 15 * 60_000) {
  const expired = await db.job.findMany({
    where: { status: "running", lockedUntil: { lt: new Date() } },
    select: { id: true, runId: true, kind: true, payloadJson: true },
  });
  for (const job of expired) {
    await db.job.update({
      where: { id: job.id },
      data: { status: "failed", lastError: INTERRUPTED, lockedBy: null, lockedUntil: null, dedupeKey: null, finishedAt: new Date() },
    });
    const runIds = new Set<string>(job.runId ? [job.runId] : []);
    const payload = JSON.parse(job.payloadJson || "{}") as { runIds?: string[]; campaign?: { id: string } };
    for (const id of payload.runIds ?? []) runIds.add(id);
    for (const id of runIds) await failRunTree(id, INTERRUPTED);
    if (payload.campaign?.id) {
      const cycles = await db.run.findMany({ where: { agent: "autopilot", status: "running", inputJson: { contains: payload.campaign.id } }, select: { id: true } });
      for (const c of cycles) await failRunTree(c.id, INTERRUPTED);
    }
    log.warn("job interrupted", { job: job.id, kind: job.kind });
  }

  const busyWorkspaces = (await db.job.findMany({ where: { status: "running" }, select: { workspaceId: true } })).map((j) => j.workspaceId);
  const stale = await db.run.findMany({
    where: {
      status: "running",
      parentId: null,
      startedAt: { lt: new Date(Date.now() - staleRunMs) },
      workspaceId: { notIn: busyWorkspaces },
    },
    select: { id: true },
  });
  for (const r of stale) await failRunTree(r.id, "Stopped responding: no worker has reported progress on this run for 15 minutes. Run it again.");
  return { interrupted: expired.length, stale: stale.length };
}

/** Deletes log lines and finished jobs past the retention window. Lessons and audits are kept. */
export async function prune(retentionDays: number) {
  if (retentionDays <= 0) return { events: 0, jobs: 0 };
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const events = await db.event.deleteMany({ where: { ts: { lt: cutoff }, run: { status: { notIn: ["running", "queued"] } } } });
  const jobs = await db.job.deleteMany({ where: { finishedAt: { lt: cutoff } } });
  await db.workerHeartbeat.deleteMany({ where: { beatAt: { lt: new Date(Date.now() - 86_400_000) } } });
  return { events: events.count, jobs: jobs.count };
}
