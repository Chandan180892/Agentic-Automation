import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { relTime } from "@/lib/utils";
import { PageBar, Pane } from "@/components/page-bar";
import { Card, CardHeader, CardBody, Pill, Sub } from "@/components/ui";
import { RunStream } from "./stream";

export const metadata: Metadata = { title: "Run" };
export const dynamic = "force-dynamic";

const TONE = {
  running: "live",
  succeeded: "pass",
  failed: "fail",
  needs_review: "heal",
  queued: "idle",
  passed: "pass",
  claimed: "live",
  cancelled: "idle",
} as const;

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace } = ctx;
  const { id } = await params;

  const run = await db.run.findFirst({
    where: { id, workspaceId: workspace.id },
    include: {
      sprint: { select: { name: true } },
      events: { orderBy: { ts: "asc" }, take: 500 },
      jobs: {
        orderBy: { createdAt: "asc" },
        include: { story: { select: { key: true, title: true } }, assets: true, runner: { select: { name: true } } },
      },
    },
  });
  if (!run) notFound();

  const assets = run.jobs.flatMap((j) => j.assets);
  const done = run.jobs.filter((j) => j.status === "passed" || j.status === "failed").length;

  return (
    <>
      <PageBar crumb={`${workspace.slug} / runs / ${run.agent}`} title={run.agent}>
        <Pill tone={TONE[run.status as keyof typeof TONE] ?? "idle"}>{run.status.replace("_", " ")}</Pill>
        <span className="font-mono text-[11.5px] text-muted">{relTime(run.startedAt)}</span>
      </PageBar>

      <Pane>
        {run.error && (
          <div className="mb-4 rounded-[10px] border border-fail/30 bg-fail-soft px-4 py-3">
            <p className="text-[12.5px] leading-[1.6] text-fail">{run.error}</p>
          </div>
        )}

        {run.jobs.length > 0 && (
          <Card className="mb-4">
            <CardHeader title="Jobs">
              <Pill tone="idle" dot={false}>
                {done} / {run.jobs.length} finished
              </Pill>
            </CardHeader>
            <CardBody className="blueprint">
              <div className="flex flex-wrap gap-2">
                {run.jobs.map((j) => (
                  <div
                    key={j.id}
                    className="flex w-[180px] flex-col gap-1.5 rounded-[9px] border border-line bg-surface px-3 py-2.5"
                    data-status={j.status}
                  >
                    <span className="truncate font-mono text-[11px] font-semibold">
                      {j.story?.key ?? j.kind}
                    </span>
                    <span className="truncate text-[11px] text-muted">{j.story?.title ?? j.kind}</span>
                    <div className="flex items-center gap-1.5">
                      <Pill tone={TONE[j.status as keyof typeof TONE] ?? "idle"}>{j.status}</Pill>
                      {j.runner && <span className="truncate font-mono text-[10px] text-muted">{j.runner.name}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        )}

        <div className="grid items-start gap-4 xl:grid-cols-[1fr_372px]">
          <RunStream runId={run.id} initial={run.events} finished={run.status !== "running"} />

          <div className="grid gap-4">
            <Card>
              <CardHeader title="Assets produced">
                <Pill tone="accent" dot={false}>{assets.length}</Pill>
              </CardHeader>
              <CardBody className="grid gap-2">
                {assets.length === 0 ? (
                  <Sub>Nothing written yet. Assets appear here as the agent produces them.</Sub>
                ) : (
                  assets.map((a) => (
                    <details key={a.id} className="rounded-lg border border-line-soft bg-surface-2">
                      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5">
                        <svg viewBox="0 0 24 24" className="size-[15px] shrink-0 fill-none stroke-muted stroke-[1.7]" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
                          <path d="M14 3v5h5" />
                        </svg>
                        <span className="truncate font-mono text-[11.5px] font-medium">{a.path}</span>
                        <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">{a.kind}</span>
                      </summary>
                      <pre className="term term-text max-h-[320px] overflow-auto rounded-b-lg px-3 py-2.5 font-mono text-[11px] leading-[1.7]">
                        {a.content}
                      </pre>
                    </details>
                  ))
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Where it ran" />
              <CardBody className="grid gap-2.5">
                {run.jobs.some((j) => j.runner) ? (
                  run.jobs
                    .filter((j) => j.runner)
                    .map((j) => (
                      <div key={j.id} className="flex items-center gap-2.5">
                        <span className="relative size-2.5 shrink-0 rounded-full bg-live text-live beat" />
                        <span className="font-mono text-[12.5px] font-semibold">{j.runner!.name}</span>
                        <Pill tone="live" className="ml-auto">{j.status}</Pill>
                      </div>
                    ))
                ) : (
                  <Sub>
                    This agent ran inside Gantry. Jobs queued for execution are claimed by your own
                    runners over their outbound connection — Gantry never opens a port on your network
                    and holds no SSH key.
                  </Sub>
                )}
                <Link href="/runners" className="text-[12px] font-semibold text-accent hover:underline">
                  Manage runners →
                </Link>
              </CardBody>
            </Card>
          </div>
        </div>
      </Pane>
    </>
  );
}
