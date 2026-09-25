import { z } from "zod";
import { SUB_AGENTS, type SubAgentId, type SubAgentDef } from "./pipeline-registry";
import { agentsAreLive } from "./runtime";
import { memoryPrompt, type Memory } from "./types";
import { callStructured } from "./llm";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/utils";
import * as P from "./pipeline-schemas";
import { listFiles } from "@/lib/atlassian/bitbucket";
import { RULES, qualityGate, type GateResult } from "./rulebook";

const RULE_FIX: Record<string, string> = Object.fromEntries(RULES.map((r) => [r.id, r.instead]));
import { bitbucketConfigured } from "@/lib/atlassian/config";

type Analyzer = z.infer<typeof P.StoryAnalyzerOut>;
type Clarify = z.infer<typeof P.ClarifyOut>;
type Resolver = z.infer<typeof P.AssetResolverOut>;
type Author = z.infer<typeof P.SpecAuthorOut>;
type Verify = z.infer<typeof P.VerifierOut>;
type Review = z.infer<typeof P.ReviewerOut>;
type Strategy = z.infer<typeof P.TestStrategistOut>;

/** The Jira context stored on a story at import (see Story.contextJson). */
interface StoredContext {
  priority?: string;
  testCriteria?: string;
  comments?: { author: string; created: string; text: string }[];
  parent?: { key: string; summary: string } | null;
  components?: string[];
  linkedTests?: { key: string; summary: string; kind: string }[];
}

