import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { parseJson } from "@/lib/utils";

export const dynamic = "force-dynamic";

/**
 * Live state of one autopilot cycle: its phases, its output so far, the child runs it started,
 * and every log line — the cycle's own and its children's — after the given timestamp.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace();
  if (!ctx) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;

  const run = await db.run.findFirst({
    where: { id, workspaceId: ctx.workspace.id, agent: "autopilot" },
    include: {
      stages: { orderBy: { order: "asc" } },
      children: {
        orderBy: { startedAt: "asc" },
        select: { id: true, agent: true, status: true, story: { select: { key: true } } },
      },
    },
  });
  if (!run) return NextResponse.json({ error: "Cycle not found" }, { status: 404 });

  const after = new URL(req.url).searchParams.get("after");
  const since = after ? new Date(after) : null;
  // gte rather than gt: two lines can share a millisecond. The client drops ids it already has.
  const events = await db.event.findMany({
    where: {
      runId: { in: [run.id, ...run.children.map((c) => c.id)] },
      ...(since && !Number.isNaN(since.getTime()) ? { ts: { gte: since } } : {}),
    },
    orderBy: { ts: "asc" },
    take: 400,
  });

  return NextResponse.json(
    {
      status: run.status,
      error: run.error,
      stages: run.stages.map((s) => ({ agent: s.agent, status: s.status, summary: s.summary })),
      output: parseJson(run.outputJson, null),
      children: run.children.map((c) => ({ id: c.id, agent: c.agent, status: c.status, storyKey: c.story?.key ?? "" })),
      events: events.map((e) => ({ id: e.id, ts: e.ts, level: e.level, source: e.source, message: e.message, runId: e.runId })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
