import { db } from "@/lib/db";
import type { Campaign } from "@/lib/agents/autopilot";
import type { JobKind, JobRow } from "./queue";

/** Outcome of a handler. A thrown error is treated as a failure with that message. */
export type HandlerResult = { ok: true } | { ok: false; error: string; retryable?: boolean };

async function markRunning(runId: string) {
  await db.run.updateMany({ where: { id: runId, status: "queued" }, data: { status: "running", startedAt: new Date() } });
}

async function pipeline(runId: string, storyId: string): Promise<HandlerResult> {
  const { runPipeline } = await import("@/lib/agents/pipeline");
  await markRunning(runId);
  try {
    await runPipeline({ runId, storyId });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.event.create({ data: { runId, source: "pipeline", stage: "pipeline", level: "error", message: msg } });
    await db.stage.updateMany({ where: { runId, status: "running" }, data: { status: "failed", finishedAt: new Date() } });
    await db.run.update({ where: { id: runId }, data: { status: "failed", error: msg, finishedAt: new Date() } });
    return { ok: false, error: msg };
  }
}

export const HANDLERS: Record<JobKind, (job: JobRow) => Promise<HandlerResult>> = {
  "story-pipeline": async (job) => {
    const p = JSON.parse(job.payloadJson) as { runId: string; storyId: string };
    return pipeline(p.runId, p.storyId);
  },

  /** Sequential on purpose, so Atlassian rate limits hold. One failed story does not stop the rest. */
  "sprint-pipelines": async (job) => {
    const p = JSON.parse(job.payloadJson) as { runs: { runId: string; storyId: string }[] };
    const failed: string[] = [];
    for (const r of p.runs) {
      const res = await pipeline(r.runId, r.storyId);
      if (!res.ok) failed.push(r.runId);
    }
    return failed.length ? { ok: false, error: `${failed.length} of ${p.runs.length} pipelines failed` } : { ok: true };
  },

  autopilot: async (job) => {
    const p = JSON.parse(job.payloadJson) as { runId: string; sprintId: string; campaign: Campaign | null };
    const { runCycleSafely, runCampaign } = await import("@/lib/agents/autopilot");
    await markRunning(p.runId);
    if (p.campaign) {
      const res = await runCampaign({ firstRunId: p.runId, workspaceId: job.workspaceId, sprintId: p.sprintId, campaign: p.campaign });
      return res.reason === "failed" ? { ok: false, error: "a cycle failed" } : { ok: true };
    }
    const out = await runCycleSafely(p.runId);
    return out ? { ok: true } : { ok: false, error: "the cycle failed" };
  },
};
