import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { SUB_AGENTS, type SubAgentId, type SubAgentDef } from "./pipeline-registry";
import { agentsAreLive } from "./runtime";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/utils";
import * as P from "./pipeline-schemas";
import { listFiles } from "@/lib/atlassian/bitbucket";
import { bitbucketConfigured } from "@/lib/atlassian/config";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

type Analyzer = z.infer<typeof P.StoryAnalyzerOut>;
type Clarify = z.infer<typeof P.ClarifyOut>;
type Resolver = z.infer<typeof P.AssetResolverOut>;
type Author = z.infer<typeof P.SpecAuthorOut>;
type Verify = z.infer<typeof P.VerifierOut>;
type Review = z.infer<typeof P.ReviewerOut>;

function toolSchema(schema: z.ZodType) {
  const json = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
  delete json.$schema;
  return json as Anthropic.Tool.InputSchema;
}

/** Runs one sub-agent. Same forced-tool-call contract as the top-level agents. */
async function runSubAgent<T>(id: SubAgentId, input: unknown): Promise<{ output: T; mode: "live" | "simulated" }> {
  const def = SUB_AGENTS[id] as unknown as SubAgentDef;
  const parsed = def.input.safeParse(input);
  if (!parsed.success) {
    throw new Error(
      `${id} rejected its input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "root"} ${i.message}`).join("; ")}`
    );
  }

  if (!agentsAreLive()) {
    return { output: def.output.parse(def.simulate(parsed.data)) as T, mode: "simulated" };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: def.maxTokens ?? 4000,
    system: def.system,
    tools: [{ name: def.tool, description: def.toolDescription, input_schema: toolSchema(def.output) }],
    tool_choice: { type: "tool", name: def.tool },
    messages: [{ role: "user", content: def.prompt(parsed.data) }],
  });

  const block = message.content.find((c) => c.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(`${id} returned no structured result (stop reason: ${message.stop_reason}).`);
  }
  const out = def.output.safeParse(block.input);
  if (!out.success) {
    throw new Error(
      `${id} returned a result that did not match its schema: ${out.error.issues
        .map((i) => `${i.path.join(".") || "root"} ${i.message}`)
        .join("; ")}`
    );
  }
  return { output: out.data as T, mode: "live" };
}

async function log(
  runId: string,
  message: string,
  level: "info" | "ok" | "warn" | "error" = "info",
  stage = "pipeline"
) {
  await db.event.create({ data: { runId, message, level, source: stage, stage } });
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
 * The qe-pipeline: one Jira story walked through six sub-agents.
 *
 * story-analyzer → clarify → asset-resolver → spec-author → verifier → reviewer
 *
 * A blocking clarification stops the chain rather than letting a guess flow downstream, and
 * nothing is written to Jira, Xray or Bitbucket here — the reviewer's approval only produces
 * Publication rows for a human to approve.
 */
export async function runPipeline(opts: { runId: string; storyId: string }): Promise<void> {
  const { runId, storyId } = opts;

  const story = await db.story.findUniqueOrThrow({
    where: { id: storyId },
    include: { sprint: { include: { workspace: true } } },
  });
  const ws = story.sprint.workspace;

  const storyCtx = {
    key: story.key,
    summary: story.title,
    description: story.description,
    acceptanceCriteria: parseJson<string[]>(story.acceptanceCriteria, []),
    issueType: story.issueType || "Story",
    labels: parseJson<string[]>(story.tagsJson, []),
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
  const analysis = (await runSubAgent<Analyzer>("story-analyzer", { story: storyCtx, framework: ws.testFramework })).output;
  await endStage(runId, "story-analyzer", analysis.testable ? "passed" : "blocked", analysis.summary, analysis);
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
    clarification = (await runSubAgent<Clarify>("clarify", { story: storyCtx, ambiguities: analysis.ambiguities })).output;
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

  // ----------------------------------------------------- 3. resolve assets --
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

  const resolved = (
    await runSubAgent<Resolver>("asset-resolver", {
      story: storyCtx,
      behaviours: analysis.behaviours.map((b) => ({ name: b.name, criterion: b.criterion })),
      repoPaths,
      framework: ws.testFramework,
    })
  ).output;
  await endStage(runId, "asset-resolver", "passed", resolved.summary, resolved);
  for (const r of resolved.reuse) await log(runId, `reuse ${r.path} — ${r.why}`, "ok", "asset-resolver");

  // -------------------------------------------------------- 4. write specs --
  await startStage(runId, "spec-author");
  let authored = (
    await runSubAgent<Author>("spec-author", {
      story: storyCtx,
      behaviours: analysis.behaviours.map((b) => ({ name: b.name, criterion: b.criterion, kind: b.kind })),
      reuse: resolved.reuse.map((r) => ({ path: r.path, kind: r.kind })),
      create: resolved.create.map((c) => ({ path: c.path, kind: c.kind })),
      conventions: resolved.conventions,
      framework: ws.testFramework,
    })
  ).output;

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

  // ------------------------------------------------------------ 5. verify --
  // The verifier is adversarial, so a first pass often finds real defects. Rather than
  // stopping there, spec-author gets the findings back and revises. Two attempts: enough
  // to fix what a careful author would catch on re-read, not enough to loop forever.
  const MAX_REVISIONS = 2;
  await startStage(runId, "verifier");
  let verified = (
    await runSubAgent<Verify>("verifier", {
      story: storyCtx,
      behaviours: analysis.behaviours.map((b) => ({ name: b.name, criterion: b.criterion })),
      files: authored.files.map((f) => ({ path: f.path, content: f.content })),
      testCases: authored.testCases.map((t) => ({ summary: t.summary, criterion: t.criterion })),
    })
  ).output;
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
        revision: {
          attempt,
          defects: verified.defects.map((d) => ({ path: d.path, issue: d.issue, fix: d.fix })),
          uncoveredCriteria: uncovered,
          previousFiles: authored.files.map((f) => ({ path: f.path, content: f.content })),
        },
      })
    ).output;

    // Replace the previous attempt's output rather than accumulating duplicates.
    await db.asset.deleteMany({ where: { runId, reused: false } });
    await db.testCase.deleteMany({ where: { runId } });
    for (const f of revised.files) {
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
    authored = revised;
    await endStage(runId, "spec-author", "passed", `revision ${attempt}: ${revised.summary}`, revised);

    await startStage(runId, "verifier");
    verified = (
      await runSubAgent<Verify>("verifier", {
        story: storyCtx,
        behaviours: analysis.behaviours.map((b) => ({ name: b.name, criterion: b.criterion })),
        files: revised.files.map((f) => ({ path: f.path, content: f.content })),
        testCases: revised.testCases.map((t) => ({ summary: t.summary, criterion: t.criterion })),
      })
    ).output;
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

  // ------------------------------------------------------------ 6. review --
  await startStage(runId, "reviewer");
  const reviewed = (
    await runSubAgent<Review>("reviewer", {
      story: storyCtx,
      files: authored.files.map((f) => ({ path: f.path, content: f.content })),
      testCases: authored.testCases.map((t) => ({ summary: t.summary, criterion: t.criterion })),
      verifier: {
        passed: verified.passed,
        defects: verified.defects.map((d) => ({ path: d.path, severity: d.severity, issue: d.issue })),
        coverage: verified.coverage.map((c) => ({ criterion: c.criterion, covered: c.covered })),
      },
    })
  ).output;
  await endStage(runId, "reviewer", reviewed.verdict === "approve" ? "passed" : "blocked", reviewed.summary, reviewed);

  // Propose the publications. Still nothing written to Atlassian.
  if (reviewed.publishReady) {
    await db.publication.create({
      data: {
        runId,
        target: "xray-tests",
        payloadJson: JSON.stringify({
          projectKey: ws.xrayProjectKey || ws.jiraProjectKey,
          storyKey: story.key,
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
          message: `test(${story.key}): specs generated by Gantry`,
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
      outputJson: JSON.stringify({ analysis, clarification, resolved, authored, verified, reviewed }),
    },
  });
}
