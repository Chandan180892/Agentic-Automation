import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { parseJson, relTime } from "@/lib/utils";
import { PageBar, Pane } from "@/components/page-bar";
import { Card, CardHeader, CardBody, Pill, Sub, Button, Empty, buttonClass } from "@/components/ui";
import { PHASES, type CycleOutput } from "@/lib/agents/autopilot";
import { agentsAreLive } from "@/lib/agents/runtime";
import { startAutopilot, startAutopilotUntilStable } from "../actions";

export const metadata: Metadata = { title: "Autopilot" };
export const dynamic = "force-dynamic";

const VERDICT_TONE = { accept: "pass", "accept-with-risks": "heal", reject: "fail" } as const;

export default async function AutopilotPage() {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace } = ctx;

  const [sprint, cycles] = await Promise.all([
    db.sprint.findFirst({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { stories: true } } },
    }),
    db.run.findMany({
      where: { workspaceId: workspace.id, agent: "autopilot" },
      orderBy: { startedAt: "desc" },
      take: 20,
      include: { sprint: { select: { name: true } } },
    }),
  ]);

  const running = cycles.find((c) => c.status === "running" || c.status === "queued");

  return (
    <>
      <PageBar crumb={`${workspace.slug} / autopilot`} title="Autopilot">
        {!agentsAreLive() && <Pill tone="heal">simulator</Pill>}
        {running ? (
          <Link href={`/autopilot/${running.id}`} className={buttonClass("primary")}>
            Watch cycle {parseJson<{ cycle: number }>(running.inputJson, { cycle: 0 }).cycle} live →
          </Link>
        ) : sprint && sprint._count.stories > 0 ? (
          <>
            <form action={startAutopilot.bind(null, sprint.id)}>
              <Button>Run one cycle</Button>
            </form>
            <form action={startAutopilotUntilStable.bind(null, sprint.id)}>
              <Button variant="primary" title="Keeps starting cycles until one learns nothing new">
                Run {sprint.name} until stable
              </Button>
            </form>
          </>
        ) : (
          <Link href="/sprint" className={buttonClass("primary")}>
            Create a sprint first
          </Link>
        )}
      </PageBar>

      <Pane>
        {/* ------------------------------------------------------------ loop -- */}
        <Card className="mb-4">
          <CardHeader title="The loop">
            <Sub>Each cycle runs eight phases. The last one feeds the first.</Sub>
          </CardHeader>
          <CardBody className="blueprint">
            <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
              {PHASES.map((p, i) => (
                <li key={p.id} className="rounded-[9px] border border-line bg-surface px-3 py-2.5">
                  <div className="font-mono text-[10.5px] text-muted">{String(i + 1).padStart(2, "0")}</div>
                  <div className="text-[13px] font-semibold">{p.label}</div>
                  <div className="mt-0.5 text-[11.5px] leading-[1.45] text-muted">{p.blurb}</div>
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>

        {/* ------------------------------------------------------------ cycles -- */}
        <Card>
            <CardHeader title="Cycles" />
            {cycles.length === 0 ? (
              <Empty title="No cycles yet">
                Start one above. With no API key every agent runs on its simulator and execution is simulated, so the
                whole loop is watchable before anything is configured.
              </Empty>
            ) : (
              <ul className="divide-y divide-line-soft">
                {cycles.map((c) => {
                  const out = parseJson<CycleOutput | null>(c.outputJson, null);
                  const n = parseJson<{ cycle: number }>(c.inputJson, { cycle: 0 }).cycle;
                  const verdict = out?.review?.verdict;
                  return (
                    <li key={c.id}>
                      <Link href={`/autopilot/${c.id}`} className="block px-4 py-3 transition-colors hover:bg-surface-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <b className="text-[13px]">Cycle {n}</b>
                          <span className="text-[12px] text-muted">{c.sprint?.name}</span>
                          {c.status === "running" || c.status === "queued" ? (
                            <Pill tone="live">running</Pill>
                          ) : c.status === "failed" ? (
                            <Pill tone="fail">failed</Pill>
                          ) : verdict ? (
                            <Pill tone={VERDICT_TONE[verdict]}>{verdict}</Pill>
                          ) : null}
                          <span className="ml-auto font-mono text-[11px] text-muted">{relTime(c.startedAt)}</span>
                        </div>
                        {out?.report?.headline && <p className="mt-1 text-[12px] text-ink-2">{out.report.headline}</p>}
                        {out && c.status === "succeeded" && (
                          <p className="mt-1 font-mono text-[11px] text-muted">
                            first-run {Math.round(out.metrics.firstRunPassRate * 100)}% · healed {out.metrics.healed} ·
                            revisions {out.metrics.revisions} · lessons applied {out.metrics.lessonsApplied}
                          </p>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
      </Pane>
    </>
  );
}
