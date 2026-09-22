import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { parseJson, relTime } from "@/lib/utils";
import { PageBar, Pane } from "@/components/page-bar";
import { buttonClass } from "@/components/ui";
import { CycleLive, type LiveState } from "./live";

export const metadata: Metadata = { title: "Autopilot cycle" };
export const dynamic = "force-dynamic";

export default async function CyclePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace } = ctx;
  const { id } = await params;

  const run = await db.run.findFirst({
    where: { id, workspaceId: workspace.id, agent: "autopilot" },
    include: {
      sprint: { select: { name: true } },
      stages: { orderBy: { order: "asc" } },
      children: {
        orderBy: { startedAt: "asc" },
        select: { id: true, agent: true, status: true, story: { select: { key: true } } },
      },
    },
  });
  if (!run) notFound();

  const events = await db.event.findMany({
    where: { runId: { in: [run.id, ...run.children.map((c) => c.id)] } },
    orderBy: { ts: "asc" },
    take: 2000,
  });

  const initial: LiveState = {
    status: run.status,
    error: run.error,
    stages: run.stages.map((s) => ({ agent: s.agent, status: s.status, summary: s.summary })),
    output: parseJson(run.outputJson, null),
    children: run.children.map((c) => ({ id: c.id, agent: c.agent, status: c.status, storyKey: c.story?.key ?? "" })),
    events: events.map((e) => ({
      id: e.id,
      ts: e.ts.toISOString(),
      level: e.level,
      source: e.source,
      message: e.message,
      runId: e.runId,
    })),
  };
  const cycle = parseJson<{ cycle: number }>(run.inputJson, { cycle: 0 }).cycle;

  return (
    <>
      <PageBar crumb={`${workspace.slug} / autopilot / cycle ${cycle}`} title={`Cycle ${cycle} · ${run.sprint?.name ?? ""}`}>
        <span className="font-mono text-[11.5px] text-muted">{relTime(run.startedAt)}</span>
        <Link href="/autopilot" className={buttonClass("default", "sm")}>
          All cycles
        </Link>
      </PageBar>
      <Pane>
        <CycleLive runId={run.id} initial={initial} />
      </Pane>
    </>
  );
}
