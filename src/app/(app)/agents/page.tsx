import type { Metadata } from "next";
import { db } from "@/lib/db";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/workspace";
import { PageBar, Pane } from "@/components/page-bar";
import { Card, CardHeader, CardBody, Pill, Sub } from "@/components/ui";
import { AGENT_LIST } from "@/lib/agents/registry";
import { SUB_AGENT_LIST } from "@/lib/agents/pipeline-registry";
import { agentsAreLive } from "@/lib/agents/runtime";

export const metadata: Metadata = { title: "Agents" };
export const dynamic = "force-dynamic";

const ICONS: Record<string, React.ReactNode> = {
  "sprint-planner": <path d="M4 6h16M4 12h10M4 18h13" />,
  "qe-pipeline": <path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5" />,
  "qe-auto-heal": <path d="M21 12a9 9 0 1 1-3-6.7M21 4v5h-5" />,
  "batch-heal": <path d="M20 11a8 8 0 1 0-2.7 6M20 4v5h-5M8 12h8M12 8v8" />,
  "qe-insights": <path d="M3 18l5-6 4 4 4-7 5 6M3 21h18" />,
};

const CHAIN = SUB_AGENT_LIST.map((a) => [a.id, a.role] as const);

export default async function AgentsPage() {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace } = ctx;

  const [counts, live] = await Promise.all([
    db.run.groupBy({ by: ["agent", "status"], where: { workspaceId: workspace.id }, _count: true }),
    db.run.count({ where: { workspaceId: workspace.id, status: "running" } }),
  ]);

  const stats = new Map<string, { total: number; running: number; review: number; failed: number }>();
  for (const c of counts) {
    const e = stats.get(c.agent) ?? { total: 0, running: 0, review: 0, failed: 0 };
    e.total += c._count;
    if (c.status === "running") e.running += c._count;
    if (c.status === "needs_review") e.review += c._count;
    if (c.status === "failed") e.failed += c._count;
    stats.set(c.agent, e);
  }

  return (
    <>
      <PageBar crumb={`${workspace.slug} / agents`} title="Agents" live={live}>
        <Pill tone={agentsAreLive() ? "pass" : "heal"}>
          {agentsAreLive() ? `live · ${process.env.ANTHROPIC_MODEL || "claude-sonnet-5"}` : "simulator mode"}
        </Pill>
      </PageBar>

      <Pane>
        <div className="mb-4 max-w-[62ch]">
          <h3 className="text-[17px]">Top-level agents</h3>
          <Sub className="mt-1.5">
            Each has one job, a typed input, and a typed output, produced through a forced tool call
            so a malformed result never reaches your database. qe-pipeline is itself an orchestrator:
            it runs the six sub-agents below.
          </Sub>
        </div>

        <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
          {AGENT_LIST.map((a) => {
            const s = stats.get(a.id);
            const tone = s?.running ? "live" : s?.failed ? "fail" : s?.review ? "heal" : s?.total ? "pass" : "idle";
            const label = s?.running
              ? `${s.running} running`
              : s?.review
                ? `${s.review} awaiting review`
                : s?.failed
                  ? `${s.failed} failed`
                  : s?.total
                    ? "healthy"
                    : "not run yet";
            return (
              <div
                key={a.id}
                className="flex flex-col gap-2.5 rounded-[10px] border border-line bg-surface p-4 transition-[border-color,box-shadow,transform] hover:-translate-y-px hover:border-accent-line hover:shadow-[var(--shadow)]"
              >
                <div className="flex items-start gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-accent-line bg-accent-soft">
                    <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-accent stroke-[1.8]" strokeLinecap="round" strokeLinejoin="round">
                      {ICONS[a.id]}
                    </svg>
                  </span>
                  <div className="min-w-0">
                    <h4 className="font-mono text-[12.5px] font-semibold tracking-[-0.01em]">{a.id}</h4>
                    <div className="mt-px text-[11px] text-muted">{a.role}</div>
                  </div>
                  <div className="ml-auto">
                    <Pill tone={tone as "live" | "fail" | "heal" | "pass" | "idle"}>{label}</Pill>
                  </div>
                </div>

                <p className="text-[12.5px] leading-[1.55] text-ink-2">{a.description}</p>

                <div className="flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-muted">
                  <span className="rounded-[5px] border border-line-soft bg-surface-3 px-1.5 py-0.5">{a.io[0]}</span>
                  <span className="text-accent-line">→</span>
                  <span className="rounded-[5px] border border-line-soft bg-surface-3 px-1.5 py-0.5">{a.io[1]}</span>
                </div>

                <div className="mt-auto flex items-center gap-2 border-t border-line-soft pt-2.5">
                  <Pill tone="idle" dot={false}>{a.mode}</Pill>
                  <span className="ml-auto font-mono text-[11px] text-muted">
                    {s?.total ?? 0} {s?.total === 1 ? "run" : "runs"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <Card className="mt-4">
          <CardHeader title="Inside qe-pipeline">
            <Pill tone="idle" dot={false}>read left to right</Pill>
          </CardHeader>
          <CardBody className="blueprint">
            <div className="flex items-stretch gap-0 overflow-x-auto pb-2">
              {CHAIN.map(([name, what], i) => (
                <div key={name} className="flex items-center">
                  {i > 0 && (
                    <span className="grid w-6 shrink-0 place-items-center">
                      <svg viewBox="0 0 26 12" className="w-6 fill-none stroke-line stroke-[1.6]">
                        <path d="M0 6h20m-4-4 4 4-4 4" />
                      </svg>
                    </span>
                  )}
                  <div className="flex w-[158px] shrink-0 flex-col gap-1.5 rounded-[9px] border border-line bg-surface px-3 py-2.5">
                    <span className="font-mono text-[11px] font-semibold">{name}</span>
                    <span className="text-[11px] text-muted">{what}</span>
                  </div>
                </div>
              ))}
            </div>
            <ol className="mt-3 grid gap-2.5 border-t border-line-soft pt-3">
              {SUB_AGENT_LIST.map((a) => (
                <li key={a.id} className="flex gap-3">
                  <span className="mt-px w-5 shrink-0 text-right font-mono text-[11px] font-semibold text-muted">
                    {a.order}
                  </span>
                  <span className="min-w-0">
                    <span className="font-mono text-[12px] font-semibold">{a.id}</span>
                    <span className="ml-2 text-[11.5px] text-muted">{a.role}</span>
                    <p className="mt-0.5 text-[12.5px] leading-[1.55] text-ink-2">{a.description}</p>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-3 border-t border-line-soft pt-3 text-[12.5px] leading-[1.55] text-muted">
              When the verifier rejects the work, spec-author revises and the verifier re-checks —
              up to twice — so the pipeline converges instead of stopping at the first objection.
              A blocking question from clarify stops the chain outright rather than letting a guess
              flow downstream.
            </p>
          </CardBody>
        </Card>
      </Pane>
    </>
  );
}
