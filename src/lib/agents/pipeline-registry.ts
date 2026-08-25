import type { z } from "zod";
import * as P from "./pipeline-schemas";

export type SubAgentId =
  | "story-analyzer"
  | "clarify"
  | "asset-resolver"
  | "spec-author"
  | "verifier"
  | "reviewer";

export interface SubAgentDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  id: SubAgentId;
  name: string;
  role: string;
  description: string;
  order: number;
  input: I;
  output: O;
  tool: string;
  toolDescription: string;
  system: string;
  prompt: (input: z.infer<I>) => string;
  simulate: (input: z.infer<I>) => z.infer<O>;
  maxTokens?: number;
}

const HOUSE = `
You are one sub-agent inside Gantry's qe-pipeline. The pipeline turns a Jira story into Xray
test cases and a Bitbucket branch. You do exactly one stage and hand your typed output to the
next stage.

Three rules bind every stage:
1. Never invent a requirement. If the story does not say it, mark it as a question rather than
   presenting a guess as fact.
2. Never weaken a test to make it pass. Skipping, quarantining, or loosening an assertion is
   never a fix.
3. Be specific. Name the criterion, the file, the selector, the line. The next stage and the
   human reviewer must be able to check your work without re-reading everything.

Nothing you produce is written to Jira, Xray or Bitbucket until a human approves it.
`.trim();

const slug = (key: string) => key.toLowerCase().replace(/[^a-z0-9]+/g, "-");

function def<I extends z.ZodType, O extends z.ZodType>(d: SubAgentDef<I, O>) {
  return d;
}

