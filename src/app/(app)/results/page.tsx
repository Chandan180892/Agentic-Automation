import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { relTime, parseJson } from "@/lib/utils";
import { PageBar, Pane } from "@/components/page-bar";
import { Card, CardHeader, CardBody, Pill, Sub, Stat, StatRow, Button, Empty, Meter } from "@/components/ui";
import { publish, runInsights } from "../actions";

export const metadata: Metadata = { title: "Results" };
export const dynamic = "force-dynamic";

const RUN_TONE = {
  running: "live",
  succeeded: "pass",
  failed: "fail",
  needs_review: "heal",
  blocked: "heal",
  queued: "idle",
} as const;

const TARGET_LABEL: Record<string, string> = {
  "jira-comment": "Jira comment",
  "xray-tests": "Xray test cases",
  "bitbucket-branch": "Bitbucket branch & PR",
};

export default async function ResultsPage() {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace } = ctx;

  const [runs, pending, tests, live] = await Promise.all([
    db.run.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { startedAt: "desc" },
      take: 40,
      include: { story: { select: { key: true, title: true } }, stages: true, _count: { select: { testCases: true } } },
    }),
    db.publication.findMany({
      where: { run: { workspaceId: workspace.id }, status: { in: ["proposed", "failed"] } },
      orderBy: { createdAt: "desc" },
      include: { run: { include: { story: { select: { key: true } }, _count: { select: { testCases: true } } } } },
    }),
    db.testCase.count({ where: { run: { workspaceId: workspace.id } } }),
    db.run.count({ where: { workspaceId: workspace.id, status: "running" } }),
  ]);

  const published = await db.testCase.count({
    where: { run: { workspaceId: workspace.id }, published: true },
  });
  const pipelines = runs.filter((r) => r.agent === "qe-pipeline");
  const approved = pipelines.filter((r) => r.status === "needs_review").length;
  const blocked = pipelines.filter((r) => r.status === "blocked").length;
  const rate = pipelines.length ? Math.round((approved / pipelines.length) * 1000) / 10 : 0;

  return (
    <>
      <PageBar crumb={`${workspace.slug} / results`} title="Results" live={live}>
        {pipelines.length > 0 && (
          <form action={runInsights}>
            <Button type="submit">Run qe-insights</Button>
          </form>
        )}
      </PageBar>

      <Pane>
        <StatRow>
          <Stat value={pipelines.length} label="Pipeline runs" detail={<span className="text-muted">this workspace</span>} />
          <Stat value={approved} label="Reviewer approved" tone="pass" detail={<span className="text-pass">{rate}%</span>} />
          <Stat
            value={blocked}
            label="Blocked or needs answers"
            tone={blocked ? "heal" : undefined}
            detail={<span className="text-muted">{blocked ? "clarify is waiting" : "none waiting"}</span>}
          />
          <Stat value={`${published}/${tests}`} label="Test cases in Xray" detail={<span className="text-muted">published / generated</span>} />
        </StatRow>

        <div className="mt-4 grid items-start gap-4 xl:grid-cols-[1fr_372px]">
          <Card>
            <CardHeader title="Awaiting approval">
              <Pill tone={pending.length ? "heal" : "idle"}>
                {pending.length ? `${pending.length} proposal(s)` : "nothing pending"}
              </Pill>
            </CardHeader>
            <CardBody className="grid gap-2.5">
              {pending.length === 0 ? (
                <Empty title="Nothing waiting on you">
                  When a pipeline's reviewer approves its work, the Xray test cases and the Bitbucket
                  branch appear here as proposals. Nothing is written to your systems until you
                  approve them.
                </Empty>
              ) : (
                pending.map((p) => {
                  const payload = parseJson<Record<string, string>>(p.payloadJson, {});
                  return (
                    <div key={p.id} className="flex flex-wrap items-center gap-2.5 rounded-lg border border-line-soft bg-surface-2 px-3.5 py-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[12px] font-semibold">{p.run.story?.key ?? "run"}</span>
                          <Pill tone="accent" dot={false}>{TARGET_LABEL[p.target] ?? p.target}</Pill>
                          {p.status === "failed" && <Pill tone="fail">failed</Pill>}
                        </div>
                        <div className="mt-1 font-mono text-[11px] text-muted">
                          {p.target === "bitbucket-branch"
                            ? `${payload.workspace}/${payload.repo} · ${payload.branch}`
                            : p.target === "xray-tests"
                              ? `${p.run._count.testCases} test case(s) → ${payload.projectKey}`
                              : payload.issueKey}
                        </div>
                        {p.error && <div className="mt-1 text-[11.5px] text-fail">{p.error}</div>}
                      </div>
                      <div className="ml-auto flex items-center gap-2">
                        <Link href={`/runs/${p.runId}`} className="text-[12px] font-semibold text-accent hover:underline">
                          Review →
                        </Link>
                        <form action={publish.bind(null, p.id)}>
                          <Button type="submit" size="sm" variant="primary">
                            {p.status === "failed" ? "Retry" : "Approve & publish"}
                          </Button>
                        </form>
                      </div>
                    </div>
                  );
                })
              )}
            </CardBody>
          </Card>

          <div className="grid gap-4">
            <Card>
              <CardHeader title="Recent runs" />
              <CardBody className="grid gap-2">
                {runs.length === 0 ? (
                  <Sub>No runs yet. Start one from the sprint planner.</Sub>
                ) : (
                  runs.slice(0, 12).map((r) => {
                    const passed = r.stages.filter((s) => s.status === "passed").length;
                    return (
                      <Link
                        key={r.id}
                        href={`/runs/${r.id}`}
                        className="flex items-center gap-2.5 rounded-lg border border-line-soft bg-surface-2 px-3 py-2 transition-colors hover:border-accent-line"
                      >
                        <span className="truncate font-mono text-[11.5px] font-medium">
                          {r.story?.key ?? r.agent}
                        </span>
                        {r.stages.length > 0 && (
                          <span className="shrink-0 font-mono text-[10.5px] text-muted">{passed}/{r.stages.length}</span>
                        )}
                        <Pill tone={RUN_TONE[r.status as keyof typeof RUN_TONE] ?? "idle"} className="ml-auto shrink-0">
                          {r.status.replace("_", " ")}
                        </Pill>
                        <span className="shrink-0 font-mono text-[10.5px] text-muted">{relTime(r.startedAt)}</span>
                      </Link>
                    );
                  })
                )}
              </CardBody>
            </Card>

            {pipelines.length > 0 && (
              <Card>
                <CardHeader title="Reviewer pass rate" />
                <CardBody className="grid gap-2">
                  <div className="flex justify-between text-[12.5px]">
                    <span className="text-muted">Approved</span>
                    <b className="font-mono text-pass">{approved} / {pipelines.length}</b>
                  </div>
                  <Meter value={rate} tone="pass" />
                  <Sub className="mt-1">
                    A blocked run is not a failure — it means clarify found something a wrong guess
                    would have gotten wrong, and stopped to ask.
                  </Sub>
                </CardBody>
              </Card>
            )}
          </div>
        </div>
      </Pane>
    </>
  );
}
