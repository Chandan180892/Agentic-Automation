"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { runAgentTracked, logEvent } from "@/lib/agents/runtime";
import { parseJson } from "@/lib/utils";
import { applySprintPlan } from "@/lib/agents/apply-plan";
import { enqueue, JobConflict } from "@/lib/jobs/queue";
import { action, ActionError, assertRole, audit, rateLimit } from "@/lib/guard";
import { env } from "@/lib/env";
import type * as S from "@/lib/agents/schemas";

type PlannerOut = z.infer<typeof S.SprintPlannerOut>;

/** Reads a form against a schema; the first problem becomes a message the user can act on. */
function formInput<T extends z.ZodType>(schema: T, formData: FormData): z.infer<T> {
  const parsed = schema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    throw new ActionError(`${i.path.join(".") || "Input"}: ${i.message}`);
  }
  return parsed.data;
}

const text = (max: number) => z.string().trim().max(max);

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
      "A request without an idempotency key is rejected with a 400 naming the missing header.",
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

const SprintForm = z.object({
  name: text(80).optional().transform((v) => v || "Sprint 1"),
  capacity: z.coerce.number().int().min(1).max(500).optional().default(34),
  seed: z.string().optional(),
});

export const createSprint = action(async (formData: FormData): Promise<void> => {
  const { workspace } = await ctx();
  const form = formInput(SprintForm, formData);
  const name = form.name;
  const capacity = form.capacity;
  const seed = form.seed === "on";

  const starts = new Date();
  const ends = new Date(starts.getTime() + 12 * 24 * 3600 * 1000);

  const sprint = await db.sprint.create({
    data: {
      workspaceId: workspace.id,
      name,
      startsAt: starts,
      endsAt: ends,
      capacityPoints: capacity,
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
});

const StoryForm = z.object({
  sprintId: z.string().min(1),
  key: z
    .string()
    .trim()
    .toUpperCase()
    .max(32)
    .refine((v) => v === "" || /^[A-Z][A-Z0-9_]*-\d+$/.test(v), "must look like PAY-123")
    .optional(),
  title: text(200).optional(),
  description: text(20_000).optional(),
  acceptanceCriteria: text(20_000).optional(),
  points: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? Number(v) : null))
    .pipe(z.number().int().min(0).max(100).nullable()),
});

export const addStory = action(async (formData: FormData): Promise<void> => {
  const { workspace } = await ctx();
  const form = formInput(StoryForm, formData);
  const sprint = await db.sprint.findFirst({ where: { id: form.sprintId, workspaceId: workspace.id } });
  if (!sprint) throw new ActionError("Sprint not found in this workspace.");

  const criteria = (form.acceptanceCriteria ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
  const key = form.key || `STORY-${Date.now() % 10000}`;
  if (await db.story.findUnique({ where: { sprintId_key: { sprintId: sprint.id, key } } })) {
    throw new ActionError(`${key} is already in this sprint.`);
  }

  await db.story.create({
    data: {
      sprintId: sprint.id,
      key,
      title: form.title || "Untitled story",
      description: form.description ?? "",
      acceptanceCriteria: JSON.stringify(criteria),
      points: form.points,
      priority: await db.story.count({ where: { sprintId: sprint.id } }),
    },
  });
  revalidatePath("/sprint");
});

export const toggleStory = action(async (storyId: string, committed: boolean): Promise<void> => {
  const { workspace } = await ctx();
  const story = await db.story.findFirst({
    where: { id: storyId, sprint: { workspaceId: workspace.id } },
  });
  if (!story) return;
  await db.story.update({ where: { id: storyId }, data: { committed } });
  revalidatePath("/sprint");
});

export const deleteStory = action(async (storyId: string): Promise<void> => {
  const { workspace } = await ctx();
  const story = await db.story.findFirst({
    where: { id: storyId, sprint: { workspaceId: workspace.id } },
  });
  if (!story) return;
  await db.story.delete({ where: { id: storyId } });
  revalidatePath("/sprint");
});

// ----------------------------------------------------------- sprint-planner

export const planSprint = action(async (sprintId: string): Promise<void> => {
  const c = await ctx();
  const { workspace } = c;
  const sprint = await db.sprint.findFirst({
    where: { id: sprintId, workspaceId: workspace.id },
    include: { stories: { orderBy: { priority: "asc" } } },
  });
  if (!sprint) throw new ActionError("Sprint not found in this workspace.");
  if (sprint.stories.length === 0) throw new ActionError("Add at least one story before planning.");
  await rateLimit(c, "sprint-planner");

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

  await applySprintPlan(sprint.stories, plan);

  await db.sprint.update({
    where: { id: sprint.id },
    data: { planJson: JSON.stringify({ ...plan, mode: result.mode, runId }) },
  });

  await logEvent(runId, `plan applied to ${plan.commitment.length} stories`, "ok", "sprint-planner");
  revalidatePath("/sprint");
});

// ------------------------------------------------------------ qe-pipeline --

/** One Jira story through the six sub-agents, as a background job. */
export const runStoryPipeline = action(async (storyId: string): Promise<void> => {
  const c = await ctx();
  const { workspace } = c;
  const story = await db.story.findFirst({
    where: { id: storyId, sprint: { workspaceId: workspace.id } },
  });
  if (!story) throw new ActionError("Story not found in this workspace.");
  await rateLimit(c, "qe-pipeline");

  const run = await db.run.create({
    data: {
      workspaceId: workspace.id,
      sprintId: story.sprintId,
      storyId: story.id,
      agent: "qe-pipeline",
      mode: "single",
      status: "queued",
      inputJson: JSON.stringify({ storyKey: story.key }),
    },
  });
  await enqueue({ workspaceId: workspace.id, kind: "story-pipeline", payload: { runId: run.id, storyId: story.id }, runId: run.id });

  revalidatePath("/sprint");
  redirect(`/runs/${run.id}`);
});

/** Every committed story, one pipeline each, in one job. Only one such job per sprint at a time. */
export const runSprintPipelines = action(async (sprintId: string): Promise<void> => {
  const c = await ctx();
  const { workspace } = c;
  const sprint = await db.sprint.findFirst({
    where: { id: sprintId, workspaceId: workspace.id },
    include: { stories: { where: { committed: true }, orderBy: { priority: "asc" } } },
  });
  if (!sprint) throw new ActionError("Sprint not found in this workspace.");
  if (sprint.stories.length === 0) throw new ActionError("No committed stories to run.");
  await rateLimit(c, "sprint-pipelines");

  const runs = [];
  for (const story of sprint.stories) {
    const run = await db.run.create({
      data: {
        workspaceId: workspace.id,
        sprintId: sprint.id,
        storyId: story.id,
        agent: "qe-pipeline",
        mode: "batch",
        status: "queued",
        inputJson: JSON.stringify({ storyKey: story.key, sprint: sprint.name }),
      },
    });
    runs.push({ runId: run.id, storyId: story.id });
  }
  try {
    await enqueue({
      workspaceId: workspace.id,
      kind: "sprint-pipelines",
      payload: { runs, runIds: runs.map((r) => r.runId) },
      runId: runs[0].runId,
      dedupeKey: `sprint-pipelines:${sprint.id}`,
    });
  } catch (err) {
    if (!(err instanceof JobConflict)) throw err;
    await db.run.deleteMany({ where: { id: { in: runs.map((r) => r.runId) } } });
    redirect(err.existing.runId ? `/runs/${err.existing.runId}` : "/sprint");
  }

  revalidatePath("/sprint");
  redirect(`/runs/${runs[0].runId}`);
});

// ------------------------------------------------------------- Jira import --

export const importFromJira = action(async (formData: FormData): Promise<void> => {
  const c = await ctx();
  const { workspace } = c;
  const sprintId = String(formData.get("sprintId"));
  const projectKey = String(formData.get("projectKey") || workspace.jiraProjectKey).trim().toUpperCase();
  if (!projectKey) throw new ActionError("A Jira project key is required.");
  if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(projectKey)) throw new ActionError("A Jira project key looks like PAY or QE2.");
  await audit(c, "jira.import", projectKey, { sprintId });

  const sprint = await db.sprint.findFirst({ where: { id: sprintId, workspaceId: workspace.id } });
  if (!sprint) throw new ActionError("Sprint not found in this workspace.");

  const { fetchStories } = await import("@/lib/atlassian/jira");
  let stories: Awaited<ReturnType<typeof fetchStories>>;
  try {
    stories = await fetchStories(projectKey, 50);
  } catch (err) {
    throw new ActionError(`Could not read ${projectKey} from Jira: ${err instanceof Error ? err.message : String(err)}`);
  }

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
});

// ------------------------------------------------------------- publishing --

/**
 * Writes an approved proposal to Atlassian. This is the only path in the app that mutates
 * Jira, Xray or Bitbucket, and it runs only on an explicit click.
 */
export const publish = action(async (publicationId: string): Promise<void> => {
  const c = await ctx();
  const { workspace } = c;
  assertRole(c, ["owner", "admin"], "publish to Jira, Xray or Bitbucket");
  const pub = await db.publication.findFirst({
    where: { id: publicationId, run: { workspaceId: workspace.id } },
    include: { run: { include: { assets: true, testCases: true, story: true } } },
  });
  if (!pub) throw new ActionError("Proposal not found in this workspace.");
  if (pub.status === "published") throw new ActionError("This proposal has already been published.");

  // Claim it atomically, so a double click or two reviewers cannot write it twice.
  const claimed = await db.publication.updateMany({
    where: { id: pub.id, status: { in: ["proposed", "approved", "failed"] } },
    data: { status: "publishing", error: null },
  });
  if (claimed.count === 0) throw new ActionError("This proposal is already being published.");
  await audit(c, "publish", pub.target, { publicationId: pub.id, runId: pub.runId });

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
    } else if (pub.target === "jira-bug") {
      if (!payload.projectKey) throw new ActionError("Set a Jira project key in Settings before filing bugs.");
      const { createBug } = await import("@/lib/atlassian/jira");
      const bug = await createBug({
        projectKey: payload.projectKey,
        storyKey: payload.storyKey,
        summary: payload.summary,
        description: payload.description,
      });
      await logEvent(
        runId,
        `filed ${bug.key} for ${payload.storyKey}${bug.linked ? "" : " (could not link it to the story)"}`,
        "ok",
        "jira"
      );
      await db.publication.update({
        where: { id: pub.id },
        data: { status: "published", publishedAt: new Date(), resultJson: JSON.stringify(bug) },
      });
    } else if (pub.target === "bitbucket-branch") {
      const { commitFiles, createPullRequest } = await import("@/lib/atlassian/bitbucket");
      const files = pub.run.assets
        .filter((a) => !a.reused && a.content)
        .map((a) => ({ path: a.path, content: a.content }));
      if (files.length === 0) throw new ActionError("There are no generated files to commit.");

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
    throw new ActionError(`Publishing failed: ${msg}`);
  }

  revalidatePath(`/runs/${runId}`);
  revalidatePath(`/autopilot/${runId}`);
  revalidatePath("/results");
});

