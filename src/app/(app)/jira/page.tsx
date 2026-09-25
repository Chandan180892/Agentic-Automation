import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { relTime } from "@/lib/utils";
import { PageBar, Pane } from "@/components/page-bar";
import { Card, CardHeader, CardBody, Pill, Sub, Button, Label, Empty } from "@/components/ui";
import { jiraConfigured, jiraConfig, xrayConfigured } from "@/lib/atlassian/config";
import { agentsAreLive } from "@/lib/agents/runtime";
import { automateJiraStory } from "../actions";

export const metadata: Metadata = { title: "Jira" };
export const dynamic = "force-dynamic";

const field =
  "rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[12.5px] outline-none focus:border-accent-line";

const RUN_TONE = { running: "live", queued: "idle", needs_review: "pass", blocked: "heal", failed: "fail", succeeded: "pass" } as const;
const KIND_TONE: Record<string, "pass" | "fail" | "heal" | "idle"> = { positive: "pass", negative: "fail", edge: "heal" };

async function connection(linkType: string) {
  const { myself, linkTypeExists } = await import("@/lib/atlassian/jira");
  const out: { jira: string; jiraOk: boolean; xray: string; xrayOk: boolean; link: string; linkOk: boolean } = {
    jira: "",
    jiraOk: false,
    xray: "",
    xrayOk: false,
    link: "",
    linkOk: false,
  };
  try {
    const me = await myself();
    out.jiraOk = true;
    out.jira = `${me.displayName} on ${new URL(jiraConfig().baseUrl).host}`;
  } catch (err) {
    out.jira = err instanceof Error ? err.message.slice(0, 160) : "unreachable";
  }
  if (out.jiraOk) {
    try {
      out.linkOk = await linkTypeExists(linkType);
      out.link = out.linkOk ? `"${linkType}" link type found` : `no "${linkType}" link type — set the right one in Settings`;
    } catch {
      out.link = "could not read link types";
    }
  }
  if (xrayConfigured()) {
    try {
      const { xrayAuthOk } = await import("@/lib/atlassian/xray");
      out.xrayOk = await xrayAuthOk();
      out.xray = "API key accepted";
    } catch (err) {
      out.xray = err instanceof Error ? err.message.slice(0, 160) : "rejected";
    }
  } else out.xray = "XRAY_CLIENT_ID / XRAY_CLIENT_SECRET not set — tests can be proposed but not created";
  return out;
}

