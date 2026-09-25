import type { z } from "zod";
import { db } from "@/lib/db";
import { parseJson } from "@/lib/utils";
import type * as P from "./pipeline-schemas";

type Strategy = z.infer<typeof P.TestStrategistOut>;
type Analysis = z.infer<typeof P.StoryAnalyzerOut>;
type Clarify = z.infer<typeof P.ClarifyOut>;
type Verify = z.infer<typeof P.VerifierOut>;
type Review = z.infer<typeof P.ReviewerOut>;

/**
 * The test report for one story: what the agents decided and produced, traced back to each
 * acceptance criterion. Built from the run's stored stage outputs, so it can be regenerated at
 * any time and always matches what the run page shows.
 */
export interface StoryReport {
  story: { key: string; summary: string; url: string; status: string; sprint: string; parent: string; priority: string };
  generatedAt: string;
  mode: "live" | "simulated";
  verdict: string;
  publishReady: boolean;
  summary: string;
  approach: string;
  levels: { level: string; share: number; why: string }[];
  criteria: {
    criterion: string;
    priority: string;
    level: string;
    techniques: string[];
    automate: boolean;
    why: string;
    preconditions: string[];
    newTests: string[];
    existingTests: string[];
    covered: boolean;
  }[];
  newTests: { summary: string; priority: string; criterion: string; steps: number }[];
  existingTests: { key: string; summary: string }[];
  files: { path: string; kind: string; lines: number; reused: boolean }[];
  defects: { path: string; severity: string; issue: string }[];
  questions: { question: string; blocking: boolean }[];
  risks: { risk: string; mitigation: string }[];
  scopeNotes: string[];
  revisions: number;
  nextSteps: string[];
}

export async function buildStoryReport(runId: string): Promise<StoryReport | null> {
  const run = await db.run.findUnique({
    where: { id: runId },
    include: {
      story: true,
      testCases: { orderBy: { createdAt: "asc" } },
      assets: { orderBy: { createdAt: "asc" } },
      events: { where: { source: "verifier", message: { startsWith: "revision " } }, select: { id: true } },
      publications: { select: { target: true, status: true } },
    },
  });
  if (!run?.story) return null;
  const out = parseJson<{
    analysis?: Analysis;
    clarification?: Clarify;
    strategy?: Strategy;
    verified?: Verify;
    reviewed?: Review;
  }>(run.outputJson, {});
  const ctx = parseJson<{ sprint?: string; parent?: { key: string; summary: string } | null; priority?: string; status?: string; linkedTests?: { key: string; summary: string }[] }>(
    run.story.contextJson,
    {}
  );
  const strategy = out.strategy;
  const coverage = new Map((out.verified?.coverage ?? []).map((c) => [c.criterion, c.covered]));
  const criteriaList = strategy?.criteria.map((c) => c.criterion) ?? parseJson<string[]>(run.story.acceptanceCriteria, []);

  const criteria = criteriaList.map((criterion) => {
    const plan = strategy?.criteria.find((c) => c.criterion === criterion);
    return {
      criterion,
      priority: plan?.priority ?? "",
      level: plan?.level ?? "",
      techniques: plan?.techniques ?? [],
      automate: plan?.automate ?? true,
      why: plan?.why ?? "",
      preconditions: plan?.preconditions ?? [],
      newTests: run.testCases.filter((t) => t.criterion === criterion).map((t) => t.summary),
      existingTests: plan?.scenarios.filter((s) => s.coveredBy).map((s) => s.coveredBy) ?? [],
      covered: coverage.get(criterion) ?? run.testCases.some((t) => t.criterion === criterion),
    };
  });

  const mode = (await db.event.count({ where: { runId, message: { contains: "simulator" } } })) > 0 ? "simulated" : "live";
  const verdict = out.reviewed?.verdict ?? (run.status === "blocked" ? "blocked" : run.status);
  const report: StoryReport = {
    story: {
      key: run.story.key,
      summary: run.story.title,
      url: run.story.jiraUrl,
      status: ctx.status ?? "",
      sprint: ctx.sprint ?? "",
      parent: ctx.parent ? `${ctx.parent.key} ${ctx.parent.summary}` : "",
      priority: ctx.priority ?? "",
    },
    generatedAt: new Date().toISOString(),
    mode,
    verdict,
    publishReady: out.reviewed?.publishReady ?? false,
    summary: out.reviewed?.summary ?? out.analysis?.summary ?? "",
    approach: strategy?.approach ?? "",
    levels: strategy?.levels ?? [],
    criteria,
    newTests: run.testCases.map((t) => ({
      summary: t.summary,
      priority: t.priority,
      criterion: t.criterion,
      steps: parseJson<unknown[]>(t.stepsJson, []).length,
    })),
    existingTests: (ctx.linkedTests ?? []).map((t) => ({ key: t.key, summary: t.summary })),
    files: run.assets
      .filter((a) => a.kind !== "patch")
      .map((a) => ({ path: a.path, kind: a.kind, lines: a.content ? a.content.split("\n").length : 0, reused: a.reused })),
    defects: (out.verified?.defects ?? []).map((d) => ({ path: d.path, severity: d.severity, issue: d.issue })),
    questions: (out.clarification?.questions ?? []).map((q) => ({ question: q.question, blocking: q.blocking })),
    risks: strategy?.risks ?? [],
    scopeNotes: strategy?.scopeNotes ?? [],
    revisions: run.events.length,
    nextSteps: [],
  };
  const uncovered = criteria.filter((c) => !c.covered);
  report.nextSteps = [
    ...(report.questions.some((q) => q.blocking) ? ["Answer the blocking questions on the story, then run it again."] : []),
    ...(report.scopeNotes.length ? ["Confirm the current scope with the story owner — comments changed it after the criteria were written."] : []),
    ...(uncovered.length ? [`Close ${uncovered.length} uncovered criterion/criteria before sign-off.`] : []),
    ...(report.publishReady
      ? [
          `Approve the Xray proposal to create ${report.newTests.length} test(s) linked to ${report.story.key}.`,
          "Approve the Bitbucket proposal to open the pull request with the spec files.",
        ]
      : []),
    ...(report.mode === "simulated" ? ["Set ANTHROPIC_API_KEY so the agents reason about the story instead of applying rules."] : []),
  ];
  return report;
}

