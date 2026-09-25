import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { buildStoryReport, reportMarkdown } from "@/lib/agents/report";

export const dynamic = "force-dynamic";

/** The story's test report as Markdown (`?format=json` for the structured version). */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace();
  if (!ctx) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { id } = await params;

  const run = await db.run.findFirst({ where: { id, workspaceId: ctx.workspace.id, agent: "qe-pipeline" }, select: { id: true } });
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  const report = await buildStoryReport(run.id);
  if (!report) return NextResponse.json({ error: "This run has no story" }, { status: 404 });

  if (new URL(req.url).searchParams.get("format") === "json") {
    return NextResponse.json(report, { headers: { "Cache-Control": "no-store" } });
  }
  const safeKey = report.story.key.replace(/[^A-Za-z0-9-]/g, "");
  return new NextResponse(reportMarkdown(report), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="test-report-${safeKey}.md"`,
      "Cache-Control": "no-store",
    },
  });
}
