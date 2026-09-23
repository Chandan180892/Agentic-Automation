import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * Readiness: the database answers, migrations are applied, and — when this process runs the
 * inline worker — a worker has checked in recently. Returns 503 with the failing check otherwise.
 * Queue depth is reported so a platform can alert on a backlog.
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  try {
    await db.$queryRaw`SELECT 1`;
    checks.database = { ok: true };
  } catch (err) {
    checks.database = { ok: false, detail: "unreachable" };
    void err;
  }

  let queued = 0;
  let running = 0;
  if (checks.database.ok) {
    try {
      const pending = await db.$queryRaw<{ n: bigint }[]>`
        SELECT count(*)::bigint AS n FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL`;
      const n = Number(pending[0]?.n ?? 0);
      checks.migrations = n === 0 ? { ok: true } : { ok: false, detail: `${n} migration(s) unfinished` };
    } catch {
      checks.migrations = { ok: false, detail: "no migration history — run `prisma migrate deploy`" };
    }
    const beat = await db.workerHeartbeat.findFirst({ orderBy: { beatAt: "desc" } });
    const fresh = beat && Date.now() - beat.beatAt.getTime() < 60_000;
    checks.worker =
      env().WORKER_MODE === "off"
        ? { ok: true, detail: fresh ? "external worker alive" : "WORKER_MODE=off; no external worker has checked in" }
        : fresh
          ? { ok: true }
          : { ok: false, detail: "the inline worker has not checked in for a minute" };
    [queued, running] = await Promise.all([db.job.count({ where: { status: "queued" } }), db.job.count({ where: { status: "running" } })]);
  }

  const ok = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    { status: ok ? "ready" : "not-ready", checks, jobs: { queued, running } },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  );
}