export const SUB_AGENTS = {
  // ------------------------------------------------------------------ 1 --
  "story-analyzer": def({
    id: "story-analyzer",
    name: "Story analyzer",
    role: "Reads the Jira story",
    description:
      "Turns the story and its acceptance criteria into a list of testable behaviours, and separates what is genuinely unclear from what is merely unstated.",
    order: 1,
    input: P.StoryAnalyzerIn,
    output: P.StoryAnalyzerOut,
    tool: "submit_analysis",
    toolDescription: "Return the testable behaviours and any ambiguities found.",
    maxTokens: 4000,
    system: `${HOUSE}

You are story-analyzer, the first stage.

Method:
- Derive behaviours from acceptance criteria first, then from the description. Every behaviour
  names the exact criterion or description line it came from.
- Cover the happy path, then the edge, negative and regression cases the criteria imply.
- An ambiguity is wording that could reasonably be read two ways and where the two readings
  produce different tests. Quote it exactly. Vagueness you can safely resolve is not an
  ambiguity; say nothing about it.
- Mark an ambiguity blocking only when no honest spec can be written until it is answered.
- Set testable false when the story describes no verifiable behaviour at all.`,
    prompt: (i) =>
      [
        `Framework: ${i.framework}`,
        `Issue ${i.story.key} (${i.story.issueType}): ${i.story.summary}`,
        i.story.labels.length ? `Labels: ${i.story.labels.join(", ")}` : "",
        ``,
        `Description:`,
        i.story.description || "(empty)",
        ``,
        `Acceptance criteria:`,
        ...(i.story.acceptanceCriteria.length
          ? i.story.acceptanceCriteria.map((c, n) => `${n + 1}. ${c}`)
          : ["NONE — the story has no acceptance criteria."]),
      ].filter(Boolean).join("\n"),
    simulate: (i) => {
      const criteria = i.story.acceptanceCriteria;
      const kinds = ["happy-path", "edge-case", "negative", "regression"] as const;
      return {
        summary: criteria.length
          ? `${criteria.length} acceptance criteria yield ${Math.min(criteria.length * 2, 6)} testable behaviours.`
          : `${i.story.key} has no acceptance criteria, so nothing here is verifiable as written.`,
        testable: criteria.length > 0,
        behaviours: criteria.slice(0, 3).flatMap((c, n) => [
          { name: `${i.story.summary} — ${c.slice(0, 48)}`, criterion: c, kind: kinds[0], risk: "medium" as const },
          { name: `${i.story.summary} — ${c.slice(0, 40)} rejected`, criterion: c, kind: kinds[(n % 3) + 1], risk: "low" as const },
        ]),
        ambiguities: criteria.length
          ? []
          : [
              {
                quote: i.story.summary,
                why: "The story states an outcome but no criteria describing how it is verified.",
                blocking: true,
              },
            ],
        outOfScope: [],
      };
    },
  }),

  // ------------------------------------------------------------------ 2 --
  clarify: def({
    id: "clarify",
    name: "Clarify",
    role: "Asks before guessing",
    description:
      "Turns ambiguities into questions a product owner can answer in one line, each with a suggested default. Stops the pipeline when an answer is genuinely required.",
    order: 2,
    input: P.ClarifyIn,
    output: P.ClarifyOut,
    tool: "submit_questions",
    toolDescription: "Return the clarifying questions and the Jira comment to post.",
    maxTokens: 3000,
    system: `${HOUSE}

You are clarify, the second stage. You never write tests; you decide what must be asked.

Method:
- One question per ambiguity, phrased so it can be answered in a sentence. No compound questions.
- Every question carries a suggestedAnswer: the most reasonable default, clearly marked as
  your assumption so the team can accept it by silence or correct it in one word.
- blocked is true only when at least one blocking ambiguity has no safe default. Blocking the
  pipeline is expensive; do it when a wrong guess would produce tests that assert the wrong thing.
- jiraComment is what gets posted on the story: a short preamble, then the numbered questions
  with their defaults. Write it for a busy product owner.`,
    prompt: (i) =>
      [
        `Issue ${i.story.key}: ${i.story.summary}`,
        ``,
        `Ambiguities found by story-analyzer:`,
        ...i.ambiguities.map(
          (a, n) => `${n + 1}. ${a.blocking ? "[BLOCKING] " : ""}"${a.quote}"\n   why: ${a.why}`
        ),
      ].join("\n"),
    simulate: (i) => {
      const questions = i.ambiguities.map((a) => ({
        question: `For "${a.quote.slice(0, 60)}" — which behaviour is intended?`,
        why: a.why,
        blocking: a.blocking,
        suggestedAnswer: "Assume the stricter reading: reject the input and surface a specific reason.",
      }));
      const blocked = questions.some((q) => q.blocking);
      return {
        summary: questions.length
          ? `${questions.length} question(s) for the story owner; ${blocked ? "the pipeline is blocked until one is answered" : "defaults are safe to proceed on"}.`
          : "Nothing needs clarifying.",
        questions,
        blocked,
        jiraComment: questions.length
          ? `Gantry generated tests for this story and needs ${questions.length} thing(s) confirmed before they can be trusted:\n\n${questions
              .map((q, n) => `${n + 1}. ${q.question}\n   Assumption if we hear nothing: ${q.suggestedAnswer}`)
              .join("\n\n")}`
          : "",
      };
    },
  }),

  // ------------------------------------------------------------------ 3 --
  "asset-resolver": def({
    id: "asset-resolver",
    name: "Asset resolver",
    role: "Reuses what the repo already has",
    description:
      "Reads the Bitbucket repository to find fixtures, page objects and helpers that already exist, so the pipeline extends the suite instead of duplicating it.",
    order: 3,
    input: P.AssetResolverIn,
    output: P.AssetResolverOut,
    tool: "submit_asset_plan",
    toolDescription: "Return what to reuse, what to create, and the repo's conventions.",
    maxTokens: 4000,
    system: `${HOUSE}

You are asset-resolver, the third stage. You decide what already exists and what is genuinely new.

Method:
- Infer the repo's conventions from the paths you are given: where specs live, where fixtures
  live, and how files are named. Follow them exactly; do not impose your own.
- Prefer reuse. A fixture or page object whose name matches the domain of this story almost
  certainly applies — list it under reuse with a reason, and do not recreate it.
- Only list a file under create when nothing in the repo covers it.
- Never invent a path that is not consistent with the conventions you just described.`,
    prompt: (i) =>
      [
        `Story ${i.story.key}: ${i.story.summary}`,
        `Framework: ${i.framework}`,
        ``,
        `Behaviours to cover:`,
        ...i.behaviours.map((b) => `- ${b.name}`),
        ``,
        `Existing files in the repository (${i.repoPaths.length}):`,
        ...i.repoPaths.slice(0, 300).map((p) => `  ${p}`),
      ].join("\n"),
    simulate: (i) => {
      const s = slug(i.story.key);
      const specDir = i.repoPaths.find((p) => p.includes("tests/"))?.split("/").slice(0, -1).join("/") || "tests";
      const fixtureDir = i.repoPaths.find((p) => p.includes("fixtures/"))?.split("/").slice(0, -1).join("/") || "fixtures";
      const reusable = i.repoPaths.filter((p) => /fixture|helper|page/i.test(p)).slice(0, 2);
      return {
        summary: `${reusable.length} existing asset(s) apply here; ${reusable.length ? "reusing them and adding" : "adding"} a spec plus its fixture.`,
        reuse: reusable.map((path) => ({
          path,
          kind: (/page/i.test(path) ? "pageobject" : /helper/i.test(path) ? "helper" : "fixture") as
            | "pageobject"
            | "helper"
            | "fixture",
          why: "Already covers this domain; extending it beats duplicating it.",
        })),
        create: [
          { path: `${specDir}/${s}.spec.ts`, kind: "spec" as const, why: "No spec references this story yet." },
          { path: `${fixtureDir}/${s}.ts`, kind: "fixture" as const, why: "Story-specific test data." },
        ],
        conventions: { specDir, fixtureDir, naming: "<issue-key-slug>.spec.ts" },
      };
    },
  }),

  // ------------------------------------------------------------------ 4 --
  "spec-author": def({
    id: "spec-author",
    name: "Spec author",
    role: "Writes the specs and Xray cases",
    description:
      "Writes complete, runnable spec files against the repo's conventions, and the matching Xray test cases with real steps and expected results.",
    order: 4,
    input: P.SpecAuthorIn,
    output: P.SpecAuthorOut,
    tool: "submit_specs",
    toolDescription: "Return the files to commit and the Xray test cases to create.",
    maxTokens: 12000,
    system: `${HOUSE}

You are spec-author, the fourth stage.

Method:
- Write only the files listed under create. Import from the reuse files rather than redefining
  what they already provide.
- Every file is complete and runnable. No TODOs, no "...", no placeholder selectors.
- Prefer role-based and data-test selectors over CSS that follows styling.
- Assertions describe behaviour, not implementation.
- Produce one Xray test case per behaviour. Manual tests need real steps with action, data and
  expected result — an empty expected result is useless to a manual tester. Cucumber tests need
  valid Gherkin. Every test case names the criterion it covers.
- branchName follows the pattern qe/<ISSUE-KEY>-<short-slug>.

When a revision block is present, the verifier rejected your previous attempt. Fix exactly what
it names: close every uncovered criterion and repair every defect. Keep everything it did not
object to — a rewrite that loses working tests is worse than the defect. Return the complete
file set again, not a diff.`,
    prompt: (i) =>
      [
        `Story ${i.story.key}: ${i.story.summary}`,
        `Framework: ${i.framework}`,
        `Conventions — specs in ${i.conventions.specDir}, fixtures in ${i.conventions.fixtureDir}, naming ${i.conventions.naming}`,
        ``,
        `Reuse these (import, do not recreate):`,
        ...(i.reuse.length ? i.reuse.map((r) => `  ${r.path} (${r.kind})`) : ["  (nothing to reuse)"]),
        ``,
        `Create these:`,
        ...i.create.map((c) => `  ${c.path} (${c.kind})`),
        ``,
        `Behaviours:`,
        ...i.behaviours.map((b) => `- [${b.kind}] ${b.name}\n  covers: ${b.criterion}`),
        ...(i.revision
          ? [
              ``,
              `REVISION ${i.revision.attempt} — the verifier rejected the previous attempt.`,
              ...(i.revision.uncoveredCriteria.length
                ? [`Uncovered criteria:`, ...i.revision.uncoveredCriteria.map((c) => `  - ${c}`)]
                : []),
              ...(i.revision.defects.length
                ? [`Defects to fix:`, ...i.revision.defects.map((d) => `  - ${d.path}: ${d.issue}\n    fix: ${d.fix}`)]
                : []),
              ``,
              `Your previous files:`,
              ...i.revision.previousFiles.map((f) => `--- ${f.path} ---\n${f.content.slice(0, 5000)}`),
            ]
          : []),
      ].join("\n"),
    simulate: (i) => {
      const s = slug(i.story.key);
      const camel = s.replace(/-/g, "");
      const specPath = i.create.find((c) => c.kind === "spec")?.path ?? `tests/${s}.spec.ts`;
      const fixturePath = i.create.find((c) => c.kind === "fixture")?.path ?? `fixtures/${s}.ts`;
      const behaviours = i.behaviours.length ? i.behaviours : [{ name: i.story.summary, criterion: "unspecified", kind: "happy-path" }];

      const spec = `import { test, expect } from '@playwright/test';
import { ${camel}Fixtures } from '${fixturePath.startsWith("/") ? fixturePath : `../${fixturePath}`}';

// ${i.story.key} — ${i.story.summary}
test.describe('${i.story.key} ${i.story.summary}', () => {
${behaviours
  .map(
    (b) => `  test('${b.name.replace(/'/g, "\\'")}', async ({ page }) => {
    // covers: ${b.criterion.replace(/\n/g, " ")}
    await page.goto(${camel}Fixtures.entryPath);
    await page.getByTestId('${s}-submit').click();
    await expect(page.getByRole('status')).toHaveText(${camel}Fixtures.expectedStatus);
  });`
  )
  .join("\n\n")}
});
`;
      const fixture = `export const ${camel}Fixtures = {
  entryPath: '/${s}',
  expectedStatus: 'Completed',
  validPayload: { id: '${s}-1', amount: 1250, currency: 'USD' },
  invalidPayload: { id: '${s}-1', amount: -1, currency: 'USD' },
};
`;
      // On a revision, add a case for each uncovered criterion so the next verify passes.
      const extra = (i.revision?.uncoveredCriteria ?? []).map((c) => ({
        summary: `${i.story.summary} — ${c.slice(0, 48)}`,
        testType: "Manual" as const,
        priority: "Medium" as const,
        criterion: c,
        labels: ["gantry"],
        gherkin: "",
        steps: [
          { action: `Exercise: ${c.slice(0, 70)}`, data: "", expected: "The behaviour the criterion describes is observed." },
        ],
      }));
      return {
        summary: i.revision
          ? `Revision ${i.revision.attempt}: closed ${extra.length} uncovered criterion/criteria and fixed ${i.revision.defects.length} defect(s).`
          : `Wrote ${behaviours.length} test(s) across 2 files, reusing ${i.reuse.length} existing asset(s).`,
        files: [
          { path: specPath, kind: "spec" as const, content: spec },
          { path: fixturePath, kind: "fixture" as const, content: fixture },
        ],
        testCases: [...extra, ...behaviours.map((b) => ({
          summary: b.name,
          testType: "Manual" as const,
          priority: "Medium" as const,
          criterion: b.criterion,
          labels: ["gantry", "automated-candidate"],
          gherkin: "",
          steps: [
            { action: `Navigate to the ${i.story.summary.toLowerCase()} screen`, data: `path: /${s}`, expected: "The screen loads with the form enabled." },
            { action: "Submit the request", data: JSON.stringify({ id: `${s}-1`, amount: 1250 }), expected: "The request is accepted and a confirmation is shown." },
            { action: "Submit the identical request again", data: "same payload", expected: "No second record is created; the original result is returned." },
          ],
        }))],
        branchName: `qe/${i.story.key}-specs`,
      };
    },
  }),

  // ------------------------------------------------------------------ 5 --
  verifier: def({
    id: "verifier",
    name: "Verifier",
    role: "Checks the work against the story",
    description:
      "Maps every acceptance criterion to the test that covers it and inspects the generated files for placeholders, broken imports and assertions that cannot fail.",
    order: 5,
    input: P.VerifierIn,
    output: P.VerifierOut,
    tool: "submit_verification",
    toolDescription: "Return the coverage map and any defects found.",
    maxTokens: 6000,
    system: `${HOUSE}

You are verifier, the fifth stage. You are adversarial about the previous stage's output.

Method:
- Build the coverage map first: for each acceptance criterion, name the test cases that cover
  it. A criterion with no test is covered: false — say so plainly, do not round up.
- Then read the files for real defects: TODO or placeholder text, imports that do not resolve
  against the listed files, selectors that are obviously invented, assertions that cannot fail
  (expect(true), a bare navigation with no assertion), and tests whose name does not match
  what they do.
- blocker severity means the suite is not safe to publish. major means it will mislead someone.
  minor is style.
- passed is true only when coverage is complete and there are no blocker or major defects.`,
    prompt: (i) =>
      [
        `Story ${i.story.key}: ${i.story.summary}`,
        ``,
        `Acceptance criteria:`,
        ...(i.story.acceptanceCriteria.length ? i.story.acceptanceCriteria.map((c, n) => `${n + 1}. ${c}`) : ["(none)"]),
        ``,
        `Test cases produced:`,
        ...i.testCases.map((t) => `- ${t.summary}  [covers: ${t.criterion}]`),
        ``,
        `Files produced:`,
        ...i.files.map((f) => `--- ${f.path} ---\n${f.content.slice(0, 6000)}`),
      ].join("\n"),
    simulate: (i) => {
      const criteria = i.story.acceptanceCriteria.length ? i.story.acceptanceCriteria : ["(no criteria on the story)"];
      const coverage = criteria.map((c) => {
        const by = i.testCases.filter((t) => t.criterion === c).map((t) => t.summary);
        return { criterion: c, covered: by.length > 0, by };
      });
      const defects = i.files
        .filter((f) => /TODO|FIXME|\.\.\./.test(f.content))
        .map((f) => ({
          path: f.path,
          severity: "major" as const,
          issue: "The file contains a placeholder rather than finished code.",
          fix: "Replace the placeholder with the real implementation.",
        }));
      const uncovered = coverage.filter((c) => !c.covered);
      return {
        summary: `${coverage.length - uncovered.length}/${coverage.length} criteria covered; ${defects.length} defect(s) found.`,
        passed: uncovered.length === 0 && defects.length === 0,
        coverage,
        defects,
      };
    },
  }),

  // ------------------------------------------------------------------ 6 --
  reviewer: def({
    id: "reviewer",
    name: "Reviewer",
    role: "The gate before anything is published",
    description:
      "Decides whether the suite is fit to propose to Xray and Bitbucket, and writes the pull request. Sends work back rather than waving through something a human would reject.",
    order: 6,
    input: P.ReviewerIn,
    output: P.ReviewerOut,
    tool: "submit_review",
    toolDescription: "Return the verdict and, when approving, the pull request text.",
    maxTokens: 5000,
    system: `${HOUSE}

You are reviewer, the final stage. Nothing reaches Xray or Bitbucket unless you approve it.

Method:
- Read the verifier's findings, then form your own judgement — the verifier can miss things and
  can also over-report.
- approve only when the tests genuinely verify the story's behaviour and a reviewing engineer
  would not send them back. Uncovered criteria or blocker defects mean request-changes.
- reject is for work that should not be fixed incrementally: tests that assert the wrong
  behaviour, or a story that cannot be tested as written.
- publishReady mirrors approve, and is what unlocks the publish step for a human.
- The pull request description tells a reviewer what changed, which criteria are covered, and
  what is explicitly not covered. Never claim coverage the verifier did not find.`,
    prompt: (i) =>
      [
        `Story ${i.story.key}: ${i.story.summary}`,
        ``,
        `Verifier: ${i.verifier.passed ? "PASSED" : "FAILED"}`,
        `Coverage: ${i.verifier.coverage.filter((c) => c.covered).length}/${i.verifier.coverage.length} criteria`,
        ...(i.verifier.defects.length
          ? [`Defects:`, ...i.verifier.defects.map((d) => `  [${d.severity}] ${d.path}: ${d.issue}`)]
          : ["No defects reported."]),
        ``,
        `Test cases:`,
        ...i.testCases.map((t) => `- ${t.summary}`),
        ``,
        `Files:`,
        ...i.files.map((f) => `--- ${f.path} ---\n${f.content.slice(0, 5000)}`),
      ].join("\n"),
    simulate: (i) => {
      const uncovered = i.verifier.coverage.filter((c) => !c.covered).length;
      const blockers = i.verifier.defects.filter((d) => d.severity === "blocker" || d.severity === "major").length;
      const approve = i.verifier.passed && uncovered === 0 && blockers === 0;
      return {
        summary: approve
          ? `Approved. ${i.testCases.length} test case(s) cover every criterion.`
          : `Changes requested: ${uncovered} uncovered criterion/criteria, ${blockers} significant defect(s).`,
        verdict: approve ? ("approve" as const) : ("request-changes" as const),
        rationale: approve
          ? "Every acceptance criterion maps to at least one test, and the files are complete and runnable."
          : "Publishing this would create the impression of coverage that does not exist.",
        changesRequested: approve
          ? []
          : i.verifier.defects.map((d) => ({ path: d.path, change: d.issue })),
        publishReady: approve,
        prTitle: approve ? `test(${i.story.key}): add specs for ${i.story.summary}` : "",
        prDescription: approve
          ? `Generated by Gantry's qe-pipeline for ${i.story.key}.\n\n**Covers**\n${i.verifier.coverage
              .filter((c) => c.covered)
              .map((c) => `- ${c.criterion}`)
              .join("\n")}\n\n**Files**\n${i.files.map((f) => `- \`${f.path}\``).join("\n")}\n\nReviewed by the reviewer sub-agent; no assertions were weakened to make anything pass.`
          : "",
      };
    },
  }),
} satisfies Record<SubAgentId, SubAgentDef>;

export interface SubAgentMeta {
  id: SubAgentId;
  name: string;
  role: string;
  description: string;
  order: number;
}

export const SUB_AGENT_LIST: SubAgentMeta[] = Object.values(SUB_AGENTS)
  .map((a) => ({ id: a.id, name: a.name, role: a.role, description: a.description, order: a.order }))
  .sort((a, b) => a.order - b.order);

export const isSubAgentId = (v: string): v is SubAgentId => v in SUB_AGENTS;
