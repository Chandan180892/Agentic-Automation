import { db } from "@/lib/db";
import { parseJson } from "@/lib/utils";
import { campaignCycles, type Campaign } from "./autopilot";

/** The part of a cycle's state that changes while it runs. Shared by the page and the poll. */
export async function liveState(workspaceId: string, id: string, since: Date | null) {
  const run = await db.run.findFirst({
    where: { id, workspaceId, agent: "autopilot" },
    include: {
      stages: { orderBy: { order: "asc" } },
      children: {
        orderBy: { startedAt: "asc" },
        select: { id: true, agent: true, status: true, story: { select: { key: true } } },
      },
      publications: { where: { target: "jira-bug" }, select: { id: true, status: true, error: true, resultJson: true } },
    },
  });
  if (!run) return null;

  // gte rather than gt: two lines can share a millisecond. The client drops ids it already has.
  const events = await db.event.findMany({
    where: {
      runId: { in: [run.id, ...run.children.map((c) => c.id)] },
      ...(since && !Number.isNaN(since.getTime()) ? { ts: { gte: since } } : {}),
    },
    orderBy: { ts: "asc" },
    take: since ? 400 : 2000,
  });

  const campaign = parseJson<{ campaign: Campaign | null }>(run.inputJson, { campaign: null }).campaign;
  const cycles = campaign ? await campaignCycles(workspaceId, campaign.id) : [];
  const at = cycles.findIndex((c) => c.id === run.id);

  // Bugs proposed in earlier cycles live on those cycles' runs; look them up by id.
  const output = parseJson<{ bugs?: { publicationId: string }[] } | null>(run.outputJson, null);
  const pubIds = (output?.bugs ?? []).map((b) => b.publicationId).filter(Boolean);
  const pubs = pubIds.length
    ? await db.publication.findMany({ where: { id: { in: pubIds } }, select: { id: true, status: true, error: true, resultJson: true } })
    : run.publications;

  return {
    status: run.status,
    error: run.error,
    stopRequested: run.stopRequested,
    stages: run.stages.map((s) => ({ agent: s.agent, status: s.status, summary: s.summary })),
    output: parseJson(run.outputJson, null),
    children: run.children.map((c) => ({ id: c.id, agent: c.agent, status: c.status, storyKey: c.story?.key ?? "" })),
    events: events.map((e) => ({ id: e.id, ts: e.ts.toISOString(), level: e.level, source: e.source, message: e.message, runId: e.runId })),
    campaign: campaign
      ? {
          ...campaign,
          cycles: cycles.map((c) => ({ id: c.id, cycle: c.cycle, status: c.status, stable: c.stable })),
          next: at >= 0 ? (cycles[at + 1]?.id ?? null) : null,
        }
      : null,
    publications: Object.fromEntries(
      pubs.map((p) => [p.id, { status: p.status, error: p.error, key: parseJson<{ key?: string }>(p.resultJson, {}).key ?? "" }])
    ),
  };
}

export type LiveState = NonNullable<Awaited<ReturnType<typeof liveState>>>;
