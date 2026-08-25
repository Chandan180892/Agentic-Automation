"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { runAgentTracked, logEvent, finishRun, invokeAgent } from "@/lib/agents/runtime";
import { newRunnerToken } from "@/lib/crypto";
import { parseJson } from "@/lib/utils";
import type * as S from "@/lib/agents/schemas";
import type { z } from "zod";

type PlannerOut = z.infer<typeof S.SprintPlannerOut>;
type PipelinesOut = z.infer<typeof S.QePipelinesOut>;
type BatchOut = z.infer<typeof S.QeBatchOut>;
type HealOut = z.infer<typeof S.QeAutoHealOut>;
type BatchHealOut = z.infer<typeof S.BatchHealOut>;

async function ctx() {
  const c = await requireWorkspace();
  if (!c) redirect("/login");
  return c;
}

// --------------------------------------------------------------- sprint CRUD

const SEED_STORIES = [
  {
    key: "PAY-812",
    title: "Idempotency keys on checkout submit",
    description:
      "A double-click on Pay must not create two orders. The client sends an idempotency key; the server returns the original result for a repeat key.",
    acceptanceCriteria: [
      "Submitting the same idempotency key twice creates exactly one order.",
      "The second response returns the original order, not an error.",
      "A key expires after 24 hours and is then reusable.",
    ],
    points: 5,
  },
  {
    key: "PAY-806",
    title: "Retry a failed card authorisation once",
    description:
      "Transient gateway errors should be retried once before the customer sees a failure. Hard declines are never retried.",
    acceptanceCriteria: [
      "A 5xx from the gateway is retried exactly once.",
      "A hard decline is surfaced immediately with the decline reason.",
      "Retries reuse the original idempotency key.",
    ],
    points: 3,
  },
  {
    key: "PAY-830",
    title: "Partial refund for split-tender orders",
    description: "Orders paid with more than one instrument need refunds apportioned across them.",
    acceptanceCriteria: [],
    points: 8,
  },
  {
    key: "PAY-799",
    title: "Wallet balance reconciliation job",
    description: "Nightly job reconciles wallet balances against the ledger and reports drift.",
    acceptanceCriteria: [
      "Drift over one cent raises an alert with the affected account ids.",
      "The job is idempotent and safe to re-run for the same date.",
    ],
    points: 5,
  },
  {
    key: "PAY-841",
    title: "Apple Pay sheet on mobile web",
    description: "Show the Apple Pay sheet on supported Safari versions, fall back silently elsewhere.",
    acceptanceCriteria: [
      "On a supported device the sheet opens and completes a payment.",
      "On an unsupported device the button is not rendered at all.",
    ],
    points: 5,
  },
  {
    key: "PAY-845",
    title: "Decline reason codes surfaced to support",
    description: "Support agents need the raw gateway decline code alongside the customer-safe message.",
    acceptanceCriteria: [
      "The support view shows the gateway code and the mapped message.",
      "The customer-facing view shows only the mapped message.",
    ],
    points: 3,
  },
  {
    key: "PAY-858",
    title: "Dispute evidence upload limits",
    description: "Cap evidence uploads at 10 files and 25MB total, with clear errors.",
    acceptanceCriteria: [],
    points: 2,
  },
];

export async function createSprint(formData: FormData) {
  const { workspace } = await ctx();
  const name = String(formData.get("name") || "").trim() || "Sprint 1";
  const capacity = Number(formData.get("capacity") || 34);
  const seed = formData.get("seed") === "on";

  const starts = new Date();
  const ends = new Date(starts.getTime() + 12 * 24 * 3600 * 1000);

  const sprint = await db.sprint.create({
    data: {
      workspaceId: workspace.id,
      name,
      startsAt: starts,
      endsAt: ends,
      capacityPoints: Number.isFinite(capacity) ? capacity : 34,
      status: "planning",
      stories: seed
        ? {
            create: SEED_STORIES.map((s, i) => ({
              key: s.key,
              title: s.title,
              description: s.description,
              acceptanceCriteria: JSON.stringify(s.acceptanceCriteria),
              points: s.points,
              priority: i,
            })),
          }
        : undefined,
    },
  });

  revalidatePath("/sprint");
  redirect(`/sprint?id=${sprint.id}`);
}