/** Runs one sub-agent. Same structured-output contract as the top-level agents. */
async function runSubAgent<T>(
  id: SubAgentId,
  input: unknown,
  memory?: Memory,
  runId?: string,
  /** Answer without a model call when the input leaves nothing to reason about. */
  deterministic = false
): Promise<{ output: T; mode: "live" | "simulated" | "deterministic" }> {
  const def = SUB_AGENTS[id] as unknown as SubAgentDef;
  const parsed = def.input.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `${id} rejected its input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "root"} ${i.message}`).join("; ")}`
    );
  }

  if (!agentsAreLive() || deterministic) {
    return { output: def.output.parse(def.simulate(parsed.data, memory)) as T, mode: agentsAreLive() ? "deterministic" : "simulated" };
  }

  const { output } = await callStructured<T>({
    agent: id,
    system: def.system,
    volatileSystem: memoryPrompt(memory).trim() || undefined,
    prompt: def.prompt(parsed.data),
    tool: def.tool,
    toolDescription: def.toolDescription,
    schema: def.output as never,
    maxTokens: def.maxTokens,
    runId,
    effort: def.effort,
    tier: def.tier,
  });
  return { output, mode: "live" };
}

async function log(
  runId: string,
  message: string,
  level: "info" | "ok" | "warn" | "error" = "info",
  stage = "pipeline"
) {
  await db.event.create({ data: { runId, message, level, source: stage, stage } });
}

/**
 * The free quality gate over spec-author's files: fixes what the rulebook can fix with
 * certainty and logs everything it found. Runs after every draft, before anything is stored.
 */
async function gate<A extends { files: { path: string; content: string; kind: string }[] }>(runId: string, authored: A) {
  const result = qualityGate(authored.files);
  for (const f of result.findings) {
    await log(
      runId,
      `${f.fixed ? "fixed" : f.severity === "block" ? "[blocking]" : "[warn]"} ${f.title} — ${f.path}:${f.line} ${f.text}`,
      f.fixed ? "ok" : f.severity === "block" ? "warn" : "info",
      "quality-gate"
    );
  }
  await log(runId, result.summary, result.blocking ? "warn" : "ok", "quality-gate");
  return { authored: { ...authored, files: result.files }, result };
}

async function startStage(runId: string, id: SubAgentId) {
  const def = SUB_AGENTS[id];
  await db.stage.upsert({
    where: { runId_order: { runId, order: def.order } },
    create: { runId, agent: id, order: def.order, status: "running", startedAt: new Date() },
    update: { status: "running", startedAt: new Date() },
  });
  await log(runId, `${id} started`, "info", id);
}

async function endStage(
  runId: string,
  id: SubAgentId,
  status: "passed" | "blocked" | "failed" | "skipped",
  summary: string,
  output?: unknown
) {
  const def = SUB_AGENTS[id];
  await db.stage.update({
    where: { runId_order: { runId, order: def.order } },
    data: {
      status,
      summary: summary.slice(0, 2000),
      outputJson: output === undefined ? undefined : JSON.stringify(output),
      finishedAt: new Date(),
    },
  });
  await log(runId, summary, status === "passed" ? "ok" : status === "skipped" ? "info" : "warn", id);
}

/**
 * The qe-pipeline: one Jira story walked through seven sub-agents.
 *
 * story-analyzer → clarify → asset-resolver → spec-author → verifier → reviewer
 *
 * A blocking clarification stops the chain rather than letting a guess flow downstream, and
 * nothing is written to Jira, Xray or Bitbucket here — the reviewer's approval only produces
 * Publication rows for a human to approve.
 */
export async function runPipeline(opts: {
  runId: string;
  storyId: string;
  /** Lessons per sub-agent, recalled by the autopilot. A standalone run passes none. */
  memory?: Partial<Record<SubAgentId, Memory>>;
  /** Pause between stages so a person watching the live view can follow along. */
  pace?: () => Promise<void>;
}): Promise<void> {
  const { runId, storyId } = opts;
  const mem = (id: SubAgentId) => opts.memory?.[id];
  const pace = opts.pace ?? (async () => {});

  const story = await db.story.findUniqueOrThrow({
    where: { id: storyId },
    include: { sprint: { include: { workspace: true } } },
  });
  const ws = story.sprint.workspace;

  const jira = parseJson<StoredContext>(story.contextJson, {});
  const storyCtx = {
    key: story.key,
    summary: story.title,
    description: story.description,
    acceptanceCriteria: parseJson<string[]>(story.acceptanceCriteria, []),
    issueType: story.issueType || "Story",
    labels: parseJson<string[]>(story.tagsJson, []),
    priority: jira.priority ?? "",
    testCriteria: jira.testCriteria ?? "",
    comments: (jira.comments ?? []).map((c) => `${c.author}${c.created ? ` (${c.created.slice(0, 10)})` : ""}: ${c.text}`),
    parent: jira.parent ? `${jira.parent.key}: ${jira.parent.summary}` : "",
    components: jira.components ?? [],
    existingTests: (jira.linkedTests ?? []).map((t) => ({ key: t.key, summary: t.summary, kind: t.kind })),
  };

  // Seed every stage so the UI can show the whole chain from the first paint.
  for (const a of Object.values(SUB_AGENTS)) {
    await db.stage.upsert({
      where: { runId_order: { runId, order: a.order } },
      create: { runId, agent: a.id, order: a.order, status: "pending" },
      update: {},
    });
  }

  if (!agentsAreLive()) {
    await log(runId, "No ANTHROPIC_API_KEY set — every stage below ran on its simulator.", "warn");
  }

  // ---------------------------------------------------------- 1. analyze --
  await startStage(runId, "story-analyzer");
  const analysis = (await runSubAgent<Analyzer>("story-analyzer", { story: storyCtx, framework: ws.testFramework }, mem("story-analyzer"), runId)).output;
  await endStage(runId, "story-analyzer", analysis.testable ? "passed" : "blocked", analysis.summary, analysis);
  await pace();
  for (const b of analysis.behaviours) await log(runId, `behaviour: ${b.name}`, "info", "story-analyzer");

  if (!analysis.testable) {
    await db.run.update({
      where: { id: runId },
      data: { status: "blocked", finishedAt: new Date(), error: "Nothing in this story is testable as written." },
    });
    return;
  }

  // ----------------------------------------------------------- 2. clarify --
  await startStage(runId, "clarify");
  let clarification: Clarify = { summary: "No ambiguities to resolve.", questions: [], blocked: false, jiraComment: "" };
  if (analysis.ambiguities.length > 0) {
    clarification = (await runSubAgent<Clarify>("clarify", { story: storyCtx, ambiguities: analysis.ambiguities }, mem("clarify"), runId)).output;
    for (const q of clarification.questions) {
      await log(runId, `${q.blocking ? "[blocking] " : ""}${q.question}`, q.blocking ? "warn" : "info", "clarify");
    }
    if (clarification.jiraComment) {
      await db.publication.create({
        data: {
          runId,
          target: "jira-comment",
          payloadJson: JSON.stringify({ issueKey: story.key, body: clarification.jiraComment }),
        },
      });
    }
  }
  await endStage(runId, "clarify", clarification.blocked ? "blocked" : "passed", clarification.summary, clarification);
  await pace();

  if (clarification.blocked) {
    await db.run.update({
      where: { id: runId },
      data: {
        status: "blocked",
        finishedAt: new Date(),
        error: "Waiting on an answer — a wrong guess here would test the wrong behaviour.",
        outputJson: JSON.stringify({ analysis, clarification }),
      },
    });
    return;
  }

  // -------------------------------------------------------- 3. strategy --
  await startStage(runId, "test-strategist");
  const strategy = (
    await runSubAgent<Strategy>(
      "test-strategist",
      {
        story: storyCtx,
        behaviours: analysis.behaviours.map((b) => ({ name: b.name, criterion: b.criterion, kind: b.kind, risk: b.risk })),
        framework: ws.testFramework,
      },
      mem("test-strategist"),
      runId
    )
  ).output;
  for (const p of strategy.criteria) {
    await log(runId, `${p.priority} ${p.level} · ${p.techniques.join(", ")} — ${p.criterion.slice(0, 90)}`, "info", "test-strategist");
  }
  for (const n of strategy.scopeNotes) await log(runId, `scope note: ${n.slice(0, 200)}`, "warn", "test-strategist");
  await endStage(runId, "test-strategist", "passed", `${strategy.summary} ${strategy.approach}`, strategy);
  await pace();
  const plan = strategy.criteria.map((c) => ({
    criterion: c.criterion,
    level: c.level,
    priority: c.priority,
    automate: c.automate,
    preconditions: c.preconditions,
    testData: c.testData,
    scenarios: c.scenarios,
  }));
  // Existing Xray tests the strategist matched count as coverage for the verifier.
  const existingCoverage = strategy.criteria.flatMap((c) =>
    c.scenarios.filter((sc) => sc.coveredBy).map((sc) => ({ summary: `${sc.coveredBy} (existing) ${sc.title}`, criterion: c.criterion }))
  );

  // ----------------------------------------------------- 4. resolve assets --
  await startStage(runId, "asset-resolver");
  let repoPaths: string[] = [];
  if (bitbucketConfigured() && ws.bitbucketWorkspace && ws.bitbucketRepo) {
    try {
      repoPaths = await listFiles(ws.bitbucketWorkspace, ws.bitbucketRepo, ws.defaultBranch);
      await log(runId, `read ${repoPaths.length} paths from ${ws.bitbucketWorkspace}/${ws.bitbucketRepo}`, "ok", "asset-resolver");
    } catch (err) {
      await log(runId, `could not read Bitbucket: ${err instanceof Error ? err.message : String(err)}`, "warn", "asset-resolver");
    }
  } else {
    await log(runId, "Bitbucket is not configured — planning assets without the repo's history.", "warn", "asset-resolver");
  }

  // With no repository listing there is nothing for a model to weigh: the plan is the
  // conventions default, so it is produced without a model call.
  const resolved = (
    await runSubAgent<Resolver>("asset-resolver", {
      story: storyCtx,
      behaviours: analysis.behaviours.map((b) => ({ name: b.name, criterion: b.criterion })),
      repoPaths,
      framework: ws.testFramework,
    }, mem("asset-resolver"), runId, repoPaths.length === 0)
  ).output;
  if (repoPaths.length === 0 && agentsAreLive()) await log(runId, "no repository to read — default conventions, no model call", "info", "asset-resolver");
  await endStage(runId, "asset-resolver", "passed", resolved.summary, resolved);
  await pace();
  for (const r of resolved.reuse) await log(runId, `reuse ${r.path} — ${r.why}`, "ok", "asset-resolver");

  // -------------------------------------------------------- 5. write specs --
  await startStage(runId, "spec-author");
  let authored = (
    await runSubAgent<Author>("spec-author", {
      story: storyCtx,
      behaviours: analysis.behaviours.map((b) => ({ name: b.name, criterion: b.criterion, kind: b.kind })),
      reuse: resolved.reuse.map((r) => ({ path: r.path, kind: r.kind })),
      create: resolved.create.map((c) => ({ path: c.path, kind: c.kind })),
      conventions: resolved.conventions,
      framework: ws.testFramework,
      strategy: plan,
    }, mem("spec-author"), runId)
  ).output;
  let gated = await gate(runId, authored);
  authored = gated.authored;

  for (const f of authored.files) {
    await db.asset.create({
      data: { runId, path: f.path, kind: f.kind, content: f.content, bytes: f.content.length },
    });
    await log(runId, `wrote ${f.path} (${f.content.split("\n").length} lines)`, "ok", "spec-author");
  }
  for (const r of resolved.reuse) {
    await db.asset.create({
      data: { runId, path: r.path, kind: r.kind, content: "", reused: true, bytes: 0 },
    });
  }
  for (const t of authored.testCases) {
    await db.testCase.create({
      data: {
        runId,
        storyId,
        summary: t.summary,
        testType: t.testType,
        priority: t.priority,
        stepsJson: JSON.stringify(t.steps),
        gherkin: t.gherkin,
        labelsJson: JSON.stringify(t.labels),
        criterion: t.criterion,
      },
    });
  }
  await endStage(runId, "spec-author", "passed", authored.summary, authored);
  await pace();

  // ------------------------------------------------------------ 6. verify --
  // The verifier is adversarial, so a first pass often finds real defects. Rather than
  // stopping there, spec-author gets the findings back and revises. Two attempts: enough
  // to fix what a careful author would catch on re-read, not enough to loop forever.
  const MAX_REVISIONS = 2;
  // When the quality gate already found blocking defects, the draft goes back without paying
  // for a model review of code that is known to need changes.
  const verify = async (files: { path: string; content: string }[], cases: { summary: string; criterion: string }[], g: GateResult) => {
    const input = {
      story: storyCtx,
      behaviours: analysis.behaviours.map((b) => ({ name: b.name, criterion: b.criterion })),
      files: files.map((f) => ({ path: f.path, content: f.content })),
      testCases: [...cases.map((t) => ({ summary: t.summary, criterion: t.criterion })), ...existingCoverage],
    };
    const out = (await runSubAgent<Verify>("verifier", input, mem("verifier"), runId, g.blocking > 0)).output;
    if (g.blocking === 0) return out;
    if (agentsAreLive()) await log(runId, `${g.blocking} blocking finding(s) from the quality gate — sent back without a model review`, "warn", "verifier");
    return {
      ...out,
      passed: false,
      defects: [
        ...out.defects,
        ...g.findings
          .filter((f) => f.severity === "block" && !f.fixed)
          .map((f) => ({ path: f.path, severity: "blocker" as const, issue: `${f.title} (line ${f.line}): ${f.text}`, fix: RULE_FIX[f.rule] ?? "" })),
      ],
    };
  };
  await startStage(runId, "verifier");
  let verified = await verify(authored.files, authored.testCases, gated.result);
  for (const d of verified.defects) {
    await log(runId, `[${d.severity}] ${d.path}: ${d.issue}`, d.severity === "minor" ? "info" : "warn", "verifier");
  }

  for (let attempt = 1; attempt <= MAX_REVISIONS && !verified.passed; attempt++) {
    const uncovered = verified.coverage.filter((c) => !c.covered).map((c) => c.criterion);
    await log(
      runId,
      `revision ${attempt}: ${verified.defects.length} defect(s), ${uncovered.length} uncovered criterion/criteria — sending back to spec-author`,
      "warn",
      "verifier"
    );

    await startStage(runId, "spec-author");
    const revised = (
      await runSubAgent<Author>("spec-author", {
        story: storyCtx,
        behaviours: [
          ...analysis.behaviours.map((b) => ({ name: b.name, criterion: b.criterion, kind: b.kind })),
          ...uncovered.map((c) => ({ name: `Cover: ${c.slice(0, 60)}`, criterion: c, kind: "happy-path" })),
        ],
        reuse: resolved.reuse.map((r) => ({ path: r.path, kind: r.kind })),
        create: resolved.create.map((c) => ({ path: c.path, kind: c.kind })),
        conventions: resolved.conventions,
        framework: ws.testFramework,
        strategy: plan,
        revision: {
          attempt,
          defects: verified.defects.map((d) => ({ path: d.path, issue: d.issue, fix: d.fix })),
          uncoveredCriteria: uncovered,
          previousFiles: authored.files.map((f) => ({ path: f.path, content: f.content })),
        },
      }, mem("spec-author"), runId)
    ).output;
    gated = await gate(runId, revised);
    const revisedGated = gated.authored;

    // Replace the previous attempt's output rather than accumulating duplicates.
    await db.asset.deleteMany({ where: { runId, reused: false } });
    await db.testCase.deleteMany({ where: { runId } });
    for (const f of revisedGated.files) {
      await db.asset.create({
        data: { runId, path: f.path, kind: f.kind, content: f.content, bytes: f.content.length },
      });
      await log(runId, `rewrote ${f.path}`, "ok", "spec-author");
    }
    for (const t of revised.testCases) {
      await db.testCase.create({
        data: {
          runId,
          storyId,
          summary: t.summary,
          testType: t.testType,
          priority: t.priority,
          stepsJson: JSON.stringify(t.steps),
          gherkin: t.gherkin,
          labelsJson: JSON.stringify(t.labels),
          criterion: t.criterion,
        },
      });
    }
    authored = revisedGated;
    await endStage(runId, "spec-author", "passed", `revision ${attempt}: ${revised.summary}`, revisedGated);
    await pace();

    await startStage(runId, "verifier");
    verified = await verify(authored.files, authored.testCases, gated.result);
    for (const d of verified.defects) {
      await log(runId, `[${d.severity}] ${d.path}: ${d.issue}`, d.severity === "minor" ? "info" : "warn", "verifier");
    }
  }

  await endStage(
    runId,
    "verifier",
    verified.passed ? "passed" : "blocked",
    verified.passed ? verified.summary : `${verified.summary} (still failing after ${MAX_REVISIONS} revisions)`,
    verified
  );

  await pace();

  // ------------------------------------------------------------ 7. review --
  await startStage(runId, "reviewer");
  const reviewed = (
    await runSubAgent<Review>("reviewer", {
      story: storyCtx,
      files: authored.files.map((f) => ({ path: f.path, content: f.content })),
      testCases: [...authored.testCases.map((t) => ({ summary: t.summary, criterion: t.criterion })), ...existingCoverage],
      verifier: {
        passed: verified.passed,
        defects: verified.defects.map((d) => ({ path: d.path, severity: d.severity, issue: d.issue })),
        coverage: verified.coverage.map((c) => ({ criterion: c.criterion, covered: c.covered })),
      },
    }, mem("reviewer"), runId)
  ).output;
  await endStage(runId, "reviewer", reviewed.verdict === "approve" ? "passed" : "blocked", reviewed.summary, reviewed);
  await pace();

  // Propose the publications. Still nothing written to Atlassian.
  if (reviewed.publishReady) {
    await db.publication.create({
      data: {
        runId,
        target: "xray-tests",
        payloadJson: JSON.stringify({
          // A story imported from Jira gets its tests in its own project.
          projectKey: (story.jiraId ? story.key.split("-")[0] : "") || ws.xrayProjectKey || ws.jiraProjectKey,
          storyKey: story.key,
          linkType: ws.testLinkType || "Test",
        }),
      },
    });
    await db.publication.create({
      data: {
        runId,
        target: "bitbucket-branch",
        payloadJson: JSON.stringify({
          workspace: ws.bitbucketWorkspace,
          repo: ws.bitbucketRepo,
          branch: authored.branchName,
          fromBranch: ws.defaultBranch,
          prTitle: reviewed.prTitle,
          prDescription: reviewed.prDescription,
          message: `test(${story.key}): specs generated by Autopilot`,
        }),
      },
    });
    await log(runId, "publications proposed — approve them to write to Xray and Bitbucket", "ok");
  }

  await db.story.update({
    where: { id: storyId },
    data: { status: reviewed.publishReady ? "specced" : "todo" },
  });
  await db.run.update({
    where: { id: runId },
    data: {
      status: reviewed.publishReady ? "needs_review" : "blocked",
      finishedAt: new Date(),
      outputJson: JSON.stringify({ analysis, clarification, strategy, resolved, authored, verified, reviewed, quality: gated.result }),
    },
  });

  // The test report, proposed as a comment on the Jira story. Like everything else, it is
  // written only when someone approves it.
  if (story.jiraId) {
    const { buildStoryReport, reportAsComment } = await import("./report");
    const report = await buildStoryReport(runId);
    if (report) {
      await db.publication.create({
        data: {
          runId,
          target: "jira-comment",
          payloadJson: JSON.stringify({ issueKey: story.key, body: reportAsComment(report), kind: "report" }),
        },
      });
      await log(runId, "test report ready — approve it to post it on the Jira story", "ok");
    }
  }
}
