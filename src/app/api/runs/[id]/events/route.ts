import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";

export const dynamic = "force-dynamic";

/** Incremental log tail for the run view. Returns only events after the given id. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace();
  if (!ctx) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;

  const run = await db.run.findFirst({
    where: { id, workspaceId: ctx.workspace.id },
    select: { id: true, status: true },
  });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const after = new URL(req.url).searchParams.get("after");
  let cursorTs: Date | null = null;
  if (after) {
    const ev = await db.event.findUnique({ where: { id: after }, select: { ts: true } });
    cursorTs = ev?.ts ?? null;
  }

  const events = await db.event.findMany({
    where: { runId: run.id, ...(cursorTs ? { ts: { gt: cursorTs } } : {}) },
    orderBy: { ts: "asc" },
    take: 200,
  });

  return NextResponse.json(
    { status: run.status, events },
    { headers: { "Cache-Control": "no-store" } }
  );
}