// --------------------------------------------------------------- autopilot --

/**
 * Starts the autopilot on a sprint and returns straight away; the work runs after the response,
 * so the browser lands on the live view while the agents work. `untilStable` keeps starting
 * cycles until nothing new is learned (at most `AUTOPILOT_MAX_CYCLES`, default 5).
 */
async function launchAutopilot(sprintId: string, untilStable: boolean): Promise<void> {
  const c = await ctx();
  const { workspace } = c;
  const sprint = await db.sprint.findFirst({
    where: { id: sprintId, workspaceId: workspace.id },
    include: { _count: { select: { stories: true } } },
  });
  if (!sprint) throw new ActionError("Sprint not found in this workspace.");
  if (sprint._count.stories === 0) throw new ActionError("Add at least one story before starting the autopilot.");
  await rateLimit(c, untilStable ? "autopilot.until-stable" : "autopilot");
  const { startCycle } = await import("@/lib/agents/autopilot");
  const campaign = untilStable
    ? { id: `c-${Date.now().toString(36)}`, index: 1, max: Math.max(2, Math.min(10, Number(env().AUTOPILOT_MAX_CYCLES) || 5)) }
    : null;
  const run = await startCycle({ workspaceId: workspace.id, sprintId: sprint.id, campaign: campaign ?? undefined, status: "queued" });
  try {
    // One autopilot per workspace at a time — enforced by the database, not by a check-then-act.
    await enqueue({
      workspaceId: workspace.id,
      kind: "autopilot",
      payload: { runId: run.id, sprintId: sprint.id, campaign },
      runId: run.id,
      dedupeKey: `autopilot:${workspace.id}`,
    });
  } catch (err) {
    if (!(err instanceof JobConflict)) throw err;
    await db.run.delete({ where: { id: run.id } });
    redirect(err.existing.runId ? `/autopilot/${err.existing.runId}` : "/autopilot");
  }

  revalidatePath("/autopilot");
  redirect(`/autopilot/${run.id}`);
}