export async function addStory(formData: FormData) {
  const { workspace } = await ctx();
  const sprintId = String(formData.get("sprintId"));
  const sprint = await db.sprint.findFirst({ where: { id: sprintId, workspaceId: workspace.id } });
  if (!sprint) throw new Error("Sprint not found in this workspace.");

  const criteria = String(formData.get("acceptanceCriteria") || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const pointsRaw = String(formData.get("points") || "").trim();

  await db.story.create({
    data: {
      sprintId,
      key: String(formData.get("key") || "").trim().toUpperCase() || `STORY-${Date.now() % 10000}`,
      title: String(formData.get("title") || "").trim() || "Untitled story",
      description: String(formData.get("description") || "").trim(),
      acceptanceCriteria: JSON.stringify(criteria),
      points: pointsRaw ? Number(pointsRaw) : null,
      priority: await db.story.count({ where: { sprintId } }),
    },
  });
  revalidatePath("/sprint");
}

export async function toggleStory(storyId: string, committed: boolean) {
  const { workspace } = await ctx();
  const story = await db.story.findFirst({
    where: { id: storyId, sprint: { workspaceId: workspace.id } },
  });
  if (!story) return;
  await db.story.update({ where: { id: storyId }, data: { committed } });
  revalidatePath("/sprint");
}

export async function deleteStory(storyId: string) {
  const { workspace } = await ctx();
  const story = await db.story.findFirst({
    where: { id: storyId, sprint: { workspaceId: workspace.id } },
  });
  if (!story) return;
  await db.story.delete({ where: { id: storyId } });
  revalidatePath("/sprint");
}

// ----------------------------------------------------------- sprint-planner

export async function planSprint(sprintId: string): Promise<void> {
  const { workspace } = await ctx();
  const sprint = await db.sprint.findFirst({
    where: { id: sprintId, workspaceId: workspace.id },
    include: { stories: { orderBy: { priority: "asc" } } },
  });
  if (!sprint) throw new Error("Sprint not found in this workspace.");
  if (sprint.stories.length === 0) throw new Error("Add at least one story before planning.");

  const closed = await db.sprint.findMany({
    where: { workspaceId: workspace.id, status: "closed" },
    include: { stories: true },
    orderBy: { endsAt: "asc" },
    take: 3,
  });

  const { runId, result } = await runAgentTracked<PlannerOut>({
    workspaceId: workspace.id,
    sprintId: sprint.id,
    agent: "sprint-planner",
    input: {
      sprintName: sprint.name,
      capacityPoints: sprint.capacityPoints,
      recentVelocity: closed.map((s) => s.stories.reduce((n, st) => n + (st.points ?? 0), 0)),
      stories: sprint.stories.map((s) => ({
        key: s.key,
        title: s.title,
        description: s.description,
        acceptanceCriteria: parseJson<string[]>(s.acceptanceCriteria, []),
        points: s.points,
      })),
    },
  });

  const plan = result.output;

  // Apply the plan: sizes, order, commitment, and any drafted acceptance criteria.
  const drafted = new Map(plan.draftedAcceptanceCriteria.map((d) => [d.key, d.criteria]));
  await Promise.all(
    plan.commitment.map((c) => {
      const story = sprint.stories.find((s) => s.key === c.key);
      if (!story) return Promise.resolve(null);
      const draft = drafted.get(c.key);
      return db.story.update({
        where: { id: story.id },
        data: {
          points: c.points,
          priority: c.order,
          committed: c.committed,
          ...(draft?.length
            ? {
                acceptanceCriteria: JSON.stringify(draft),
                tagsJson: JSON.stringify(["ac-drafted-by-agent"]),
              }
            : {}),
        },
      });
    })
  );

  await db.sprint.update({
    where: { id: sprint.id },
    data: { planJson: JSON.stringify({ ...plan, mode: result.mode, runId }) },
  });

  await logEvent(runId, `plan applied to ${plan.commitment.length} stories`, "ok", "sprint-planner");
  revalidatePath("/sprint");
}

// ------------------------------------------------------------ qe-pipeline --

/** One Jira story through the six sub-agents. */
export async function runStoryPipeline(storyId: string): Promise<void> {
  const { workspace } = await ctx();
  const story = await db.story.findFirst({
    where: { id: storyId, sprint: { workspaceId: workspace.id } },
  });
  if (!story) throw new Error("Story not found in this workspace.");

  const run = await db.run.create({
    data: {
      workspaceId: workspace.id,
      sprintId: story.sprintId,
      storyId: story.id,
      agent: "qe-pipeline",
      mode: "single",
      status: "running",
      inputJson: JSON.stringify({ storyKey: story.key }),
    },
  });

  try {
    const { runPipeline } = await import("@/lib/agents/pipeline");
    await runPipeline({ runId: run.id, storyId: story.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logEvent(run.id, msg, "error", "pipeline");
    await finishRun(run.id, "failed", undefined, msg);
  }

  revalidatePath("/sprint");
  redirect(`/runs/${run.id}`);
}

/** Every committed story, one pipeline each. Sequential so Atlassian rate limits hold. */
export async function runSprintPipelines(sprintId: string): Promise<void> {
  const { workspace } = await ctx();
  const sprint = await db.sprint.findFirst({
    where: { id: sprintId, workspaceId: workspace.id },
    include: { stories: { where: { committed: true }, orderBy: { priority: "asc" } } },
  });
  if (!sprint) throw new Error("Sprint not found in this workspace.");
  if (sprint.stories.length === 0) throw new Error("No committed stories to run.");

  let lastRunId = "";
  for (const story of sprint.stories) {
    const run = await db.run.create({
      data: {
        workspaceId: workspace.id,
        sprintId: sprint.id,
        storyId: story.id,
        agent: "qe-pipeline",
        mode: "batch",
        status: "running",
        inputJson: JSON.stringify({ storyKey: story.key, sprint: sprint.name }),
      },
    });
    lastRunId = run.id;
    try {
      const { runPipeline } = await import("@/lib/agents/pipeline");
      await runPipeline({ runId: run.id, storyId: story.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logEvent(run.id, msg, "error", "pipeline");
      await finishRun(run.id, "failed", undefined, msg);
    }
  }

  revalidatePath("/sprint");
  redirect(lastRunId ? `/runs/${lastRunId}` : "/sprint");
}

// ------------------------------------------------------------- Jira import --

export async function importFromJira(formData: FormData): Promise<void> {
  const { workspace } = await ctx();
  const sprintId = String(formData.get("sprintId"));
  const projectKey = String(formData.get("projectKey") || workspace.jiraProjectKey).trim();
  if (!projectKey) throw new Error("A Jira project key is required.");

  const sprint = await db.sprint.findFirst({ where: { id: sprintId, workspaceId: workspace.id } });
  if (!sprint) throw new Error("Sprint not found in this workspace.");

  const { fetchStories } = await import("@/lib/atlassian/jira");
  const stories = await fetchStories(projectKey, 50);

  for (const [i, s] of stories.entries()) {
    await db.story.upsert({
      where: { sprintId_key: { sprintId, key: s.key } },
      create: {
        sprintId,
        key: s.key,
        jiraId: s.id,
        jiraUrl: s.url,
        issueType: s.issueType,
        title: s.summary,
        description: s.description,
        acceptanceCriteria: JSON.stringify(s.acceptanceCriteria),
        points: s.storyPoints,
        priority: i,
        tagsJson: JSON.stringify(s.labels),
      },
      update: {
        jiraId: s.id,
        jiraUrl: s.url,
        issueType: s.issueType,
        title: s.summary,
        description: s.description,
        acceptanceCriteria: JSON.stringify(s.acceptanceCriteria),
        points: s.storyPoints,
        tagsJson: JSON.stringify(s.labels),
      },
    });
  }

  if (workspace.jiraProjectKey !== projectKey) {
    await db.workspace.update({ where: { id: workspace.id }, data: { jiraProjectKey: projectKey } });
  }
  revalidatePath("/sprint");
}

// ------------------------------------------------------------- publishing --

/**
 * Writes an approved proposal to Atlassian. This is the only path in the app that mutates
 * Jira, Xray or Bitbucket, and it runs only on an explicit click.
 */
export async function publish(publicationId: string): Promise<void> {
  const { workspace } = await ctx();
  const pub = await db.publication.findFirst({
    where: { id: publicationId, run: { workspaceId: workspace.id } },
    include: { run: { include: { assets: true, testCases: true, story: true } } },
  });
  if (!pub) throw new Error("Proposal not found in this workspace.");
  if (pub.status === "published") throw new Error("This proposal has already been published.");

  const payload = parseJson<Record<string, string>>(pub.payloadJson, {});
  const runId = pub.runId;

  try {
    if (pub.target === "jira-comment") {
      const { addComment } = await import("@/lib/atlassian/jira");
      const res = await addComment(payload.issueKey, payload.body);
      await logEvent(runId, `posted questions to ${payload.issueKey}`, "ok", "jira");
      await db.publication.update({
        where: { id: pub.id },
        data: { status: "published", publishedAt: new Date(), resultJson: JSON.stringify(res) },
      });
    } else if (pub.target === "xray-tests") {
      const { createTests } = await import("@/lib/atlassian/xray");
      const created = await createTests(
        pub.run.testCases.map((t) => ({
          summary: t.summary,
          testType: t.testType as "Manual" | "Cucumber" | "Generic",
          priority: t.priority,
          steps: parseJson<{ action: string; data: string; expected: string }[]>(t.stepsJson, []),
          gherkin: t.gherkin,
          labels: parseJson<string[]>(t.labelsJson, []),
          storyKey: pub.run.story?.key ?? "",
          projectKey: payload.projectKey,
        }))
      );
      for (const [i, c] of created.entries()) {
        const row = pub.run.testCases[i];
        if (row) {
          await db.testCase.update({ where: { id: row.id }, data: { xrayKey: c.key, published: true } });
        }
        await logEvent(runId, `created Xray test ${c.key} — ${c.summary}`, "ok", "xray");
      }
      await db.publication.update({
        where: { id: pub.id },
        data: { status: "published", publishedAt: new Date(), resultJson: JSON.stringify(created) },
      });
    } else if (pub.target === "bitbucket-branch") {
      const { commitFiles, createPullRequest } = await import("@/lib/atlassian/bitbucket");
      const files = pub.run.assets
        .filter((a) => !a.reused && a.content)
        .map((a) => ({ path: a.path, content: a.content }));
      if (files.length === 0) throw new Error("There are no generated files to commit.");

      const commit = await commitFiles({
        workspace: payload.workspace,
        repo: payload.repo,
        branch: payload.branch,
        fromBranch: payload.fromBranch,
        message: payload.message,
        files,
      });
      await logEvent(runId, `committed ${files.length} file(s) to ${payload.branch}`, "ok", "bitbucket");

      const pr = await createPullRequest({
        workspace: payload.workspace,
        repo: payload.repo,
        title: payload.prTitle || payload.message,
        description: payload.prDescription,
        sourceBranch: payload.branch,
        destinationBranch: payload.fromBranch,
      });
      await logEvent(runId, `opened pull request #${pr.id}`, "ok", "bitbucket");
      await db.publication.update({
        where: { id: pub.id },
        data: {
          status: "published",
          publishedAt: new Date(),
          resultJson: JSON.stringify({ ...commit, pullRequest: pr }),
        },
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logEvent(runId, msg, "error", pub.target);
    await db.publication.update({ where: { id: pub.id }, data: { status: "failed", error: msg } });
    throw err;
  }

  revalidatePath(`/runs/${runId}`);
  revalidatePath("/results");
}

// ------------------------------------------------------------- qe-insights --

export async function runInsights(): Promise<void> {
  const { workspace } = await ctx();
  const runs = await db.run.findMany({
    where: { workspaceId: workspace.id, agent: "qe-pipeline" },
    orderBy: { startedAt: "desc" },
    take: 100,
    include: { assets: true, story: { select: { key: true } }, stages: true },
  });
  if (runs.length === 0) throw new Error("No pipeline runs yet — run one first.");

  const { runId } = await runAgentTracked({
    workspaceId: workspace.id,
    agent: "qe-insights",
    input: {
      window: `last ${runs.length} pipeline runs`,
      runs: runs.map((r) => ({
        specPath: r.assets.find((a) => a.kind === "spec")?.path ?? `run-${r.id}`,
        status: r.status === "needs_review" || r.status === "succeeded" ? "passed" : "failed",
        durationMs: r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : 0,
        storyKey: r.story?.key ?? "",
      })),
    },
  });

  revalidatePath("/results");
  redirect(`/runs/${runId}`);
}

// --------------------------------------------------------------- settings --

export async function saveIntegrations(formData: FormData): Promise<void> {
  const { workspace } = await ctx();
  await db.workspace.update({
    where: { id: workspace.id },
    data: {
      jiraProjectKey: String(formData.get("jiraProjectKey") || "").trim().toUpperCase(),
      xrayProjectKey: String(formData.get("xrayProjectKey") || "").trim().toUpperCase(),
      bitbucketWorkspace: String(formData.get("bitbucketWorkspace") || "").trim(),
      bitbucketRepo: String(formData.get("bitbucketRepo") || "").trim(),
      defaultBranch: String(formData.get("defaultBranch") || "main").trim(),
      testFramework: String(formData.get("testFramework") || "playwright").trim(),
    },
  });
  revalidatePath("/settings");
  revalidatePath("/sprint");
}
