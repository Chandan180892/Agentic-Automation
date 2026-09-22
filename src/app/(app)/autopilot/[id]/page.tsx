import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { parseJson, relTime } from "@/lib/utils";
import { PageBar, Pane } from "@/components/page-bar";
import { buttonClass } from "@/components/ui";
import { CycleLive, type LiveState } from "./live";
import { liveState } from "@/lib/agents/autopilot-live";

export const metadata: Metadata = { title: "Autopilot cycle" };
export const dynamic = "force-dynamic";

export default async function CyclePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace } = ctx;
  const { id } = await params;

  const run = await db.run.findFirst({
    where: { id, workspaceId: workspace.id, agent: "autopilot" },
    include: { sprint: { select: { name: true } } },
  });
  if (!run) notFound();
  const state = await liveState(workspace.id, run.id, null);
  if (!state) notFound();
  const initial = state as LiveState;
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
