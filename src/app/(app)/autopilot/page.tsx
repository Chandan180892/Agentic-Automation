import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { parseJson, relTime } from "@/lib/utils";
import { PageBar, Pane } from "@/components/page-bar";
import { Card, CardHeader, CardBody, Pill, Sub, Button, Empty, Meter, buttonClass } from "@/components/ui";
import { PHASES, type CycleOutput } from "@/lib/agents/autopilot";
import { agentsAreLive } from "@/lib/agents/runtime";
import { startAutopilot, startAutopilotUntilStable, forgetLesson, reviewLesson, saveLearningSettings } from "../actions";
import { Trend } from "./trend";
import { History } from "./history";

export const metadata: Metadata = { title: "Autopilot" };
export const dynamic = "force-dynamic";

const VERDICT_TONE = { accept: "pass", "accept-with-risks": "heal", reject: "fail" } as const;

export default async function AutopilotPage() {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace } = ctx;

  const [sprint, cycles, lessons] = await Promise.all([
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
    db.lesson.findMany({
      where: { workspaceId: workspace.id },
      orderBy: [{ confidence: "desc" }],
      include: { events: { orderBy: { at: "asc" }, take: 40 } },
    }),
  ]);

  const running = cycles.find((c) => c.status === "running" || c.status === "queued");
  const STATUS_ORDER = { proposed: 0, active: 1, retired: 2, rejected: 3 } as Record<string, number>;
  lessons.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
  const proposed = lessons.filter((l) => l.status === "proposed").length;
  const finished = cycles
    .filter((c) => c.status === "succeeded")
    .map((c) => ({ run: c, out: parseJson<CycleOutput | null>(c.outputJson, null) }))
    .filter((c): c is { run: (typeof cycles)[number]; out: CycleOutput } => Boolean(c.out))
    .reverse();

  const points = finished.slice(-12).map(({ out }) => ({
    cycle: out.cycle,
    firstRun: Math.round(out.metrics.firstRunPassRate * 100),
    healed: out.metrics.healed,
    revisions: out.metrics.revisions,
  }));

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
            <p className="mt-3 text-[12px] leading-[1.6] text-ink-2">
              <b>How it learns.</b> Every heal, verifier revision and application defect becomes a signal. The learner
              reduces signals to root causes and stores each as a lesson for the agent that could have prevented it. The
              next cycle injects those lessons into that agent&apos;s turn. A lesson that holds gains confidence; one
              whose problem comes back anyway loses it and eventually retires. Learning never touches an assertion: a
              test that caught a real bug stays exactly as it is.
            </p>
          </CardBody>
        </Card>

        {/* ---------------------------------------------------- learning curve -- */}
        <Card className="mb-4">
          <CardHeader title="Learning curve">
            <Sub>Completed cycles, oldest to newest.</Sub>
          </CardHeader>
          <CardBody>
            {points.length < 2 ? (
              <Sub>
                {points.length === 0
                  ? "No completed cycles yet."
                  : "One cycle so far. Run another and this shows whether the lessons helped."}
              </Sub>
            ) : (
              <div className="grid gap-4 md:grid-cols-3">
                <Trend title="First-run pass rate" unit="%" max={100} points={points.map((p) => ({ x: p.cycle, y: p.firstRun }))} better="up" />
                <Trend title="Tests the agents had to heal" points={points.map((p) => ({ x: p.cycle, y: p.healed }))} better="down" />
                <Trend title="Verifier revisions" points={points.map((p) => ({ x: p.cycle, y: p.revisions }))} better="down" />
              </div>
            )}
          </CardBody>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[1.25fr_1fr]">
          {/* ---------------------------------------------------------- memory -- */}
          <Card>
            <CardHeader title="Memory">
              <Pill tone="idle" dot={false}>
                {lessons.filter((l) => l.status === "active").length} active
              </Pill>
              {proposed > 0 && <Pill tone="heal">{proposed} awaiting approval</Pill>}
              <form action={saveLearningSettings} className="ml-auto flex items-center gap-1.5">
                <label htmlFor="lessonApproval" className="text-[11.5px] text-muted">
                  New lessons
                </label>
                <select
                  id="lessonApproval"
                  name="lessonApproval"
                  defaultValue={workspace.lessonApproval}
                  className="rounded-md border border-line bg-surface px-1.5 py-1 text-[11.5px]"
                >
                  <option value="auto">apply automatically</option>
                  <option value="review">wait for my approval</option>
                </select>
                <Button size="sm">Save</Button>
              </form>
            </CardHeader>
            {lessons.length === 0 ? (
              <Empty title="Nothing learned yet">
                Lessons appear after the first cycle — one per root cause the learner finds in heals, revisions and
                defects.
              </Empty>
            ) : (
              <ul className="divide-y divide-line-soft">
                {lessons.map((l) => (
                  <li key={l.id} className={`px-4 py-3 ${l.status === "retired" || l.status === "rejected" ? "opacity-55" : ""}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="font-mono text-[12px] font-semibold">{l.key}</code>
                      <Pill tone="accent" dot={false}>→ {l.scope}</Pill>
                      <Pill tone={l.category === "review" ? "fail" : l.category === "coverage" ? "live" : "heal"} dot={false}>
                        {l.category}
                      </Pill>
                      {l.status !== "active" && (
                        <Pill tone={l.status === "proposed" ? "heal" : "idle"}>
                          {l.status === "proposed" ? "awaiting approval" : l.status}
                        </Pill>
                      )}
                      <div className="ml-auto flex items-center gap-1">
                        {l.status === "proposed" && (
                          <>
                            <form action={reviewLesson.bind(null, l.id, "approve")}>
                              <Button variant="primary" size="sm">Approve</Button>
                            </form>
                            <form action={reviewLesson.bind(null, l.id, "reject")}>
                              <Button size="sm" title="The learner will not propose it again">Reject</Button>
                            </form>
                          </>
                        )}
                        <form action={forgetLesson.bind(null, l.id)}>
                          <Button variant="ghost" size="sm" title="Delete it; the learner may learn it again">
                            Forget
                          </Button>
                        </form>
                      </div>
                    </div>
                    <p className="mt-1.5 text-[12.5px] leading-[1.55]">{l.rule}</p>
                    {l.events.length > 1 && <History events={l.events.map((e) => ({ kind: e.kind, confidence: e.confidence, at: e.at.toISOString(), note: e.note }))} />}
                    <div className="mt-2 grid grid-cols-[1fr_auto] items-center gap-3">
                      <Meter value={l.confidence * 100} tone={l.confidence >= 0.7 ? "pass" : l.confidence >= 0.4 ? "accent" : "heal"} />
                      <span className="font-mono text-[11px] text-muted">
                        {l.confidence.toFixed(2)} · seen {l.hits}× · applied {l.applied}× · held {l.confirmed}×
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* ---------------------------------------------------------- cycles -- */}
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
        </div>
      </Pane>
    </>
  );
}