export const startAutopilot = action(async (sprintId: string): Promise<void> => {
  await launchAutopilot(sprintId, false);
});

export const startAutopilotUntilStable = action(async (sprintId: string): Promise<void> => {
  await launchAutopilot(sprintId, true);
});

/** Asks a multi-cycle run to stop once the cycle in progress finishes. */
export const stopAutopilot = action(async (runId: string): Promise<void> => {
  const c = await ctx();
  const { workspace } = c;
  await audit(c, "autopilot.stop", runId);
  await db.run.updateMany({ where: { id: runId, workspaceId: workspace.id, agent: "autopilot" }, data: { stopRequested: true } });
  await db.event.create({
    data: { runId, source: "autopilot", stage: "autopilot", level: "warn", message: "stop requested — this cycle finishes, no further cycle starts" },
  });
  revalidatePath(`/autopilot/${runId}`);
});

/** A person's decision on a proposed lesson. Rejection sticks even if the evidence recurs. */
export const reviewLesson = action(async (lessonId: string, decision: "approve" | "reject"): Promise<void> => {
  const c = await ctx();
  const { workspace } = c;
  assertRole(c, ["owner", "admin"], "decide which lessons the agents use");
  if (decision !== "approve" && decision !== "reject") throw new ActionError("Unknown decision.");
  const lesson = await db.lesson.findFirst({ where: { id: lessonId, workspaceId: workspace.id } });
  if (!lesson) throw new ActionError("Lesson not found in this workspace.");
  const status = decision === "approve" ? "active" : "rejected";
  await db.lesson.update({ where: { id: lesson.id }, data: { status } });
  const { recordLessonEvent } = await import("@/lib/agents/memory");
  await recordLessonEvent(lesson.id, decision === "approve" ? "approved" : "rejected", lesson.confidence, "", `decided by ${c.session?.user?.email ?? "a person"}`);
  await audit(c, `lesson.${decision}`, lesson.key);
  revalidatePath("/autopilot");
});

