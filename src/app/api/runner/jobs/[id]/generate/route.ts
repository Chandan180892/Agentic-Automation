import { db } from "@/lib/db";
import { authenticateRunner, unauthorized } from "@/lib/runner-auth";
import { invokeAgent, logEvent } from "@/lib/agents/runtime";
import { parseJson } from "@/lib/utils";
import type * as S from "@/lib/agents/schemas";
import type { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type PipelinesOut = z.infer<typeof S.QePipelinesOut>;

/**
 * The runner has claimed a spec-gen job and asks Gantry for the files to write. Generation
 * happens here because the model key lives on the server — the runner never needs one. The
 * assets are stored against the job at the same time, so the run view shows them immediately.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const runner = await authenticateRunner(req);
  if (!runner) return unauthorized();
  const { id } = await params;

  const job = await db.job.findFirst({
    where: { id, runnerId: runner.id, run: { workspaceId: runner.workspaceId } },
    include: { story: true },
  });
  if (!job) return Response.json({ error: "Job not claimed by this runner." }, { status: 404 });
  if (job.kind !== "spec-gen") {
    return Response.json({ error: `Nothing to generate for a ${job.kind} job.` }, { status: 400 });
  }

  const payload = parseJson<{ storyKey?: string; title?: string; description?: string; acceptanceCriteria?: string[]; framework?: string }>(
    job.payloadJson,
    {}
  );
  const story = job.story;

  await logEvent(job.runId, "requesting specs from qe-pipelines", "info", runner.name, job.id);

  try {
    const result = await invokeAgent<PipelinesOut>("qe-pipelines", {
      story: {
        key: story?.key ?? payload.storyKey ?? "UNKNOWN",
        title: story?.title ?? payload.title ?? "Untitled",
        description: story?.description ?? payload.description ?? "",
        acceptanceCriteria: story
          ? parseJson<string[]>(story.acceptanceCriteria, [])
          : (payload.acceptanceCriteria ?? []),
        points: story?.points ?? null,
      },
      framework: payload.framework ?? "playwright",
      language: "typescript",
    });
    const out = result.output;

    for (const a of out.assets) {
      await db.asset.create({
        data: { jobId: job.id, path: a.path, kind: a.kind, content: a.content, bytes: a.content.length },
      });
    }
    await logEvent(
      job.runId,
      `generated ${out.assets.length} file(s)${result.mode === "simulated" ? " (simulator — no ANTHROPIC_API_KEY set)" : ""}`,
      "ok",
      runner.name,
      job.id
    );
    if (job.storyId) await db.story.update({ where: { id: job.storyId }, data: { status: "specced" } });

    return Response.json({
      summary: out.summary,
      needsHuman: out.needsHuman,
      notes: out.notes,
      scenarios: out.scenarios,
      assets: out.assets,
      mode: result.mode,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logEvent(job.runId, msg, "error", runner.name, job.id);
    return Response.json({ error: msg }, { status: 502 });
  }
}
