import { createHash } from "node:crypto";
import type { z } from "zod";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/utils";
import { agentsAreLive, runAgentTracked } from "./runtime";
import { runPipeline } from "./pipeline";
import { applySprintPlan } from "./apply-plan";
import { recall, learn, type LearningOutcome } from "./memory";
import { applyPatch, executeSpec, executeTest, type ExecutedTest } from "./executor";
import type { Memory } from "./types";
import type { SubAgentId } from "./pipeline-registry";
import type * as S from "./schemas";
import { PHASES, type PhaseId } from "./autopilot-phases";

type PlannerOut = z.infer<typeof S.SprintPlannerOut>;
type HealOut = z.infer<typeof S.QeAutoHealOut>;
type ReviewOut = z.infer<typeof S.RequirementsReviewOut>;
type ReportOut = z.infer<typeof S.CycleReportOut>;
type LearnerOut = z.infer<typeof S.LearnerOut>;
type Signal = z.infer<typeof S.LearnerIn>["signals"][number];

/**
 * The autopilot: one self-learning cycle over a sprint.
 *
 *   recall → plan → automate → execute → heal → review → report → learn
 *      ↑                                                            │
 *      └──────────── lessons feed the next cycle's agents ──────────┘
 *
 * Every step is an existing agent (or the six-stage pipeline) run as a child of the cycle, so
 * each one keeps its own run page and log. The cycle's own log narrates what happened between
 * them, and its stages are the eight phases in autopilot-phases.ts.
 */
export { PHASES, type PhaseId };

const PIPELINE_SCOPES: SubAgentId[] = ["story-analyzer", "clarify", "asset-resolver", "spec-author", "verifier", "reviewer"];
const MAX_HEALS_PER_TEST = 3;

export interface TestResult extends ExecutedTest {
  storyKey: string;
  path: string;
  firstRun: "passed" | "failed";
  final: "passed" | "failed" | "healed";
  heals: { runId: string; category: string; patched: boolean; summary: string }[];
}

export interface CycleMetrics {
  storiesCommitted: number;
  storiesSpecced: number;
  testsRun: number;
  firstRunPassRate: number;
  finalPassRate: number;
  healed: number;
  appBugs: number;
  revisions: number;
  criteriaMet: number;
  criteriaTotal: number;
  lessonsApplied: number;
}

/** An application defect the cycle found, and what happened to its Jira bug proposal. */
export interface CycleBug {
  storyKey: string;
  criterion: string;
  failure: string;
  /** proposed: new this cycle · pending: proposed earlier, not yet approved · filed: already in Jira */
  status: "proposed" | "pending" | "filed";
  publicationId: string;
  jiraKey: string;
}

export interface Campaign {
  id: string;
  index: number;
  max: number;
}

export interface CycleOutput {
  cycle: number;
  campaign: Campaign | null;
  /** Nothing new was learned and nothing needed healing or revising: another cycle would repeat this one. */
  stable: boolean;
  bugs: CycleBug[];
  mode: "live" | "simulated";
  metrics: CycleMetrics;
  applied: { key: string; scope: string; rule: string; confidence: number }[];
  stories: { key: string; title: string; pipeline: string; pipelineRunId: string; revisions: number }[];
  tests: TestResult[];
  review: ReviewOut | null;
  report: ReportOut | null;
  learning: (LearningOutcome & { summary: string }) | null;
}

/** Default pause between steps: long enough to watch a simulated cycle, zero when live. */
function defaultPaceMs() {
  const env = process.env.AUTOPILOT_PACE_MS;
  if (env !== undefined && env !== "") return Math.max(0, Number(env) || 0);
  return agentsAreLive() ? 0 : 450;
}

export async function startCycle(opts: {
  workspaceId: string;
  sprintId: string;
  campaign?: Campaign;
  /** "queued" when a job will pick the cycle up; "running" when it starts right away. */
  status?: "queued" | "running";
}) {
  const cycle = (await db.run.count({ where: { workspaceId: opts.workspaceId, agent: "autopilot" } })) + 1;
  const run = await db.run.create({
    data: {
      workspaceId: opts.workspaceId,
      sprintId: opts.sprintId,
      agent: "autopilot",
      mode: "batch",
      status: opts.status ?? "running",
      inputJson: JSON.stringify({ cycle, campaign: opts.campaign ?? null }),
    },
  });
  for (const [n, p] of PHASES.entries()) {
    await db.stage.create({ data: { runId: run.id, agent: p.id, order: n + 1, status: "pending" } });
  }
  return run;
}