export const saveLearningSettings = action(async (formData: FormData): Promise<void> => {
  const c = await ctx();
  const { workspace } = c;
  assertRole(c, ["owner", "admin"], "change how lessons are approved");
  const mode = formData.get("lessonApproval") === "review" ? "review" : "auto";
  await audit(c, "settings.lessonApproval", mode);
  await db.workspace.update({ where: { id: workspace.id }, data: { lessonApproval: mode } });
  revalidatePath("/autopilot");
  revalidatePath("/settings");
});

/** Forgets one lesson. The learner may teach it again if the evidence comes back. */
export const forgetLesson = action(async (lessonId: string): Promise<void> => {
  const c = await ctx();
  const { workspace } = c;
  assertRole(c, ["owner", "admin"], "delete lessons");
  const lesson = await db.lesson.findFirst({ where: { id: lessonId, workspaceId: workspace.id }, select: { key: true } });
  await db.lesson.deleteMany({ where: { id: lessonId, workspaceId: workspace.id } });
  if (lesson) await audit(c, "lesson.forget", lesson.key);
  revalidatePath("/autopilot");
});

// ------------------------------------------------------------- qe-insights --

export const runInsights = action(async (): Promise<void> => {
  const c = await ctx();
  const { workspace } = c;
  await rateLimit(c, "qe-insights");
  const runs = await db.run.findMany({
    where: { workspaceId: workspace.id, agent: "qe-pipeline" },
    orderBy: { startedAt: "desc" },
    take: 100,
    include: { assets: true, story: { select: { key: true } }, stages: true },
  });
  if (runs.length === 0) throw new ActionError("No pipeline runs yet — run one first.");

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
});

// --------------------------------------------------------------- settings --

const IntegrationsForm = z.object({
  jiraProjectKey: z.string().trim().toUpperCase().regex(/^([A-Z][A-Z0-9_]{0,19})?$/, "must look like PAY").optional().default(""),
  xrayProjectKey: z.string().trim().toUpperCase().regex(/^([A-Z][A-Z0-9_]{0,19})?$/, "must look like PAY").optional().default(""),
  bitbucketWorkspace: z.string().trim().regex(/^[\w.-]{0,62}$/, "letters, digits, . _ - only").optional().default(""),
  bitbucketRepo: z.string().trim().regex(/^[\w.-]{0,62}$/, "letters, digits, . _ - only").optional().default(""),
  defaultBranch: z.string().trim().regex(/^[\w./-]{1,100}$/, "is not a valid branch name").optional().default("main"),
  testFramework: z.string().trim().regex(/^[\w .+-]{1,40}$/, "is not a framework name").optional().default("playwright"),
});

export const saveIntegrations = action(async (formData: FormData): Promise<void> => {
  const c = await ctx();
  const { workspace } = c;
  assertRole(c, ["owner", "admin"], "change integrations");
  const form = formInput(IntegrationsForm, formData);
  await audit(c, "settings.integrations", "", form);
  await db.workspace.update({
    where: { id: workspace.id },
    data: form,
  });
  revalidatePath("/settings");
  revalidatePath("/sprint");
});