export default async function JiraPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace } = ctx;
  const sp = await searchParams;
  const project = (sp.project ?? workspace.jiraProjectKey ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "");
  const q = (sp.q ?? "").slice(0, 120);
  const key = (sp.key ?? "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");

  if (!jiraConfigured()) {
    return (
      <>
        <PageBar crumb={`${workspace.slug} / jira`} title="Jira" />
        <Pane>
          <Card className="max-w-[760px]">
            <CardHeader title="Connect Jira and Xray" />
            <CardBody className="grid gap-3 text-[13px] leading-[1.6]">
              <p>
                Set these on the server (Render → Environment, or your <code>.env</code>) and restart. Credentials stay on the
                server; nothing is stored in the browser.
              </p>
              <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[12px] leading-[1.7]">{`JIRA_BASE_URL="https://your-site.atlassian.net"
JIRA_EMAIL="you@company.com"
JIRA_API_TOKEN="…"          # id.atlassian.com → Security → API tokens

XRAY_CLIENT_ID="…"          # Jira → Apps → Xray → API Keys
XRAY_CLIENT_SECRET="…"`}</pre>
              <Sub>
                The token acts as that person, so use an account that can read the projects you automate and create issues
                in them.
              </Sub>
            </CardBody>
          </Card>
        </Pane>
      </>
    );
  }

  const { searchStories, fetchStory } = await import("@/lib/atlassian/jira");
  const conn = await connection(workspace.testLinkType || "Test");

  let results: Awaited<ReturnType<typeof searchStories>> = [];
  let searchError = "";
  if (conn.jiraOk && (project || q)) {
    try {
      results = await searchStories({ projectKey: project, text: q, limit: 30 });
    } catch (err) {
      searchError = err instanceof Error ? err.message : String(err);
    }
  }

  let story: Awaited<ReturnType<typeof fetchStory>> | null = null;
  let storyError = "";
  if (conn.jiraOk && key) {
    try {
      story = await fetchStory(key);
    } catch (err) {
      storyError = err instanceof Error ? err.message : String(err);
    }
  }
  const pastRuns = story
    ? await db.run.findMany({
        where: { workspaceId: workspace.id, agent: "qe-pipeline", story: { key: story.key } },
        orderBy: { startedAt: "desc" },
        take: 5,
        select: { id: true, status: true, startedAt: true },
      })
    : [];

  const qs = (extra: Record<string, string>) =>
    `?${new URLSearchParams({ ...(project ? { project } : {}), ...(q ? { q } : {}), ...extra }).toString()}`;

  return (
    <>
      <PageBar crumb={`${workspace.slug} / jira`} title="Jira">
        {!agentsAreLive() && <Pill tone="heal">agents on simulator</Pill>}
      </PageBar>
      <Pane>
        {/* ------------------------------------------------------ connection -- */}
        <div className="mb-4 flex flex-wrap gap-2">
          <Pill tone={conn.jiraOk ? "pass" : "fail"}>Jira · {conn.jira}</Pill>
          <Pill tone={conn.xrayOk ? "pass" : "heal"}>Xray · {conn.xray}</Pill>
          {conn.link && <Pill tone={conn.linkOk ? "pass" : "heal"}>{conn.link}</Pill>}
        </div>

        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          {/* ---------------------------------------------------------- search -- */}
          <Card>
            <CardHeader title="Find a story" />
            <CardBody>
              <form method="get" className="flex flex-wrap items-end gap-2">
                <label className="grid gap-1">
                  <Label>Project</Label>
                  <input name="project" defaultValue={project} placeholder="GTPASRS" className={`${field} w-[130px]`} />
                </label>
                <label className="grid min-w-[200px] flex-1 gap-1">
                  <Label>Text or issue key</Label>
                  <input name="q" defaultValue={q} placeholder="FlexBin, or GTPASRS-3574" className={field} />
                </label>
                <Button type="submit" variant="primary">
                  Search
                </Button>
              </form>
              <Sub className="mt-2">Without text, shows the project&apos;s open stories, most recently updated first.</Sub>
            </CardBody>
            {searchError && <p className="px-4 pb-4 text-[12.5px] text-fail">{searchError}</p>}
            {results.length > 0 ? (
              <ul className="divide-y divide-line-soft border-t border-line-soft">
                {results.map((r) => (
                  <li key={r.key}>
                    <Link
                      href={qs({ key: r.key })}
                      className={`grid gap-1 px-4 py-2.5 transition-colors hover:bg-surface-2 ${r.key === key ? "bg-accent-soft" : ""}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <b className="font-mono text-[12px]">{r.key}</b>
                        <span className="min-w-0 flex-1 truncate text-[12.5px]">{r.summary}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Pill tone="idle" dot={false}>{r.status}</Pill>
                        {r.priority && <Pill tone="idle" dot={false}>{r.priority}</Pill>}
                        <Pill tone={r.criteriaCount ? "accent" : "heal"} dot={false}>
                          {r.criteriaCount ? `${r.criteriaCount} AC` : "no AC"}
                        </Pill>
                        <Pill tone={r.linkedTests ? "pass" : "idle"} dot={false}>
                          {r.linkedTests} Xray test{r.linkedTests === 1 ? "" : "s"}
                        </Pill>
                        {r.storyPoints != null && <span className="font-mono text-[11px] text-muted">{r.storyPoints} pts</span>}
                        <span className="ml-auto font-mono text-[11px] text-muted">{r.updated ? relTime(new Date(r.updated)) : ""}</span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              (project || q) &&
              !searchError && <Empty title="No matching stories">Try another project key or search text.</Empty>
            )}
          </Card>

          {/* ----------------------------------------------------------- story -- */}
          {storyError ? (
            <Card>
              <CardBody className="text-[12.5px] text-fail">{storyError}</CardBody>
            </Card>
          ) : story ? (
            <Card>
              <CardHeader
                title={
                  <span>
                    <span className="font-mono">{story.key}</span> · {story.summary}
                  </span>
                }
              >
                <a href={story.url} target="_blank" rel="noreferrer" className="ml-auto text-[12px] font-semibold text-accent hover:underline">
                  Open in Jira ↗
                </a>
              </CardHeader>
              <CardBody className="grid gap-4">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill tone="idle" dot={false}>{story.issueType}</Pill>
                  <Pill tone="idle" dot={false}>{story.status}</Pill>
                  {story.priority && <Pill tone="idle" dot={false}>{story.priority}</Pill>}
                  {story.storyPoints != null && <Pill tone="idle" dot={false}>{story.storyPoints} pts</Pill>}
                  {story.sprint && <Pill tone="idle" dot={false}>{story.sprint}</Pill>}
                  {story.parent && (
                    <Pill tone="accent" dot={false}>
                      {story.parent.key} {story.parent.summary.slice(0, 40)}
                    </Pill>
                  )}
                </div>

                <form action={automateJiraStory.bind(null, story.key)} className="flex flex-wrap items-center gap-3 rounded-[10px] border border-accent-line bg-accent-soft px-3.5 py-3">
                  <div className="min-w-0 flex-1 text-[12.5px] leading-[1.5] text-ink-2">
                    The agents analyse it, choose a test strategy, write specs and Xray tests, verify and review them, and
                    write a test report. Nothing is written to Jira, Xray or Bitbucket until an admin approves it.
                  </div>
                  <Button variant="primary" type="submit">
                    Automate this story →
                  </Button>
                </form>

                <section>
                  <Label>Acceptance criteria ({story.acceptanceCriteria.length})</Label>
                  {story.acceptanceCriteria.length ? (
                    <ol className="mt-1.5 grid list-decimal gap-1.5 pl-5 text-[12.5px] leading-[1.55]">
                      {story.acceptanceCriteria.map((c, i) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ol>
                  ) : (
                    <Sub className="mt-1">None found — story-analyzer will ask for them rather than guess.</Sub>
                  )}
                </section>

                {story.testCriteria && (
                  <section>
                    <Label>Test criteria (team notes)</Label>
                    <pre className="mt-1.5 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 font-sans text-[12px] leading-[1.55]">
                      {story.testCriteria}
                    </pre>
                  </section>
                )}

                <section>
                  <Label>Xray tests already linked ({story.linkedTests.length})</Label>
                  {story.linkedTests.length ? (
                    <ul className="mt-1.5 grid gap-1">
                      {story.linkedTests.map((t) => (
                        <li key={t.key} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                          <span className="font-mono text-[11.5px]">{t.key}</span>
                          {t.kind && <Pill tone={KIND_TONE[t.kind] ?? "idle"} dot={false}>{t.kind}</Pill>}
                          <span className="min-w-0 flex-1 truncate">{t.summary.replace(/^\s*\[[^\]]+\]\s*/, "")}</span>
                          <span className="text-[11px] text-muted">{t.status}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Sub className="mt-1">None yet.</Sub>
                  )}
                </section>

                {story.comments.length > 0 && (
                  <section>
                    <Label>Recent comments</Label>
                    <ul className="mt-1.5 grid gap-2">
                      {story.comments.slice(-4).map((c, i) => (
                        <li key={i} className="text-[12px] leading-[1.55]">
                          <b>{c.author}</b> <span className="text-muted">{c.created.slice(0, 10)}</span>
                          <p className="whitespace-pre-wrap text-ink-2">{c.text.slice(0, 500)}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {pastRuns.length > 0 && (
                  <section>
                    <Label>Earlier runs</Label>
                    <ul className="mt-1.5 grid gap-1">
                      {pastRuns.map((r) => (
                        <li key={r.id} className="flex items-center gap-2 text-[12.5px]">
                          <Pill tone={RUN_TONE[r.status as keyof typeof RUN_TONE] ?? "idle"}>{r.status.replace("_", " ")}</Pill>
                          <Link href={`/runs/${r.id}`} className="font-semibold text-accent hover:underline">
                            Open run
                          </Link>
                          <span className="font-mono text-[11px] text-muted">{relTime(r.startedAt)}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </CardBody>
            </Card>
          ) : (
            <Card>
              <Empty title="Pick a story">
                Search on the left, then choose a story to see its live criteria, test notes, comments and the Xray tests
                already linked to it.
              </Empty>
            </Card>
          )}
        </div>
      </Pane>
    </>
  );
}
