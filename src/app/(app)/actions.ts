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

// ------------------------------------------------- qe-pipelines / qe-batch

/** One story → specs and assets, executed inline and recorded as a Job with Assets. */
export async function generateForStory(storyId: string) {
  const { workspace } = await ctx();
  const story = await db.story.findFirst({
    where: { id: storyId, sprint: { workspaceId: workspace.id } },
    include: { sprint: true },
  });
  if (!story) throw new Error("Story not found in this workspace.");

  const run = await db.run.create({
    data: {
      workspaceId: workspace.id,
      sprintId: story.sprintId,
      agent: "qe-pipelines",
      mode: "single",
      status: "running",
      inputJson: JSON.stringify({ storyKey: story.key }),
    },
  });
  const job = await db.job.create({
    data: { runId: run.id, storyId: story.id, kind: "spec-gen", status: "running", payloadJson: "{}" },
  });

  await logEvent(run.id, `reading ${story.key} — ${story.title}`, "info", "qe-pipelines", job.id);

  try {
    const result = await invokeAgent<PipelinesOut>("qe-pipelines", {
      story: {
        key: story.key,
        title: story.title,
        description: story.description,
        acceptanceCriteria: parseJson<string[]>(story.acceptanceCriteria, []),
        points: story.points,
      },
      framework: "playwright",
      language: "typescript",
    });
    const out = result.output;

    if (result.mode === "simulated") {
      await logEvent(run.id, "No ANTHROPIC_API_KEY set — output came from the built-in simulator.", "warn", "qe-pipelines", job.id);
    }
    for (const s of out.scenarios) {
      await logEvent(run.id, `scenario: ${s.name} (covers: ${s.criterion})`, "info", "qe-pipelines", job.id);
    }
    for (const a of out.assets) {
      await db.asset.create({
        data: { jobId: job.id, path: a.path, kind: a.kind, content: a.content, bytes: a.content.length },
      });
      await logEvent(run.id, `wrote ${a.path} (${a.content.split("\n").length} lines)`, "ok", "qe-pipelines", job.id);
    }
    if (out.needsHuman) {
      await logEvent(run.id, out.notes || "Needs a human before these specs can be trusted.", "warn", "qe-pipelines", job.id);
    }

    await db.job.update({
      where: { id: job.id },
      data: { status: "passed", resultJson: JSON.stringify(out), finishedAt: new Date() },
    });
    await db.story.update({ where: { id: story.id }, data: { status: "specced" } });
    await finishRun(run.id, out.needsHuman ? "needs_review" : "succeeded", out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logEvent(run.id, msg, "error", "qe-pipelines", job.id);
    await db.job.update({ where: { id: job.id }, data: { status: "failed", finishedAt: new Date() } });
    await finishRun(run.id, "failed", undefined, msg);
  }

  revalidatePath("/runs");
  revalidatePath("/sprint");
  redirect(`/runs/${run.id}`);
}

/** The whole committed sprint, sharded by qe-batch and queued for the runners. */
export async function batchGenerate(sprintId: string) {
  const { workspace } = await ctx();
  const sprint = await db.sprint.findFirst({
    where: { id: sprintId, workspaceId: workspace.id },
    include: { stories: { where: { committed: true }, orderBy: { priority: "asc" } } },
  });
  if (!sprint) throw new Error("Sprint not found in this workspace.");
  if (sprint.stories.length === 0) throw new Error("No committed stories to generate from.");

  const slots = await db.runner.aggregate({
    where: { workspaceId: workspace.id, status: { in: ["online", "busy"] } },
    _sum: { slots: true },
  });
  const available = Math.max(1, slots._sum.slots ?? 2);

  const run = await db.run.create({
    data: {
      workspaceId: workspace.id,
      sprintId: sprint.id,
      agent: "qe-batch",
      mode: "batch",
      status: "running",
      inputJson: JSON.stringify({ stories: sprint.stories.length, availableSlots: available }),
    },
  });

  try {
    const result = await invokeAgent<BatchOut>("qe-batch", {
      sprintName: sprint.name,
      availableSlots: available,
      framework: "playwright",
      stories: sprint.stories.map((s) => ({
        key: s.key,
        title: s.title,
        description: s.description,
        acceptanceCriteria: parseJson<string[]>(s.acceptanceCriteria, []),
        points: s.points,
      })),
    });
    const out = result.output;

    if (result.mode === "simulated") {
      await logEvent(run.id, "No ANTHROPIC_API_KEY set — shard plan came from the built-in simulator.", "warn", "qe-batch");
    }
    await logEvent(run.id, out.summary, "info", "qe-batch");
    for (const f of out.sharedFixtures) {
      await logEvent(run.id, `shared fixture ${f.path} — ${f.reason}`, "info", "qe-batch");
    }

    // One queued job per story. Runners claim these over their outbound connection.
    const byKey = new Map(sprint.stories.map((s) => [s.key, s]));
    for (const shard of out.shards) {
      for (const key of shard.storyKeys) {
        const story = byKey.get(key);
        if (!story) continue;
        await db.job.create({
          data: {
            runId: run.id,
            storyId: story.id,
            kind: "spec-gen",
            status: "queued",
            payloadJson: JSON.stringify({
              shard: shard.shard,
              storyKey: story.key,
              title: story.title,
              description: story.description,
              acceptanceCriteria: parseJson<string[]>(story.acceptanceCriteria, []),
              framework: "playwright",
            }),
          },
        });
      }
      await logEvent(run.id, `shard ${shard.shard}: ${shard.storyKeys.join(", ")} (~${shard.estimatedMinutes}m)`, "info", "qe-batch");
    }

    await logEvent(run.id, `${sprint.stories.length} jobs queued — waiting for a runner to claim them.`, "ok", "qe-batch");
    await db.run.update({ where: { id: run.id }, data: { outputJson: JSON.stringify(out) } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logEvent(run.id, msg, "error", "qe-batch");
    await finishRun(run.id, "failed", undefined, msg);
  }

  revalidatePath("/runs");
  redirect(`/runs/${run.id}`);
}

// ------------------------------------------------- qe-auto-heal / batch-heal

export async function healJob(jobId: string) {
  const { workspace } = await ctx();
  const job = await db.job.findFirst({
    where: { id: jobId, run: { workspaceId: workspace.id } },
    include: { assets: true, run: true },
  });
  if (!job) throw new Error("Job not found in this workspace.");

  const spec = job.assets.find((a) => a.kind === "spec");
  const result = parseJson<{ failureOutput?: string; diff?: string }>(job.resultJson, {});

  const run = await db.run.create({
    data: {
      workspaceId: workspace.id,
      sprintId: job.run.sprintId,
      agent: "qe-auto-heal",
      mode: "single",
      status: "running",
      inputJson: JSON.stringify({ jobId, specPath: spec?.path }),
    },
  });

  try {
    const out = (
      await invokeAgent<HealOut>("qe-auto-heal", {
        specPath: spec?.path ?? "tests/unknown.spec.ts",
        specContent: spec?.content ?? "",
        failureOutput: result.failureOutput ?? "Test failed with no captured output.",
        recentDiff: result.diff ?? "",
      })
    ).output;

    await logEvent(run.id, out.diagnosis, out.shouldPatch ? "info" : "warn", "qe-auto-heal");
    await logEvent(run.id, out.reason, out.shouldPatch ? "info" : "warn", "qe-auto-heal");

    if (out.shouldPatch && out.patch) {
      const healJobRow = await db.job.create({
        data: { runId: run.id, storyId: job.storyId, kind: "heal", status: "passed", payloadJson: "{}", finishedAt: new Date() },
      });
      await db.asset.create({
        data: {
          jobId: healJobRow.id,
          path: out.patch.path,
          kind: "patch",
          content: out.patch.unifiedDiff,
          bytes: out.patch.unifiedDiff.length,
        },
      });
      await logEvent(run.id, `patch proposed for ${out.patch.path} — awaiting your review`, "ok", "qe-auto-heal");
      await finishRun(run.id, "needs_review", out);
    } else {
      await logEvent(run.id, "Not patching. The application is what needs to change.", "warn", "qe-auto-heal");
      await finishRun(run.id, "needs_review", out);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logEvent(run.id, msg, "error", "qe-auto-heal");
    await finishRun(run.id, "failed", undefined, msg);
  }

  revalidatePath("/results");
  redirect(`/runs/${run.id}`);
}

export async function batchHeal() {
  const { workspace } = await ctx();
  const failed = await db.job.findMany({
    where: { run: { workspaceId: workspace.id }, status: "failed" },
    include: { assets: true },
    orderBy: { createdAt: "desc" },
    take: 25,
  });
  if (failed.length === 0) throw new Error("Nothing is failing right now.");

  const run = await db.run.create({
    data: {
      workspaceId: workspace.id,
      agent: "batch-heal",
      mode: "batch",
      status: "running",
      inputJson: JSON.stringify({ failures: failed.length }),
    },
  });

  try {
    const out = (
      await invokeAgent<BatchHealOut>("batch-heal", {
        failures: failed.map((j) => {
          const spec = j.assets.find((a) => a.kind === "spec");
          const res = parseJson<{ failureOutput?: string }>(j.resultJson, {});
          return {
            specPath: spec?.path ?? `job-${j.id}`,
            specContent: spec?.content ?? "",
            failureOutput: res.failureOutput ?? "Test failed with no captured output.",
          };
        }),
        recentDiff: "",
      })
    ).output;

    await logEvent(run.id, out.summary, "info", "batch-heal");
    for (const g of out.groups) {
      await logEvent(run.id, `root cause: ${g.signature} — ${g.specPaths.length} specs`, "info", "batch-heal");
    }
    const healJobRow = await db.job.create({
      data: { runId: run.id, kind: "heal", status: "passed", payloadJson: "{}", finishedAt: new Date() },
    });
    for (const p of out.patches) {
      await db.asset.create({
        data: { jobId: healJobRow.id, path: p.path, kind: "patch", content: p.unifiedDiff, bytes: p.unifiedDiff.length },
      });
      await logEvent(run.id, `patched ${p.path}${p.verified ? " — verified green" : ""}`, "ok", "batch-heal");
    }
    for (const e of out.escalations) {
      await logEvent(run.id, `escalated ${e.specPath}: ${e.reason}`, "warn", "batch-heal");
    }
    await finishRun(run.id, "needs_review", out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logEvent(run.id, msg, "error", "batch-heal");
    await finishRun(run.id, "failed", undefined, msg);
  }

  revalidatePath("/results");
  redirect(`/runs/${run.id}`);
}

// ------------------------------------------------------------------ runners

export async function createRunner(formData: FormData) {
  const { workspace } = await ctx();
  const name = String(formData.get("name") || "").trim() || `runner-${Date.now() % 1000}`;
  const kind = String(formData.get("kind") || "cloud") === "local" ? "local" : "cloud";
  const slots = Math.max(1, Math.min(16, Number(formData.get("slots") || 2)));

  const { token, hash, hint } = newRunnerToken();
  await db.runner.create({
    data: {
      workspaceId: workspace.id,
      name,
      kind,
      slots,
      location: String(formData.get("location") || "").trim(),
      tokenHash: hash,
      tokenHint: hint,
      status: "offline",
    },
  });

  revalidatePath("/runners");
  // The token is shown exactly once, on the redirect target.
  redirect(`/runners?token=${encodeURIComponent(token)}&name=${encodeURIComponent(name)}`);
}

export async function deleteRunner(runnerId: string) {
  const { workspace } = await ctx();
  const runner = await db.runner.findFirst({ where: { id: runnerId, workspaceId: workspace.id } });
  if (!runner) return;
  await db.runner.delete({ where: { id: runnerId } });
  revalidatePath("/runners");
}

// ------------------------------------------------------- applying a patch --

/**
 * Accept a patch qe-auto-heal or batch-heal proposed. The patch is recorded as accepted and
 * a fresh execute job is queued, so a runner re-runs the spec and the result is real rather
 * than asserted. Gantry does not write to your repository — the runner owns the working tree.
 */
export async function applyPatch(assetId: string): Promise<void> {
  const { workspace } = await ctx();
  const patch = await db.asset.findFirst({
    where: { id: assetId, kind: "patch", job: { run: { workspaceId: workspace.id } } },
    include: { job: { include: { run: true } } },
  });
  if (!patch) throw new Error("Patch not found in this workspace.");

  const run = await db.run.create({
    data: {
      workspaceId: workspace.id,
      sprintId: patch.job.run.sprintId,
      agent: "qe-auto-heal",
      mode: "single",
      status: "running",
      inputJson: JSON.stringify({ appliedPatch: patch.path }),
    },
  });

  const job = await db.job.create({
    data: {
      runId: run.id,
      storyId: patch.job.storyId,
      kind: "execute",
      status: "queued",
      payloadJson: JSON.stringify({
        reason: "re-run after applying a proposed patch",
        assets: [{ path: patch.path, kind: "patch", content: patch.content }],
      }),
    },
  });

  await logEvent(run.id, `applying patch to ${patch.path}`, "info", "qe-auto-heal", job.id);
  await logEvent(
    run.id,
    "queued a re-run — a runner will verify the patch against the real suite",
    "info",
    "qe-auto-heal",
    job.id
  );

  revalidatePath("/results");
  redirect(`/runs/${run.id}`);
}

// -------------------------------------------------------------- qe-insights

export async function runInsights(): Promise<void> {
  const { workspace } = await ctx();
  const jobs = await db.job.findMany({
    where: { run: { workspaceId: workspace.id }, status: { in: ["passed", "failed"] } },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { assets: true, story: { select: { key: true } } },
  });
  if (jobs.length === 0) throw new Error("No finished jobs yet — run something first.");

  const { runId } = await runAgentTracked({
    workspaceId: workspace.id,
    agent: "qe-insights",
    input: {
      window: `last ${jobs.length} jobs`,
      runs: jobs.map((j) => ({
        specPath: j.assets.find((a) => a.kind === "spec")?.path ?? `job-${j.id}`,
        status: j.status,
        durationMs:
          j.finishedAt && j.claimedAt ? j.finishedAt.getTime() - j.claimedAt.getTime() : 0,
        storyKey: j.story?.key ?? "",
      })),
    },
  });

  revalidatePath("/results");
  redirect(`/runs/${runId}`);
}