const pad = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The full report as Markdown, for download and for pasting into Confluence. */
export function reportMarkdown(r: StoryReport): string {
  const lines = [
    `# Test report — ${r.story.key}: ${r.story.summary}`,
    ``,
    [r.story.url && `[Open in Jira](${r.story.url})`, r.story.status && `Status: ${r.story.status}`, r.story.sprint && `Sprint: ${r.story.sprint}`, r.story.parent && `Epic: ${r.story.parent}`]
      .filter(Boolean)
      .join(" · "),
    ``,
    `**Verdict:** ${r.verdict}${r.publishReady ? " — ready to publish" : ""} · generated ${r.generatedAt.slice(0, 16).replace("T", " ")} UTC · agents ${r.mode}`,
    ``,
    r.summary,
    ``,
    `## Strategy`,
    ``,
    r.approach || "No strategy was produced (the run stopped earlier).",
    ...(r.levels.length ? [``, `| Level | Share | Why |`, `|---|---|---|`, ...r.levels.map((l) => `| ${l.level} | ${l.share}% | ${pad(l.why)} |`)] : []),
    ...(r.scopeNotes.length ? [``, `**Scope notes from comments**`, ...r.scopeNotes.map((n) => `- ${n}`)] : []),
    ``,
    `## Traceability — criterion → tests`,
    ``,
    `| # | Criterion | Priority | Level | Techniques | New tests | Existing | Covered |`,
    `|---|---|---|---|---|---|---|---|`,
    ...r.criteria.map(
      (c, i) =>
        `| ${i + 1} | ${pad(c.criterion.slice(0, 160))} | ${c.priority} | ${c.level}${c.automate ? "" : " (manual)"} | ${c.techniques.join(", ")} | ${c.newTests.length} | ${c.existingTests.join(", ") || "—"} | ${c.covered ? "yes" : "**no**"} |`
    ),
    ``,
    ...r.criteria.flatMap((c, i) =>
      c.why || c.preconditions.length
        ? [`**${i + 1}.** ${c.why}${c.preconditions.length ? ` Preconditions: ${c.preconditions.join("; ")}.` : ""}`, ``]
        : []
    ),
    `## New Xray tests (${r.newTests.length})`,
    ``,
    ...(r.newTests.length ? r.newTests.map((t) => `- ${t.summary} — ${t.priority}, ${t.steps} step(s)`) : ["None proposed."]),
    ``,
    `## Existing Xray tests (${r.existingTests.length})`,
    ``,
    ...(r.existingTests.length ? r.existingTests.map((t) => `- ${t.key} ${t.summary}`) : ["None linked before this run."]),
    ``,
    `## Automation`,
    ``,
    ...(r.files.length ? r.files.map((f) => `- \`${f.path}\` — ${f.kind}${f.reused ? " (reused)" : `, ${f.lines} lines`}`) : ["No files."]),
    ...(r.revisions ? [``, `The verifier sent the first draft back ${r.revisions} time(s) before it passed or stopped.`] : []),
    ...(r.defects.length ? [``, `**Open defects in the generated code**`, ...r.defects.map((d) => `- [${d.severity}] ${d.path}: ${d.issue}`)] : []),
    ...(r.questions.length ? [``, `## Open questions`, ``, ...r.questions.map((q) => `- ${q.blocking ? "**Blocking:** " : ""}${q.question}`)] : []),
    ...(r.risks.length ? [``, `## Risks`, ``, ...r.risks.map((x) => `- ${x.risk} — ${x.mitigation}`)] : []),
    ``,
    `## Next steps`,
    ``,
    ...r.nextSteps.map((s) => `- ${s}`),
    ``,
  ];
  return lines.join("\n");
}

/** A shorter plain-text version for a Jira comment: blank lines separate paragraphs. */
export function reportAsComment(r: StoryReport): string {
  const covered = r.criteria.filter((c) => c.covered).length;
  return [
    `Autopilot test report for ${r.story.key} — ${r.verdict}${r.publishReady ? ", ready to publish" : ""}.`,
    `Strategy: ${r.approach}`,
    `Coverage: ${covered}/${r.criteria.length} acceptance criteria covered; ${r.newTests.length} new Xray test(s) proposed, ${r.existingTests.length} existing test(s) reused.`,
    r.criteria
      .map((c, i) => `${i + 1}. ${c.priority} ${c.level} (${c.techniques.join(", ")}) — ${c.criterion.slice(0, 120)}${c.covered ? "" : " — NOT COVERED"}`)
      .join("\n"),
    ...(r.scopeNotes.length ? [`Scope notes: ${r.scopeNotes.join(" | ").slice(0, 600)}`] : []),
    ...(r.questions.length ? [`Open questions: ${r.questions.map((q) => q.question).join(" | ").slice(0, 600)}`] : []),
    `Next: ${r.nextSteps.join(" ")}`,
  ].join("\n\n");
}
