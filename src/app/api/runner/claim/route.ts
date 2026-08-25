import { db } from "@/lib/db";
import { authenticateRunner, unauthorized } from "@/lib/runner-auth";
import { logEvent } from "@/lib/agents/runtime";

export const dynamic = "force-dynamic";

/**
 * A runner asks for work. We hand back at most one queued job from its own workspace and
 * mark it claimed in the same breath, so two runners polling at once cannot take the same job.
 */
export async function POST(req: Request) {
  const runner = await authenticateRunner(req);
  if (!runner) return unauthorized();

  await db.runner.update({
    where: { id: runner.id },
    data: { lastSeenAt: new Date(), status: runner.activeJobs > 0 ? "busy" : "online" },
  });

  if (runner.activeJobs >= runner.slots) {
    return Response.json({ job: null, reason: "All slots busy." });
  }

  const next = await db.job.findFirst({
    where: { status: "queued", run: { workspaceId: runner.workspaceId } },
    orderBy: { createdAt: "asc" },
    include: { story: { select: { key: true, title: true } } },
  });
  if (!next) return Response.json({ job: null });

  // Conditional update: whoever flips it out of "queued" first owns it.
  const claimed = await db.job.updateMany({
    where: { id: next.id, status: "queued" },
    data: { status: "claimed", runnerId: runner.id, claimedAt: new Date(), attempts: { increment: 1 } },
  });
  if (claimed.count === 0) return Response.json({ job: null, reason: "Raced by another runner." });

  await db.runner.update({ where: { id: runner.id }, data: { activeJobs: { increment: 1 }, status: "busy" } });
  await logEvent(next.runId, `claimed by ${runner.name}`, "info", "runner", next.id);

  return Response.json({
    job: {
      id: next.id,
      kind: next.kind,
      runId: next.runId,
      storyKey: next.story?.key ?? null,
      title: next.story?.title ?? null,
      payload: JSON.parse(next.payloadJson || "{}"),
    },
  });
}
