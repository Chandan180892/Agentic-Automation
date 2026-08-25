import { db } from "@/lib/db";
import { authenticateRunner, unauthorized } from "@/lib/runner-auth";

export const dynamic = "force-dynamic";

/** Called on connect and then on a timer. Also reports the runner's version and capacity. */
export async function POST(req: Request) {
  const runner = await authenticateRunner(req);
  if (!runner) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    version?: string;
    slots?: number;
    activeJobs?: number;
    location?: string;
  };

  const updated = await db.runner.update({
    where: { id: runner.id },
    data: {
      status: (body.activeJobs ?? 0) > 0 ? "busy" : "online",
      lastSeenAt: new Date(),
      version: body.version ?? runner.version,
      slots: typeof body.slots === "number" ? Math.max(1, Math.min(16, body.slots)) : runner.slots,
      activeJobs: typeof body.activeJobs === "number" ? Math.max(0, body.activeJobs) : runner.activeJobs,
      location: body.location || runner.location,
    },
  });

  return Response.json({
    ok: true,
    runner: { id: updated.id, name: updated.name, slots: updated.slots, workspaceId: updated.workspaceId },
    pollAfterMs: 3000,
  });
}
