import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/workspace";
import { liveState } from "@/lib/agents/autopilot-live";

export const dynamic = "force-dynamic";

/** Live state of one autopilot cycle; `after` limits the log to lines at or after that time. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace();
  if (!ctx) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;
  const after = new URL(req.url).searchParams.get("after");
  const state = await liveState(ctx.workspace.id, id, after ? new Date(after) : null);
  if (!state) return NextResponse.json({ error: "Cycle not found" }, { status: 404 });
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
}
