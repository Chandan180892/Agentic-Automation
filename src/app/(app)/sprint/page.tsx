import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { redirect } from "next/navigation";
import { parseJson, fmtDate } from "@/lib/utils";
import { PageBar, Pane } from "@/components/page-bar";
import { Card, CardHeader, CardBody, Pill, Label, Sub, Meter, Stat, StatRow, Button, Empty, buttonClass } from "@/components/ui";
import { agentsAreLive } from "@/lib/agents/runtime";
import { createSprint, planSprint, runSprintPipelines, toggleStory, deleteStory, runStoryPipeline, addStory, importFromJira } from "../actions";
import { jiraConfigured } from "@/lib/atlassian/config";
import { AddStoryPanel } from "./add-story";
import type * as S from "@/lib/agents/schemas";
import type { z } from "zod";

export const metadata: Metadata = { title: "Sprint planner" };
export const dynamic = "force-dynamic";

type Plan = z.infer<typeof S.SprintPlannerOut> & { mode?: string; runId?: string };

export default async function SprintPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; new?: string }>;
}) {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace } = ctx;
  const { id, new: wantsNew } = await searchParams;

  const sprint = wantsNew
    ? null
    : id
    ? await db.sprint.findFirst({
        where: { id, workspaceId: workspace.id },
        include: { stories: { orderBy: [{ priority: "asc" }, { createdAt: "asc" }] } },
      })
    : await db.sprint.findFirst({
        where: { workspaceId: workspace.id },
        orderBy: { createdAt: "desc" },
        include: { stories: { orderBy: [{ priority: "asc" }, { createdAt: "asc" }] } },
      });

  const [live, allSprints] = await Promise.all([
    db.run.count({ where: { workspaceId: workspace.id, status: "running" } }),
    db.sprint.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true },
    }),
  ]);

  if (!sprint) return <NewSprint live={live} />;

  const committed = sprint.stories.filter((s) => s.committed);
  const points = committed.reduce((n, s) => n + (s.points ?? 0), 0);
  const noAc = sprint.stories.filter((s) => parseJson<string[]>(s.acceptanceCriteria, []).length === 0);
  const specced = sprint.stories.filter((s) => s.status !== "todo");
  const plan = parseJson<Plan | null>(sprint.planJson, null);
  const usage = sprint.capacityPoints ? Math.round((points / sprint.capacityPoints) * 100) : 0;

  return (
    <>
      <PageBar crumb={`${workspace.slug} / ${sprint.name}`} title="Sprint planner" live={live}>
        {allSprints.length > 1 && (
          <nav className="flex flex-wrap items-center gap-1.5">
            {allSprints.map((s) => (
              <Link
                key={s.id}
                href={`/sprint?id=${s.id}`}
                aria-current={s.id === sprint.id ? "page" : undefined}
                className={`rounded-full border px-2.5 py-[3px] text-[11.5px] font-semibold transition-colors ${
                  s.id === sprint.id
                    ? "border-ink bg-ink text-ground"
                    : "border-line bg-surface text-ink-2 hover:border-accent-line hover:text-ink"
                }`}
              >
                {s.name}
              </Link>
            ))}
          </nav>
        )}
        <Link href="/sprint?new=1" className={buttonClass("default", "md")}>
          New sprint
        </Link>
        <form action={planSprint.bind(null, sprint.id)}>
          <Button type="submit">Run sprint-planner</Button>
        </form>
        <form action={runSprintPipelines.bind(null, sprint.id)}>
          <Button type="submit" variant="primary">Run pipeline →</Button>
        </form>
      </PageBar>

      <Pane>
        {!agentsAreLive() && (
          <div className="mb-4 rounded-[10px] border border-heal/30 bg-heal-soft px-4 py-3">
            <p className="text-[12.5px] leading-[1.6] text-heal">
              <b>Simulator mode.</b> No <code className="font-mono">ANTHROPIC_API_KEY</code> is set, so
              agents return deterministic stand-in results instead of calling a model. Everything else —
              storage, jobs, runners, review — is real. Set the key and restart to go live.
            </p>
          </div>
        )}

        <StatRow>
          <Stat
            value={points}
            label="Points committed"
            detail={<span className={points > sprint.capacityPoints ? "text-fail" : "text-muted"}>of {sprint.capacityPoints} capacity</span>}
          />
          <Stat value={committed.length} label="Stories committed" detail={<span className="text-muted">{sprint.stories.length} in backlog</span>} />
          <Stat
            value={noAc.length}
            label="Missing acceptance criteria"
            tone={noAc.length ? "heal" : undefined}
            detail={<span className="text-muted">{noAc.length ? "planner will draft them" : "all specified"}</span>}
          />
          <Stat value={specced.length} label="Stories specced" detail={<span className="text-muted">{fmtDate(sprint.startsAt)} – {fmtDate(sprint.endsAt)}</span>} />
        </StatRow>

        <div className="mt-4 grid items-start gap-4 xl:grid-cols-[1fr_372px]">
          <Card>
            <CardHeader title={`${sprint.name} backlog`}>
              <Pill tone="idle" dot={false}>
                {fmtDate(sprint.startsAt)} – {fmtDate(sprint.endsAt)}
              </Pill>
              <div className="ml-auto" />
              {jiraConfigured() && (
                <form action={importFromJira} className="flex items-center gap-1.5">
                  <input type="hidden" name="sprintId" value={sprint.id} />
                  <input
                    name="projectKey"
                    defaultValue={workspace.jiraProjectKey}
                    placeholder="PAY"
                    aria-label="Jira project key"
                    className="w-[74px] rounded-[7px] border border-line bg-surface px-2 py-[5px] font-mono text-[11.5px] uppercase outline-none focus:border-accent-line"
                  />
                  <Button type="submit" size="sm">Import from Jira</Button>
                </form>
              )}
              <AddStoryPanel sprintId={sprint.id} action={addStory} />
            </CardHeader>

            {sprint.stories.length === 0 ? (
              <Empty title="No stories yet">
                Add one above, or start a new sprint with the sample payments backlog to see the agents
                work end to end.
              </Empty>
            ) : (
              <ul>
                {sprint.stories.map((s) => {
                  const ac = parseJson<string[]>(s.acceptanceCriteria, []);
                  const tags = parseJson<string[]>(s.tagsJson, []);
                  return (
                    <li
                      key={s.id}
                      className="grid grid-cols-[auto_1fr_auto] items-start gap-3 border-b border-line-soft px-4 py-3 transition-colors last:border-b-0 hover:bg-surface-2"
                    >
                      <form action={toggleStory.bind(null, s.id, !s.committed)} className="pt-0.5">
                        <button
                          type="submit"
                          role="checkbox"
                          aria-checked={s.committed}
                          aria-label={s.committed ? `Drop ${s.key} from the sprint` : `Commit ${s.key} to the sprint`}
                          className={`grid size-4 place-items-center rounded-[5px] border-[1.5px] ${
                            s.committed ? "border-accent bg-accent" : "border-line"
                          }`}
                        >
                          {s.committed && (
                            <svg viewBox="0 0 12 12" className="size-2.5 fill-none stroke-[var(--accent-ink)] stroke-[2]" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M2 6.2 4.6 8.8 10 3.4" />
                            </svg>
                          )}
                        </button>
                      </form>

                      <div className="min-w-0">
                        <div className="font-mono text-[11px] font-medium text-muted">
                          {s.jiraUrl ? (
                            <a href={s.jiraUrl} target="_blank" rel="noreferrer" className="hover:underline">
                              {s.key} ↗
                            </a>
                          ) : (
                            s.key
                          )}
                        </div>
                        <div className="mt-px text-[13.5px] font-semibold leading-[1.4]">{s.title}</div>
                        {s.description && (
                          <p className="mt-1 line-clamp-2 text-[12px] leading-[1.5] text-muted">{s.description}</p>
                        )}
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {ac.length ? (
                            <Pill tone="pass">{ac.length} acceptance criteria</Pill>
                          ) : (
                            <Pill tone="heal">no acceptance criteria</Pill>
                          )}
                          {tags.includes("ac-drafted-by-agent") && <Pill tone="heal">AC drafted by agent</Pill>}
                          {s.status !== "todo" && <Pill tone="accent">{s.status}</Pill>}
                          {!s.committed && <Pill tone="idle">not committed</Pill>}
                        </div>
                      </div>

                      <div className="flex items-center gap-2 pt-0.5">
                        <span className="min-w-[30px] text-right font-mono text-[12.5px] font-semibold text-ink-2">
                          {s.points ?? "—"}
                          <span className="text-[10px] text-muted"> pt</span>
                        </span>
                        <form action={runStoryPipeline.bind(null, s.id)}>
                          <Button type="submit" size="sm" title="Run the qe-pipeline on this story">
                            Pipeline
                          </Button>
                        </form>
                        <form action={deleteStory.bind(null, s.id)}>
                          <Button type="submit" size="sm" variant="ghost" aria-label={`Delete ${s.key}`}>
                            ✕
                          </Button>
                        </form>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <div className="grid gap-4">
            <Card>
              <CardHeader title="sprint-planner">
                {plan ? <Pill tone="pass">Proposal applied</Pill> : <Pill tone="idle">Not run yet</Pill>}
              </CardHeader>
              <CardBody className="grid gap-3.5">
                {plan ? (
                  <>
                    <div className="rounded-r-lg border border-l-2 border-line-soft border-l-accent bg-surface-2 px-3.5 py-3 text-[12.5px] leading-[1.6] text-ink-2">
                      {plan.summary}
                    </div>
                    <div className="grid gap-2">
                      <div className="flex justify-between text-[12.5px]">
                        <span>Team capacity</span>
                        <b className="font-mono">{sprint.capacityPoints} pts</b>
                      </div>
                      <Meter value={usage} tone={usage > 100 ? "heal" : "accent"} />
                      <div className="flex justify-between text-[12.5px] text-muted">
                        <span>
                          Committed {points} · {sprint.capacityPoints - points} pts headroom
                        </span>
                        <b className="font-mono">{usage}%</b>
                      </div>
                    </div>
                    {plan.risks?.length > 0 && (
                      <>
                        <hr className="border-line-soft" />
                        <div className="grid gap-2">
                          <Label>Risks it flagged</Label>
                          <ul className="grid gap-1.5">
                            {plan.risks.map((r, i) => (
                              <li key={i} className="flex gap-2 text-[12px] leading-[1.5]">
                                <Pill tone={r.level === "high" ? "fail" : r.level === "medium" ? "heal" : "idle"}>
                                  {r.level}
                                </Pill>
                                <span className="flex-1 text-ink-2">{r.message}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </>
                    )}
                    {plan.runId && (
                      <Link href={`/runs/${plan.runId}`} className="text-[12px] font-semibold text-accent hover:underline">
                        Open the run log →
                      </Link>
                    )}
                  </>
                ) : (
                  <>
                    <Sub>
                      sprint-planner sizes anything unestimated, orders by dependency, and commits only
                      what your velocity supports. It drafts acceptance criteria where they are missing
                      rather than guessing quietly.
                    </Sub>
                    <form action={planSprint.bind(null, sprint.id)}>
                      <Button type="submit" variant="primary" className="w-full">
                        Plan this sprint
                      </Button>
                    </form>
                  </>
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Hand off to" />
              <CardBody className="grid gap-2.5">
                <div className="flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-muted">
                  <span className="rounded-[5px] border border-line-soft bg-surface-3 px-1.5 py-0.5">Jira story</span>
                  <span className="text-accent-line">→</span>
                  <span className="rounded-[5px] border border-line-soft bg-surface-3 px-1.5 py-0.5">6 sub-agents</span>
                  <span className="text-accent-line">→</span>
                  <span className="rounded-[5px] border border-line-soft bg-surface-3 px-1.5 py-0.5">Xray + Bitbucket</span>
                </div>
                <Sub>
                  Each committed story walks the same chain: story-analyzer, clarify, asset-resolver,
                  spec-author, verifier, reviewer. Nothing reaches Xray or Bitbucket until you approve
                  it. One story at a time via <b>Pipeline</b> on its row.
                </Sub>
                <form action={runSprintPipelines.bind(null, sprint.id)}>
                  <Button type="submit" className="w-full">Run all {committed.length} stories</Button>
                </form>
              </CardBody>
            </Card>
          </div>
        </div>
      </Pane>
    </>
  );
}

function NewSprint({ live }: { live: number }) {
  return (
    <>
      <PageBar crumb="workspace / new" title="Sprint planner" live={live} />
      <Pane>
        <div className="mx-auto max-w-[560px] pt-6">
          <Card className="blueprint">
            <CardHeader title="Start your first sprint" />
            <CardBody>
              <form action={createSprint} className="grid gap-4">
                <label className="grid gap-1.5">
                  <Label>Sprint name</Label>
                  <input
                    name="name"
                    defaultValue="Sprint 24"
                    className="rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px] outline-none focus:border-accent-line"
                  />
                </label>
                <label className="grid gap-1.5">
                  <Label>Team capacity (points)</Label>
                  <input
                    name="capacity"
                    type="number"
                    min={1}
                    defaultValue={34}
                    className="rounded-lg border border-line bg-surface px-3 py-2 font-mono text-[13.5px] outline-none focus:border-accent-line"
                  />
                </label>
                <label className="flex items-start gap-2.5 rounded-lg border border-line bg-surface-2 p-3">
                  <input name="seed" type="checkbox" defaultChecked className="mt-0.5 accent-[var(--accent)]" />
                  <span>
                    <span className="block text-[13px] font-semibold">Load the sample payments backlog</span>
                    <span className="block text-[12px] leading-[1.5] text-muted">
                      Seven real stories, two of them deliberately missing acceptance criteria, so you can
                      watch sprint-planner refuse to guess.
                    </span>
                  </span>
                </label>
                <Button type="submit" variant="primary" className="justify-center py-2.5">
                  Create sprint
                </Button>
              </form>
            </CardBody>
          </Card>
        </div>
      </Pane>
    </>
  );
}
