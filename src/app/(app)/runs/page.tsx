import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { relTime } from "@/lib/utils";
import { PageBar, Pane } from "@/components/page-bar";
import { Card, Pill, Empty } from "@/components/ui";

export const metadata: Metadata = { title: "Pipelines" };
export const dynamic = "force-dynamic";

const TONE = {
  running: "live",
  succeeded: "pass",
  failed: "fail",
  needs_review: "heal",
  queued: "idle",
} as const;

export default async function RunsPage() {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace } = ctx;

  const runs = await db.run.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { startedAt: "desc" },
    take: 50,
    include: { _count: { select: { jobs: true, events: true } }, sprint: { select: { name: true } } },
  });
  const live = runs.filter((r) => r.status === "running").length;

  return (
    <>
      <PageBar crumb={`${workspace.slug} / pipelines`} title="Pipelines" live={live} />
      <Pane>
        <Card>
          {runs.length === 0 ? (
            <Empty title="No runs yet">
              Every agent invocation lands here with its full log. Start one from the sprint planner —
              <b> Generate specs</b> fans the whole sprint out, or <b>Specs</b> on a single story runs
              qe-pipelines on its own.
            </Empty>
          ) : (
            <ul>
              {runs.map((r) => (
                <li key={r.id} className="border-b border-line-soft last:border-b-0">
                  <Link
                    href={`/runs/${r.id}`}
                    className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[12.5px] font-semibold">{r.agent}</span>
                        <Pill tone={TONE[r.status as keyof typeof TONE] ?? "idle"}>
                          {r.status.replace("_", " ")}
                        </Pill>
                        <Pill tone="idle" dot={false}>{r.mode}</Pill>
                      </div>
                      <div className="mt-1 text-[12px] text-muted">
                        {r.sprint?.name ? `${r.sprint.name} · ` : ""}
                        {r._count.jobs} {r._count.jobs === 1 ? "job" : "jobs"} · {r._count.events} log lines
                        {r.error ? ` · ${r.error.slice(0, 90)}` : ""}
                      </div>
                    </div>
                    <span className="font-mono text-[11.5px] text-muted">{relTime(r.startedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </Pane>
    </>
  );
}
