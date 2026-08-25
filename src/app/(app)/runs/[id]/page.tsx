import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { relTime, parseJson } from "@/lib/utils";
import { PageBar, Pane } from "@/components/page-bar";
import { Card, CardHeader, CardBody, Pill, Sub, Button, Label } from "@/components/ui";
import { RunStream } from "./stream";
import { publish } from "../../actions";
import { SUB_AGENT_LIST } from "@/lib/agents/pipeline-registry";

export const metadata: Metadata = { title: "Run" };
export const dynamic = "force-dynamic";

const RUN_TONE = {
  running: "live",
  succeeded: "pass",
  failed: "fail",
  needs_review: "heal",
  blocked: "heal",
  queued: "idle",
} as const;

const STAGE_TONE = {
  passed: "pass",
  running: "live",
  blocked: "heal",
  failed: "fail",
  skipped: "idle",
  pending: "idle",
} as const;

const TARGET_LABEL: Record<string, string> = {
  "jira-comment": "Post questions to Jira",
  "xray-tests": "Create Xray test cases",
  "bitbucket-branch": "Commit branch & open PR in Bitbucket",
};

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace } = ctx;
  const { id } = await params;

  const run = await db.run.findFirst({
    where: { id, workspaceId: workspace.id },
    include: {
      story: true,
      sprint: { select: { name: true } },
      events: { orderBy: { ts: "asc" }, take: 800 },
      stages: { orderBy: { order: "asc" } },
      assets: { orderBy: { createdAt: "asc" } },
      testCases: { orderBy: { createdAt: "asc" } },
      publications: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!run) notFound();

  const isPipeline = run.agent === "qe-pipeline";
  const stages = run.stages.length
    ? run.stages
    : SUB_AGENT_LIST.map((a) => ({
        id: a.id,
        agent: a.id,
        order: a.order,
        status: "pending",
        summary: "",
        startedAt: null,
        finishedAt: null,
      }));
  const done = stages.filter((s) => s.status === "passed").length;
  const generated = run.assets.filter((a) => !a.reused);
  const reused = run.assets.filter((a) => a.reused);

  return (
    <>
      <PageBar
        crumb={`${workspace.slug} / runs / ${run.story?.key ?? run.agent}`}
        title={isPipeline ? `qe-pipeline · ${run.story?.key ?? ""}` : run.agent}
      >
        <Pill tone={RUN_TONE[run.status as keyof typeof RUN_TONE] ?? "idle"}>
          {run.status.replace("_", " ")}
        </Pill>
        {run.story?.jiraUrl && (
          <a href={run.story.jiraUrl} target="_blank" rel="noreferrer" className="text-[12px] font-semibold text-accent hover:underline">
            {run.story.key} in Jira ↗
          </a>
        )}
        <span className="font-mono text-[11.5px] text-muted">{relTime(run.startedAt)}</span>
      </PageBar>

      <Pane>
        {run.error && (
          <div className="mb-4 rounded-[10px] border border-heal/30 bg-heal-soft px-4 py-3">
            <p className="text-[12.5px] leading-[1.6] text-heal">{run.error}</p>
          </div>
        )}

        {isPipeline && (
          <Card className="mb-4">
            <CardHeader title="Pipeline">
              <Pill tone="idle" dot={false}>{done} / {stages.length} stages passed</Pill>
            </CardHeader>
            <CardBody className="blueprint">
              <ol className="flex items-stretch overflow-x-auto pb-2">
                {stages.map((s, i) => {
                  const meta = SUB_AGENT_LIST.find((m) => m.id === s.agent);
                  const tone = STAGE_TONE[s.status as keyof typeof STAGE_TONE] ?? "idle";
                  return (
                    <li key={s.order} className="flex items-center">
                      {i > 0 && (
                        <span className="grid w-6 shrink-0 place-items-center">
                          <svg viewBox="0 0 26 12" className="w-6 fill-none stroke-line stroke-[1.6]">
                            <path d="M0 6h20m-4-4 4 4-4 4" />
                          </svg>
                        </span>
                      )}
                      <div
                        className={`flex w-[172px] shrink-0 flex-col gap-1.5 rounded-[9px] border bg-surface px-3 py-2.5 ${
                          s.status === "running"
                            ? "border-live/45 shadow-[0_0_0_3px_var(--live-soft)]"
                            : s.status === "passed"
                              ? "border-pass/35"
                              : s.status === "pending"
                                ? "border-line opacity-55"
                                : "border-heal/40"
                        }`}
                      >
                        <span className="font-mono text-[11px] font-semibold">{s.agent}</span>
                        <span className="text-[11px] text-muted">{meta?.role ?? ""}</span>
                        <Pill tone={tone}>{s.status}</Pill>
                      </div>
                    </li>
                  );
                })}
              </ol>
              {stages.some((s) => s.summary) && (
                <ul className="mt-3 grid gap-1.5 border-t border-line-soft pt-3">
                  {stages
                    .filter((s) => s.summary)
                    .map((s) => (
                      <li key={s.order} className="flex gap-2.5 text-[12px] leading-[1.5]">
                        <span className="shrink-0 font-mono text-[11px] font-semibold text-muted">{s.agent}</span>
                        <span className="text-ink-2">{s.summary}</span>
                      </li>
                    ))}
                </ul>
              )}
            </CardBody>
          </Card>
        )}

        {run.publications.length > 0 && (
          <Card className="mb-4">
            <CardHeader title="Waiting for your approval">
              <Pill tone="heal">nothing is written until you approve</Pill>
            </CardHeader>
            <CardBody className="grid gap-2.5">
              {run.publications.map((p) => {
                const payload = parseJson<Record<string, string>>(p.payloadJson, {});
                const result = parseJson<{ pullRequest?: { url: string } }>(p.resultJson, {});
                return (
                  <div key={p.id} className="flex flex-wrap items-center gap-2.5 rounded-lg border border-line-soft bg-surface-2 px-3.5 py-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold">{TARGET_LABEL[p.target] ?? p.target}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-muted">
                        {p.target === "bitbucket-branch"
                          ? `${payload.workspace}/${payload.repo} · ${payload.branch} → ${payload.fromBranch}`
                          : p.target === "xray-tests"
                            ? `${run.testCases.length} test case(s) into ${payload.projectKey}`
                            : payload.issueKey}
                      </div>
                      {p.error && <div className="mt-1 text-[11.5px] text-fail">{p.error}</div>}
                    </div>
                    <div className="ml-auto flex items-center gap-2">
                      <Pill tone={p.status === "published" ? "pass" : p.status === "failed" ? "fail" : "heal"}>
                        {p.status}
                      </Pill>
                      {result.pullRequest?.url && (
                        <a href={result.pullRequest.url} target="_blank" rel="noreferrer" className="text-[12px] font-semibold text-accent hover:underline">
                          Open PR ↗
                        </a>
                      )}
                      {p.status !== "published" && (
                        <form action={publish.bind(null, p.id)}>
                          <Button type="submit" size="sm" variant="primary">
                            {p.status === "failed" ? "Retry" : "Approve & publish"}
                          </Button>
                        </form>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardBody>
          </Card>
        )}

        <div className="grid items-start gap-4 xl:grid-cols-[1fr_400px]">
          <RunStream runId={run.id} initial={run.events} finished={run.status !== "running"} />

          <div className="grid gap-4">
            {run.testCases.length > 0 && (
              <Card>
                <CardHeader title="Xray test cases">
                  <Pill tone="accent" dot={false}>{run.testCases.length}</Pill>
                </CardHeader>
                <CardBody className="grid gap-2">
                  {run.testCases.map((t) => {
                    const steps = parseJson<{ action: string; data: string; expected: string }[]>(t.stepsJson, []);
                    return (
                      <details key={t.id} className="rounded-lg border border-line-soft bg-surface-2">
                        <summary className="flex cursor-pointer list-none items-start gap-2.5 px-3 py-2.5">
                          <span className="min-w-0 flex-1">
                            <span className="block text-[12.5px] font-semibold leading-[1.4]">{t.summary}</span>
                            <span className="mt-0.5 block text-[11px] text-muted">covers: {t.criterion}</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            {t.xrayKey ? <Pill tone="pass">{t.xrayKey}</Pill> : <Pill tone="idle">{t.testType}</Pill>}
                          </span>
                        </summary>
                        <div className="border-t border-line-soft px-3 py-2.5">
                          {t.gherkin ? (
                            <pre className="whitespace-pre-wrap font-mono text-[11px] leading-[1.6] text-ink-2">{t.gherkin}</pre>
                          ) : (
                            <ol className="grid gap-2">
                              {steps.map((st, n) => (
                                <li key={n} className="grid gap-0.5 text-[11.5px] leading-[1.5]">
                                  <span className="font-semibold">{n + 1}. {st.action}</span>
                                  {st.data && <span className="font-mono text-[10.5px] text-muted">data: {st.data}</span>}
                                  <span className="text-muted">→ {st.expected}</span>
                                </li>
                              ))}
                            </ol>
                          )}
                        </div>
                      </details>
                    );
                  })}
                </CardBody>
              </Card>
            )}

            <Card>
              <CardHeader title="Files">
                <Pill tone="accent" dot={false}>{generated.length} new</Pill>
                {reused.length > 0 && <Pill tone="idle" dot={false}>{reused.length} reused</Pill>}
              </CardHeader>
              <CardBody className="grid gap-2">
                {generated.length === 0 && reused.length === 0 ? (
                  <Sub>Nothing written yet.</Sub>
                ) : (
                  <>
                    {generated.map((a) => (
                      <details key={a.id} className="rounded-lg border border-line-soft bg-surface-2">
                        <summary className="flex cursor-pointer list-none items-center gap-2.5 px-3 py-2.5">
                          <svg viewBox="0 0 24 24" className="size-[15px] shrink-0 fill-none stroke-muted stroke-[1.7]" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
                            <path d="M14 3v5h5" />
                          </svg>
                          <span className="truncate font-mono text-[11.5px] font-medium">{a.path}</span>
                          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">{a.kind}</span>
                        </summary>
                        <pre className="term term-text max-h-[340px] overflow-auto rounded-b-lg px-3 py-2.5 font-mono text-[11px] leading-[1.7]">
                          {a.content}
                        </pre>
                      </details>
                    ))}
                    {reused.length > 0 && (
                      <div className="mt-1 grid gap-1.5 border-t border-line-soft pt-2.5">
                        <Label>Reused from the repo</Label>
                        {reused.map((a) => (
                          <div key={a.id} className="truncate font-mono text-[11px] text-muted">{a.path}</div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Where this goes" />
              <CardBody className="grid gap-2.5">
                <Sub>
                  Gantry runs nothing itself. Specs land on a Bitbucket branch, test cases land in
                  Xray, and questions land as a Jira comment — each only after you approve it above.
                </Sub>
                <Link href="/settings" className="text-[12px] font-semibold text-accent hover:underline">
                  Integration settings →
                </Link>
              </CardBody>
            </Card>
          </div>
        </div>
      </Pane>
    </>
  );
}
