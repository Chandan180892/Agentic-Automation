import { db } from "@/lib/db";
import { authenticateRunner, unauthorized } from "@/lib/runner-auth";

export const dynamic = "force-dynamic";

const LEVELS = new Set(["info", "ok", "warn", "error"]);

/** Streams log lines from the runner into the run view. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const runner = await authenticateRunner(req);
  if (!runner) return unauthorized();
  const { id } = await params;

  const job = await db.job.findFirst({
    where: { id, runnerId: runner.id, run: { workspaceId: runner.workspaceId } },
  });
  if (!job) return Response.json({ error: "Job not claimed by this runner." }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    lines?: { message: string; level?: string }[];
    message?: string;
    level?: string;
  };
  const lines = body.lines ?? (body.message ? [{ message: body.message, level: body.level }] : []);
  if (lines.length === 0) return Response.json({ ok: true, written: 0 });

  await db.event.createMany({
    data: lines.slice(0, 200).map((l) => ({
      runId: job.runId,
      jobId: job.id,
      message: String(l.message).slice(0, 4000),
      level: LEVELS.has(String(l.level)) ? String(l.level) : "info",
      source: runner.name,
    })),
  });

  if (job.status === "claimed") {
    await db.job.update({ where: { id: job.id }, data: { status: "running" } });
  }

  return Response.json({ ok: true, written: lines.length });
}
