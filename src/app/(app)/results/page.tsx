import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { parseJson, relTime } from "@/lib/utils";
import { PageBar, Pane } from "@/components/page-bar";
import { Card, CardHeader, CardBody, Pill, Sub, Stat, StatRow, Button, Empty, Meter } from "@/components/ui";
import { healJob, batchHeal, applyPatch, runInsights } from "../actions";

export const metadata: Metadata = { title: "Results & heal" };
export const dynamic = "force-dynamic";

function Diff({ text }: { text: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-line-soft bg-surface-2 font-mono text-[11.5px]">
      {text.split("\n").map((line, i) => {
        const add = line.startsWith("+") && !line.startsWith("+++");
        const del = line.startsWith("-") && !line.startsWith("---");
        return (
          <div
            key={i}
            className={`whitespace-pre-wrap break-words px-3 py-[3px] ${
              add ? "bg-pass-soft text-pass" : del ? "bg-fail-soft text-fail" : "text-muted"
            }`}
          >
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

export default async function ResultsPage() {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace } = ctx;

  const [jobs, patchAssets, live] = await Promise.all([
    db.job.findMany({
      where: { run: { workspaceId: workspace.id } },
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { story: { select: { key: true, title: true } }, run: { select: { agent: true } } },
    }),
    db.asset.findMany({
      where: { kind: "patch", job: { run: { workspaceId: workspace.id } } },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { job: { select: { runId: true, run: { select: { agent: true, status: true } } } } },
    }),
    db.run.count({ where: { workspaceId: workspace.id, status: "running" } }),
  ]);

  const executed = jobs.filter((j) => j.status === "passed" || j.status === "failed");
  const passed = executed.filter((j) => j.status === "passed");
  const failed = jobs.filter((j) => j.status === "failed");
  const healed = jobs.filter((j) => j.kind === "heal" && j.status === "passed");
  const rate = executed.length ? Math.round((passed.length / executed.length) * 1000) / 10 : 0;

  return (
    <>
      <PageBar crumb={`${workspace.slug} / results`} title="Results & heal" live={live}>
        {executed.length > 0 && (
          <form action={runInsights}>
            <Button type="submit">Run qe-insights</Button>
          </form>
        )}
        {failed.length > 0 && (
          <form action={batchHeal}>
            <Button type="submit" variant="primary">
              Run batch-heal on {failed.length}
            </Button>
          </form>
        )}
      </PageBar>

      <Pane>
        <StatRow>
          <Stat value={executed.length} label="Jobs executed" detail={<span className="text-muted">all time</span>} />
          <Stat value={passed.length} label="Passing" tone="pass" detail={<span className="text-pass">{rate}%</span>} />
          <Stat
            value={failed.length}
            label="Failing"
            tone={failed.length ? "fail" : undefined}
            detail={<span className="text-muted">{patchAssets.length} have a proposed patch</span>}
          />
          <Stat value={healed.length} label="Heal runs" tone={healed.length ? "heal" : undefined} detail={<span className="text-muted">patches awaiting review</span>} />
        </StatRow>

        <div className="mt-4 grid items-start gap-4 xl:grid-cols-[1fr_372px]">
          <Card>
            <CardHeader title="Proposed patches">
              <Pill tone={patchAssets.length ? "heal" : "idle"}>
                {patchAssets.length ? "awaiting review" : "nothing pending"}
              </Pill>
            </CardHeader>
            <CardBody className="grid gap-4">
              {patchAssets.length === 0 ? (
                <Empty title="No patches proposed">
                  When a spec fails, qe-auto-heal reads the failure, the diff behind it, and the spec,
                  then proposes the smallest change — or refuses and says the application is what needs
                  fixing.
                </Empty>
              ) : (
                patchAssets.map((a) => (
                  <div key={a.id} className="grid gap-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12px] font-semibold">{a.path}</span>
                      <Pill tone="heal">{a.job.run.agent}</Pill>
                      <div className="ml-auto flex items-center gap-2">
                        <Link
                          href={`/runs/${a.job.runId}`}
                          className="text-[12px] font-semibold text-accent hover:underline"
                        >
                          Open run →
                        </Link>
                        <form action={applyPatch.bind(null, a.id)}>
                          <Button type="submit" size="sm" variant="primary">
                            Apply &amp; re-run
                          </Button>
                        </form>
                      </div>
                    </div>
                    <Diff text={a.content} />
                  </div>
                ))
              )}
            </CardBody>
          </Card>

          <div className="grid gap-4">
            <Card>
              <CardHeader title="batch-heal">
                <Pill tone={failed.length ? "accent" : "idle"}>{failed.length} candidates</Pill>
              </CardHeader>
              <CardBody className="grid gap-3">
                <Sub>
                  When one change breaks many specs, batch-heal groups them by root cause, patches each
                  group once, re-runs them, and opens a single PR containing only the ones that went
                  green. Anything that would change an assertion is escalated instead.
                </Sub>
                {executed.length > 0 && (
                  <div className="grid gap-2">
                    <div className="flex justify-between text-[12.5px]">
                      <span className="text-muted">Green</span>
                      <b className="font-mono text-pass">
                        {passed.length} / {executed.length}
                      </b>
                    </div>
                    <Meter value={rate} tone="pass" />
                  </div>
                )}
                <form action={batchHeal}>
                  <Button type="submit" variant="primary" className="w-full justify-center" disabled={failed.length === 0}>
                    {failed.length ? `Heal ${failed.length} failing jobs` : "Nothing to heal"}
                  </Button>
                </form>
                <p className="text-[11.5px] leading-[1.6] text-muted">
                  Gantry will not rewrite an expectation to make a test pass. A failure where the
                  assertion is still correct is reported as an application bug.
                </p>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Recent jobs" />
              <CardBody className="grid gap-2">
                {jobs.length === 0 ? (
                  <Sub>No jobs have run yet.</Sub>
                ) : (
                  jobs.slice(0, 10).map((j) => (
                    <div
                      key={j.id}
                      className="flex items-center gap-2.5 rounded-lg border border-line-soft bg-surface-2 px-3 py-2"
                    >
                      <span className="truncate font-mono text-[11.5px] font-medium">
                        {j.story?.key ?? j.kind}
                      </span>
                      <Pill
                        tone={
                          j.status === "passed"
                            ? "pass"
                            : j.status === "failed"
                              ? "fail"
                              : j.status === "queued"
                                ? "idle"
                                : "live"
                        }
                        className="ml-auto shrink-0"
                      >
                        {j.status}
                      </Pill>
                      {j.status === "failed" && (
                        <form action={healJob.bind(null, j.id)}>
                          <Button type="submit" size="sm">Heal</Button>
                        </form>
                      )}
                      <span className="shrink-0 font-mono text-[10.5px] text-muted">{relTime(j.createdAt)}</span>
                    </div>
                  ))
                )}
              </CardBody>
            </Card>
          </div>
        </div>
      </Pane>
    </>
  );
}