export async function runCycle(opts: { runId: string; paceMs?: number }): Promise<CycleOutput> {
  const { runId } = opts;
  const paceMs = opts.paceMs ?? defaultPaceMs();
  const pace = () => (paceMs ? new Promise<void>((r) => setTimeout(r, paceMs)) : Promise.resolve());
  /** A shorter pause between items inside a phase (one spec, one heal), so the live view can follow. */
  const beat = () => (paceMs ? new Promise<void>((r) => setTimeout(r, Math.round(paceMs / 3))) : Promise.resolve());

  const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
  const workspaceId = run.workspaceId;
  const sprintId = run.sprintId!;
  const { cycle, campaign } = parseJson<{ cycle: number; campaign: Campaign | null }>(run.inputJson, {
    cycle: 1,
    campaign: null,
  });

  const log = async (source: string, message: string, level: "info" | "ok" | "warn" | "error" = "info") => {
    await db.event.create({ data: { runId, source, stage: source, level, message } });
  };
  const order = (id: PhaseId) => PHASES.findIndex((p) => p.id === id) + 1;
  const begin = async (id: PhaseId) => {
    await db.stage.update({
      where: { runId_order: { runId, order: order(id) } },
      data: { status: "running", startedAt: new Date() },
    });
    await log(id, `${PHASES[order(id) - 1].label}: ${PHASES[order(id) - 1].blurb}`);
  };
  const end = async (id: PhaseId, summary: string, status: "passed" | "blocked" | "failed" | "skipped" = "passed", out?: unknown) => {
    await db.stage.update({
      where: { runId_order: { runId, order: order(id) } },
      data: {
        status,
        summary: summary.slice(0, 2000),
        outputJson: out === undefined ? undefined : JSON.stringify(out),
        finishedAt: new Date(),
      },
    });
    await log(id, summary, status === "passed" ? "ok" : "warn");
    await pace();
  };

  const out: CycleOutput = {
    cycle,
    campaign,
    stable: false,
    bugs: [],
    mode: agentsAreLive() ? "live" : "simulated",
    metrics: {
      storiesCommitted: 0,
      storiesSpecced: 0,
      testsRun: 0,
      firstRunPassRate: 0,
      finalPassRate: 0,
      healed: 0,
      appBugs: 0,
      revisions: 0,
      criteriaMet: 0,
      criteriaTotal: 0,
      lessonsApplied: 0,
    },
    applied: [],
    stories: [],
    tests: [],
    review: null,
    report: null,
    learning: null,
  };
  const save = () => db.run.update({ where: { id: runId }, data: { outputJson: JSON.stringify(out) } });

  if (!agentsAreLive()) {
    await log("autopilot", "No ANTHROPIC_API_KEY set — agents run on their simulators and execution is simulated.", "warn");
  }

  // ------------------------------------------------------------- recall --
  await begin("recall");
  const scopes = ["sprint-planner", ...PIPELINE_SCOPES, "qe-auto-heal", "requirements-reviewer"] as const;
  const memory = {} as Record<(typeof scopes)[number], Memory>;
  for (const s of scopes) {
    memory[s] = await recall(workspaceId, s);
    for (const l of memory[s].lessons) {
      out.applied.push({ key: l.key, scope: s, rule: l.rule, confidence: l.confidence });
      await log("recall", `→ ${s}: ${l.rule}`, "info");
    }
  }
  out.metrics.lessonsApplied = out.applied.length;
  await save();
  await end(
    "recall",
    out.applied.length
      ? `Recalled ${out.applied.length} lesson(s) from earlier cycles and injected them into the agents they apply to.`
      : "No lessons yet — this cycle sets the baseline."
  );

  // --------------------------------------------------------------- plan --
  await begin("plan");
  const sprint = await db.sprint.findUniqueOrThrow({
    where: { id: sprintId },
    include: { stories: { orderBy: { priority: "asc" } } },
  });
  const { runId: planRunId, result: planned } = await runAgentTracked<PlannerOut>({
    workspaceId,
    sprintId,
    parentId: runId,
    agent: "sprint-planner",
    memory: memory["sprint-planner"],
    input: {
      sprintName: sprint.name,
      capacityPoints: sprint.capacityPoints,
      recentVelocity: [],
      stories: sprint.stories.map((s) => ({
        key: s.key,
        title: s.title,
        description: s.description,
        acceptanceCriteria: parseJson<string[]>(s.acceptanceCriteria, []),
        points: s.points,
      })),
    },
  });
  await applySprintPlan(sprint.stories, planned.output);
  await db.sprint.update({
    where: { id: sprintId },
    data: { planJson: JSON.stringify({ ...planned.output, mode: planned.mode, runId: planRunId }) },
  });
  for (const r of planned.output.risks) await log("plan", `risk (${r.level}): ${r.message}`, "warn");
  await end("plan", planned.output.summary, "passed", { runId: planRunId });

  // ----------------------------------------------------------- automate --
  await begin("automate");
  const committed = await db.story.findMany({
    where: { sprintId, committed: true },
    orderBy: { priority: "asc" },
  });
  out.metrics.storiesCommitted = committed.length;
  const signals: Signal[] = [];

  for (const story of committed) {
    const child = await db.run.create({
      data: {
        workspaceId,
        sprintId,
        storyId: story.id,
        parentId: runId,
        agent: "qe-pipeline",
        mode: "batch",
        status: "running",
        inputJson: JSON.stringify({ storyKey: story.key, cycle }),
      },
    });
    await log("automate", `${story.key} → qe-pipeline started`);
    try {
      await runPipeline({
        runId: child.id,
        storyId: story.id,
        memory: Object.fromEntries(PIPELINE_SCOPES.map((s) => [s, memory[s]])),
        pace: () => (paceMs ? new Promise((r) => setTimeout(r, Math.round(paceMs / 3))) : Promise.resolve()),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db.event.create({ data: { runId: child.id, source: "pipeline", stage: "pipeline", level: "error", message: msg } });
      await db.run.update({ where: { id: child.id }, data: { status: "failed", error: msg, finishedAt: new Date() } });
    }
    const done = await db.run.findUniqueOrThrow({ where: { id: child.id }, select: { status: true } });

    // A revision means the verifier found criteria the first draft missed. That is a lesson for
    // story-analyzer, which decides which behaviours exist in the first place.
    const revisionEvents = await db.event.findMany({
      where: { runId: child.id, source: "verifier", message: { startsWith: "revision " } },
    });
    for (const e of revisionEvents) {
      const uncovered = Number(e.message.match(/(\d+) uncovered/)?.[1] ?? 0);
      if (uncovered > 0) signals.push({ kind: "uncovered-criterion", storyKey: story.key, detail: e.message });
    }
    out.metrics.revisions += revisionEvents.length;
    out.stories.push({
      key: story.key,
      title: story.title,
      pipeline: done.status,
      pipelineRunId: child.id,
      revisions: revisionEvents.length,
    });
    if (done.status === "needs_review") out.metrics.storiesSpecced++;
    await log(
      "automate",
      `${story.key} → ${done.status.replace("_", " ")}${revisionEvents.length ? ` after ${revisionEvents.length} revision(s)` : " on the first pass"}`,
      done.status === "needs_review" ? "ok" : "warn"
    );
    await save();
  }
  await end(
    "automate",
    `${out.metrics.storiesSpecced}/${committed.length} stories produced a reviewed suite; ${out.metrics.revisions} verifier revision(s) along the way.`
  );

  // ------------------------------------------------------------ execute --
  await begin("execute");
  const specs = await db.asset.findMany({
    where: { runId: { in: out.stories.map((s) => s.pipelineRunId) }, kind: "spec", reused: false },
    include: { run: { select: { storyId: true, story: { select: { key: true } } } } },
  });
  for (const spec of specs) {
    await beat();
    const storyKey = spec.run.story?.key ?? "";
    const results = executeSpec(spec.path, spec.content);
    for (const r of results) {
      out.tests.push({ ...r, storyKey, path: spec.path, firstRun: r.status, final: r.status, heals: [] });
      await log("execute", `${r.status === "passed" ? "✓" : "✗"} ${storyKey} ${r.name} (${r.durationMs}ms)`, r.status === "passed" ? "ok" : "warn");
    }
    await save();
  }
  out.metrics.testsRun = out.tests.length;
  const firstPass = out.tests.filter((t) => t.firstRun === "passed").length;
  out.metrics.firstRunPassRate = out.tests.length ? firstPass / out.tests.length : 0;
  await end(
    "execute",
    `${out.tests.length} test(s) across ${specs.length} spec(s): ${firstPass} passed, ${out.tests.length - firstPass} failed on the first run (simulated execution).`
  );

  // --------------------------------------------------------------- heal --
  await begin("heal");
  for (const t of out.tests.filter((x) => x.status === "failed")) {
    await beat();
    const spec = specs.find((s) => s.path === t.path && (s.run.story?.key ?? "") === t.storyKey);
    if (!spec) continue;
    let current: ExecutedTest = t;
    for (let attempt = 1; attempt <= MAX_HEALS_PER_TEST && current.status === "failed"; attempt++) {
      const fresh = await db.asset.findUniqueOrThrow({ where: { id: spec.id } });
      const { runId: healRunId, result } = await runAgentTracked<HealOut>({
        workspaceId,
        sprintId,
        storyId: spec.run.storyId,
        parentId: runId,
        agent: "qe-auto-heal",
        memory: memory["qe-auto-heal"],
        input: { specPath: spec.path, specContent: fresh.content, failureOutput: current.failure ?? "", recentDiff: "" },
      });
      const heal = result.output;
      t.heals.push({ runId: healRunId, category: heal.category, patched: heal.shouldPatch, summary: heal.diagnosis });

      if (!heal.shouldPatch || !heal.patch) {
        // The test is right and the application is wrong. The test stays exactly as written.
        t.cause = "app-bug";
        await log("heal", `${t.storyKey} ${t.name}: application defect — not patched. ${heal.reason}`, "error");
        signals.push({ kind: "app-bug", storyKey: t.storyKey, detail: (current.failure ?? heal.diagnosis).split("\n").slice(0, 3).join(" ") });
        break;
      }

      const patched = applyPatch(fresh.content, heal.patch.before, heal.patch.after);
      if (!patched.applied) {
        await log("heal", `${t.storyKey} ${t.name}: the ${heal.category} patch did not apply to the current file.`, "warn");
        break;
      }
      await db.asset.update({ where: { id: spec.id }, data: { content: patched.content, bytes: patched.content.length } });
      await db.asset.create({
        data: { runId: healRunId, path: spec.path, kind: "patch", content: heal.patch.unifiedDiff, bytes: heal.patch.unifiedDiff.length },
      });
      if (heal.category === "timing") signals.push({ kind: "fixed-wait", storyKey: t.storyKey, detail: heal.patch.before });
      if (heal.category === "selector") signals.push({ kind: "style-selector", storyKey: t.storyKey, detail: heal.patch.before });

      const rerun = executeTest(spec.path, patched.content, t.name);
      if (!rerun) break;
      current = rerun;
      await log(
        "heal",
        `${t.storyKey} ${t.name}: ${heal.category} patch applied → re-run ${rerun.status === "passed" ? "green" : `still failing (${rerun.cause})`}`,
        rerun.status === "passed" ? "ok" : "warn"
      );
    }
    t.status = current.status;
    t.final = current.status === "passed" ? "healed" : "failed";
    if (current.status === "failed") {
      t.failure = current.failure;
      t.cause = current.cause;
    }
    // Keep the running counts current so the live view moves while the phase runs.
    out.metrics.healed = out.tests.filter((x) => x.final === "healed").length;
    out.metrics.appBugs = out.tests.filter((x) => x.final === "failed" && x.cause === "app-bug").length;
    await save();
  }
  out.metrics.healed = out.tests.filter((t) => t.final === "healed").length;
  out.metrics.appBugs = out.tests.filter((t) => t.final === "failed" && t.cause === "app-bug").length;
  out.metrics.finalPassRate = out.tests.length
    ? out.tests.filter((t) => t.final !== "failed").length / out.tests.length
    : 0;
  await end(
    "heal",
    out.tests.some((t) => t.firstRun === "failed")
      ? `${out.metrics.healed} test(s) healed without touching an assertion; ${out.metrics.appBugs} failure(s) are application defects and were escalated.`
      : "Nothing to heal — every test passed on the first run.",
    "passed"
  );

  // Story status follows its tests.
  for (const s of out.stories) {
    const tests = out.tests.filter((t) => t.storyKey === s.key);
    if (!tests.length) continue;
    await db.story.updateMany({
      where: { sprintId, key: s.key },
      data: { status: tests.some((t) => t.final === "failed") ? "failing" : "green" },
    });
  }

  // ------------------------------------------------------------- review --
  await begin("review");
  const refreshed = await db.story.findMany({ where: { sprintId, committed: true }, orderBy: { priority: "asc" } });
  const { result: reviewed } = await runAgentTracked<ReviewOut>({
    workspaceId,
    sprintId,
    parentId: runId,
    agent: "requirements-reviewer",
    memory: memory["requirements-reviewer"],
    input: {
      stories: refreshed.map((s) => ({
        key: s.key,
        title: s.title,
        acceptanceCriteria: parseJson<string[]>(s.acceptanceCriteria, []),
        pipeline:
          out.stories.find((x) => x.key === s.key)?.pipeline === "needs_review"
            ? "needs_review"
            : (out.stories.find((x) => x.key === s.key)?.pipeline ?? "not-run"),
        tests: out.tests
          .filter((t) => t.storyKey === s.key)
          .map((t) => ({
            name: t.name,
            criterion: t.criterion,
            status: t.final,
            note: t.final === "failed" ? (t.failure ?? "").split("\n").slice(0, 2).join(" ") : "",
          })),
      })),
    },
  });
  out.review = reviewed.output;
  out.metrics.criteriaTotal = reviewed.output.criteria.length;
  out.metrics.criteriaMet = reviewed.output.criteria.filter((c) => c.status === "met").length;
  for (const c of reviewed.output.criteria) {
    await log("review", `${c.status.toUpperCase().padEnd(8)} ${c.storyKey}: ${c.criterion}`, c.status === "met" ? "ok" : "warn");
  }
  await save();
  await end("review", `${reviewed.output.verdict}: ${reviewed.output.summary}`, reviewed.output.verdict === "reject" ? "blocked" : "passed");

  // ------------------------------------------------------------- report --
  await begin("report");
  const previous = await db.run.findFirst({
    where: { workspaceId, agent: "autopilot", status: "succeeded", id: { not: runId } },
    orderBy: { startedAt: "desc" },
  });
  const prevOut = parseJson<CycleOutput | null>(previous?.outputJson, null);
  const { result: reported } = await runAgentTracked<ReportOut>({
    workspaceId,
    sprintId,
    parentId: runId,
    agent: "cycle-reporter",
    input: {
      sprintName: sprint.name,
      cycle,
      metrics: out.metrics,
      previous: prevOut
        ? {
            firstRunPassRate: prevOut.metrics.firstRunPassRate,
            revisions: prevOut.metrics.revisions,
            healed: prevOut.metrics.healed,
          }
        : null,
      verdict: reviewed.output.verdict,
      // A defect is reported once per criterion, however many tests caught it; the "not met"
      // gaps are those same defects, so only the other gaps are listed separately.
      gaps: reviewed.output.criteria
        .filter((c) => c.status === "untested" || c.status === "blocked")
        .map((c) => `${c.storyKey}: ${c.status} — ${c.criterion}`),
      bugs: [
        ...new Map(
          out.tests
            .filter((t) => t.final === "failed" && t.cause === "app-bug")
            .map((t) => [`${t.storyKey}|${t.criterion}`, `${t.storyKey}: ${t.criterion} — ${(t.failure ?? "").split("\n")[0]}`])
        ).values(),
      ],
    },
  });
  out.report = reported.output;

  // Each application defect becomes one proposed Jira bug — once. A defect already proposed or
  // filed in an earlier cycle is referenced, not proposed again.
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  const defects = new Map<string, TestResult>();
  for (const t of out.tests) {
    if (t.final === "failed" && t.cause === "app-bug") defects.set(`${t.storyKey}|${t.criterion}`, t);
  }
  for (const t of defects.values()) {
    const fingerprint = `defect-${createHash("sha1").update(`${workspaceId}|${t.storyKey}|${t.criterion}`).digest("hex").slice(0, 16)}`;
    const failure = (t.failure ?? "").split("\n").slice(0, 4).join("\n");
    const earlier = await db.publication.findFirst({
      where: {
        target: "jira-bug",
        run: { workspaceId },
        payloadJson: { contains: fingerprint },
        status: { in: ["proposed", "approved", "published"] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (earlier) {
      const key = parseJson<{ key?: string }>(earlier.resultJson, {}).key ?? "";
      out.bugs.push({
        storyKey: t.storyKey,
        criterion: t.criterion,
        failure,
        status: earlier.status === "published" ? "filed" : "pending",
        publicationId: earlier.id,
        jiraKey: key,
      });
      await log("report", `${t.storyKey}: defect already ${earlier.status === "published" ? `filed as ${key}` : "proposed — awaiting approval"}`, "info");
      continue;
    }
    const pub = await db.publication.create({
      data: {
        runId,
        target: "jira-bug",
        payloadJson: JSON.stringify({
          fingerprint,
          projectKey: ws.jiraProjectKey,
          storyKey: t.storyKey,
          summary: `[${t.storyKey}] ${t.criterion}`.slice(0, 240),
          description: [
            `Acceptance criterion not met: ${t.criterion}`,
            `Found by Autopilot, cycle ${cycle}. The test is correct; the application does not do what the criterion requires. The test was not changed.`,
            `Test: ${t.name}\nSpec: ${t.path}`,
            `Failure:\n${failure}`,
          ].join("\n\n"),
        }),
      },
    });
    out.bugs.push({ storyKey: t.storyKey, criterion: t.criterion, failure, status: "proposed", publicationId: pub.id, jiraKey: "" });
    await log("report", `${t.storyKey}: proposed a Jira bug — approve it to file it`, "warn");
  }
  await save();
  await end(
    "report",
    `${reported.output.headline}${
      out.bugs.some((b) => b.status === "proposed") ? ` ${out.bugs.filter((b) => b.status === "proposed").length} Jira bug(s) proposed.` : ""
    }`
  );

  // -------------------------------------------------------------- learn --
  await begin("learn");
  const known = await db.lesson.findMany({ where: { workspaceId }, select: { key: true, rule: true } });
  let learned: LearnerOut = { summary: "Nothing went wrong that a lesson would have prevented.", lessons: [] };
  if (signals.length) {
    learned = (
      await runAgentTracked<LearnerOut>({
        workspaceId,
        sprintId,
        parentId: runId,
        agent: "learner",
        input: { signals, known },
      })
    ).result.output;
  }
  const hits: Record<string, number> = {};
  const keyOf = (s: Signal) =>
    s.kind === "fixed-wait"
      ? "no-fixed-waits"
      : s.kind === "style-selector"
        ? "stable-selectors"
        : s.kind === "uncovered-criterion"
          ? "behaviour-per-criterion"
          : `known-defect-${s.storyKey.toLowerCase()}`;
  for (const s of signals) hits[keyOf(s)] = (hits[keyOf(s)] ?? 0) + 1;

  const outcome = await learn({
    workspaceId,
    runId,
    // A known-defect lesson can only be judged when its story's tests actually ran this cycle.
    applied: [...new Set(out.applied.map((a) => a.key))].filter(
      (k) => !k.startsWith("known-defect-") || out.tests.some((t) => `known-defect-${t.storyKey.toLowerCase()}` === k)
    ),
    learned: learned.lessons,
    hits,
  });
  out.learning = { ...outcome, summary: learned.summary };
  for (const k of outcome.created) await log("learn", `new lesson: ${k}`, "ok");
  for (const k of outcome.reinforced) await log("learn", `reinforced: ${k}`, "info");
  for (const k of outcome.confirmed) await log("learn", `confirmed — applied and the problem did not recur: ${k}`, "ok");
  for (const k of outcome.contradicted) await log("learn", `contradicted — applied but the problem came back: ${k}`, "warn");
  for (const k of outcome.retired) await log("learn", `retired: ${k}`, "warn");
  for (const k of outcome.resolved) await log("learn", `resolved — the defect no longer reproduces: ${k}`, "ok");
  await save();
  await end("learn", learned.summary);

  out.stable = outcome.created.length === 0 && out.metrics.healed === 0 && out.metrics.revisions === 0;
  await db.run.update({
    where: { id: runId },
    data: { status: "succeeded", finishedAt: new Date(), outputJson: JSON.stringify(out) },
  });
  await log("autopilot", `cycle ${cycle} complete — ${reported.output.headline}`, "ok");
  return out;
}

/** Runs a started cycle to completion and records a failure on the cycle rather than throwing. */
export async function runCycleSafely(runId: string, paceMs?: number) {
  try {
    return await runCycle({ runId, paceMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.event.create({ data: { runId, source: "autopilot", stage: "autopilot", level: "error", message: msg } });
    await db.stage.updateMany({ where: { runId, status: "running" }, data: { status: "failed", finishedAt: new Date() } });
    await db.run.update({ where: { id: runId }, data: { status: "failed", error: msg, finishedAt: new Date() } });
    return null;
  }
}

/**
 * Runs cycles back to back until the loop is stable — nothing new learned, nothing healed,
 * nothing revised — or `max` cycles have run, or a person asks it to stop. The first cycle
 * must already have been started with `startCycle`.
 */
export async function runCampaign(opts: {
  firstRunId: string;
  workspaceId: string;
  sprintId: string;
  campaign: Campaign;
  paceMs?: number;
}): Promise<{ cycles: string[]; reason: "stable" | "max" | "stopped" | "failed" | "awaiting-approval" }> {
  const cycles = [opts.firstRunId];
  let runId = opts.firstRunId;
  for (let i = 1; ; i++) {
    const out = await runCycleSafely(runId, opts.paceMs);
    const note = (message: string, level: "ok" | "warn" = "ok") =>
      db.event.create({ data: { runId, source: "autopilot", stage: "autopilot", level, message } });
    if (!out) return { cycles, reason: "failed" };
    if (out.stable) {
      await note(`stable after ${i} cycle(s) — nothing new to learn, so the run stops here`);
      return { cycles, reason: "stable" };
    }
    // Nothing new was learned, and what would help is waiting on a person: another cycle
    // would only repeat this one.
    const pending = await db.lesson.count({ where: { workspaceId: opts.workspaceId, status: "proposed" } });
    if (pending > 0 && (out.learning?.created.length ?? 0) === 0) {
      await note(`${pending} lesson(s) await approval — stopping until a person reviews them`, "warn");
      return { cycles, reason: "awaiting-approval" };
    }
    if (i >= opts.campaign.max) {
      await note(`reached the limit of ${opts.campaign.max} cycles without settling`, "warn");
      return { cycles, reason: "max" };
    }
    const current = await db.run.findUnique({ where: { id: runId }, select: { stopRequested: true } });
    if (current?.stopRequested) {
      await note("stopped on request", "warn");
      return { cycles, reason: "stopped" };
    }
    await note(`not stable yet — starting cycle ${out.cycle + 1} with what this one learned`);
    const next = await startCycle({
      workspaceId: opts.workspaceId,
      sprintId: opts.sprintId,
      campaign: { ...opts.campaign, index: i + 1 },
    });
    cycles.push(next.id);
    runId = next.id;
  }
}

/** Every cycle of one multi-cycle run, in order. */
export async function campaignCycles(workspaceId: string, campaignId: string) {
  const rows = await db.run.findMany({
    where: { workspaceId, agent: "autopilot", inputJson: { contains: campaignId } },
    select: { id: true, status: true, inputJson: true, outputJson: true },
    orderBy: { startedAt: "asc" },
  });
  return rows
    .map((r) => {
      const input = parseJson<{ cycle: number; campaign: Campaign | null }>(r.inputJson, { cycle: 0, campaign: null });
      const output = parseJson<CycleOutput | null>(r.outputJson, null);
      return { id: r.id, status: r.status, cycle: input.cycle, campaign: input.campaign, stable: output?.stable ?? false };
    })
    .filter((r) => r.campaign?.id === campaignId);
}
