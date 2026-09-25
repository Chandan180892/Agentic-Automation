import type { z } from "zod";
import * as P from "./pipeline-schemas";
import { hasLesson, type Memory } from "./types";
import { rulebookPrompt } from "./rulebook";
import type { Effort } from "./llm";

export type SubAgentId =
  | "story-analyzer"
  | "clarify"
  | "test-strategist"
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
  simulate: (input: z.infer<I>, memory?: Memory) => z.infer<O>;
  maxTokens?: number;
  /** Thinking effort for this stage: low for reading and routing, high for code and the final gate. */
  effort: Effort;
  /** "fast" stages run on ANTHROPIC_FAST_MODEL when one is configured. */
  tier: "main" | "fast";
}

const RULEBOOK = rulebookPrompt();

const HOUSE = `
You are one sub-agent inside Autopilot's qe-pipeline. The pipeline turns a Jira story into Xray
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

type Story = z.infer<typeof P.StoryContext>;

/** Everything the agents know about the story, laid out once for every prompt. */
export function storyText(story: Story, opts: { criteria?: boolean } = {}) {
  return [
    `Issue ${story.key} (${story.issueType}${story.priority ? `, priority ${story.priority}` : ""}): ${story.summary}`,
    story.parent ? `Epic: ${story.parent}` : "",
    story.labels.length ? `Labels: ${story.labels.join(", ")}` : "",
    story.components.length ? `Components: ${story.components.join(", ")}` : "",
    ``,
    `Description:`,
    story.description || "(empty)",
    ...(opts.criteria === false
      ? []
      : [
          ``,
          `Acceptance criteria:`,
          ...(story.acceptanceCriteria.length
            ? story.acceptanceCriteria.map((c, n) => `${n + 1}. ${c}`)
            : ["NONE — the story has no acceptance criteria."]),
        ]),
    ...(story.testCriteria ? [``, `Team's test notes (Test Criteria), verbatim:`, story.testCriteria.slice(0, 6000)] : []),
    ...(story.comments.length
      ? [``, `Comments, oldest first — later ones can change the scope:`, ...story.comments.map((c) => `- ${c.slice(0, 800)}`)]
      : []),
    ...(story.existingTests.length
      ? [``, `Tests already linked in Xray (extend, never duplicate):`, ...story.existingTests.map((t) => `- ${t.key} ${t.summary}`)]
      : []),
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");
}

// ------------------------------------------------ manual steps from a criterion --

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
type Kind = "positive" | "negative" | "edge";

/** Turns a Given/When/Then criterion into Xray steps, with setup first. */
export function stepsFor(criterion: string, kind: Kind, preconditions: string[] = []) {
  const body = criterion.replace(/^[^:]{0,80}:\s*/, "");
  const given = body.match(/given (.*?)(?= when |$)/i)?.[1]?.trim();
  const when = body.match(/when (.*?)(?= then |$)/i)?.[1]?.trim();
  const then = body.match(/then (.*)$/i)?.[1]?.trim();
  const setup = preconditions.length ? preconditions.join("; ") : given ?? "";
  const steps: { action: string; data: string; expected: string }[] = [];
  if (setup) steps.push({ action: "Set up the preconditions", data: setup, expected: "The system is in the stated starting state." });
  const act = when ? cap(when.replace(/[.;]+$/, "")) : `Exercise: ${body.slice(0, 120)}`;
  steps.push({
    action: kind === "negative" ? `With one precondition not met — ${act.charAt(0).toLowerCase()}${act.slice(1)}` : kind === "edge" ? `At the limit — ${act.charAt(0).toLowerCase()}${act.slice(1)}` : act,
    data: "",
    expected:
      kind === "positive"
        ? cap(then ?? "the behaviour the criterion describes is observed.")
        : kind === "negative"
          ? "The action is rejected with a specific, visible reason, and no state changes."
          : "The rule applies exactly at the limit — accepted on the allowed side, rejected just past it.",
  });
  return steps;
}

const PRIORITY = { P1: "High", P2: "Medium", P3: "Low" } as const;

// ------------------------------------------------- strategist heuristics --
// Used by the simulator; a live model applies the same rules from its system prompt.

const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
/** Share of the smaller text's words found in the other; summary prefixes like [Positive] are ignored. */
function overlap(a: string, b: string) {
  a = a.replace(/^\s*\[[^\]]*\]\s*/, "");
  b = b.replace(/^\s*\[[^\]]*\]\s*/, "");
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

const HIGH_IMPACT =
  /\b(pay|payment|price|total|amount|charge|refund|discount|balance|invoice|order|password|login|sign.?in|permission|role|auth|token|secure|security|delete|remove|lose|loss|personal data|gdpr)\b/i;

/** A criterion's title for test names: its AC heading or first clause, cut at a word boundary. */
export function shortTitle(criterion: string, max = 64) {
  const t = criterion.replace(/^AC\s*\d+\s*[-:]\s*/i, "").split(/[:.;]|,\s(?=when|then|and)\b/i)[0].trim();
  return t.length <= max ? t : t.slice(0, t.lastIndexOf(" ", max)).replace(/(\s+(with|to|the|a|an|of|and|or|for|in|on|by|at))+$/i, "").replace(/[\s,]+$/, "");
}

export function techniquesFor(criterion: string): (typeof P.TECHNIQUES)[number][] {
  const c = criterion.toLowerCase();
  const t: (typeof P.TECHNIQUES)[number][] = [];
  if (/\d|at least|at most|more than|less than|over|under|within|limit|maximum|minimum|exceed/.test(c)) t.push("boundary-value");
  if (/\b(true|false)\b|\band\/or\b|either|parameter|flag|setting|\bif\b.*\bthen\b|combination/.test(c) || (c.match(/\band\b/g) ?? []).length >= 3)
    t.push("decision-table");
  if (/status|state|remain|unregister|register|transition|lifecycle|becomes|moved to|allocated/.test(c)) t.push("state-transition");
  if (/error|reject|fail|invalid|missing|not |no |without|denied|duplicate/.test(c)) t.push("error-guessing");
  t.push("equivalence-partitioning");
  return [...new Set(t)].slice(0, 3);
}

export function levelFor(criterion: string, story: Story): (typeof P.LEVELS)[number] {
  const c = `${criterion} ${story.summary}`.toLowerCase();
  if (/\b(api|endpoint|payload|request|response|callback|schema|json|http|status code|webhook|queue|message)\b/.test(c)) return "api";
  if (/\b(screen|page|click|button|display|displayed|ui|navigate|form|modal|message is shown|error message)\b/.test(c)) return "ui-e2e";
  if (/\b(job|batch|nightly|reconcil|sync|import|export|report)\b/.test(c)) return "integration";
  return "integration";
}

function preconditionsFor(criterion: string, story: Story): string[] {
  const out: string[] = [];
  const given = criterion.match(/given (.*?)(?= when |$)/i)?.[1];
  if (given) for (const part of given.split(/\s+and\s+/i)) if (part.trim()) out.push(part.trim().replace(/[.;,]+$/, ""));
  for (const line of story.testCriteria.split("\n")) {
    const l = line.replace(/^[\s*•-]+/, "").trim();
    if (/^pre-?conditions?\s*:/i.test(l) && l.length < 200) out.push(l.replace(/^pre-?conditions?\s*:\s*/i, "").replace(/[.;,]+$/, ""));
    else if (/before testing|ensure .* (set|configured)|set to (true|false)/i.test(l) && l.length < 200) out.push(l.replace(/\\/g, ""));
  }
  return [...new Set(out)].slice(0, 5);
}

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
    effort: "low",
    tier: "fast",
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
- Set testable false when the story describes no verifiable behaviour at all.
- The team's test notes and the comments are evidence too: a scenario in the test notes is a
  behaviour, and a later comment that narrows or changes the scope wins over the description.`,
    prompt: (i) =>
      [
        `Framework: ${i.framework}`,
        storyText(i.story),
      ].join("\n"),
    simulate: (i, memory) => {
      const criteria = i.story.acceptanceCriteria;
      // Untaught, the simulator reads only the first three criteria — the shortcut a rushed
      // reader takes. The verifier finds the gap and forces a revision, and the learner turns
      // that revision into a lesson that removes the shortcut next time.
      const read = hasLesson(memory, "behaviour-per-criterion") ? criteria.slice(0, 8) : criteria.slice(0, 3);
      const kinds = ["happy-path", "edge-case", "negative", "regression"] as const;
      return {
        summary: criteria.length
          ? `${criteria.length} acceptance criteria yield ${read.length * 2} testable behaviours.`
          : `${i.story.key} has no acceptance criteria, so nothing here is verifiable as written.`,
        testable: criteria.length > 0,
        behaviours: read.flatMap((c, n) => [
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
    effort: "medium",
    tier: "fast",
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
          ? `Autopilot generated tests for this story and needs ${questions.length} thing(s) confirmed before they can be trusted:\n\n${questions
              .map((q, n) => `${n + 1}. ${q.question}\n   Assumption if we hear nothing: ${q.suggestedAnswer}`)
              .join("\n\n")}`
          : "",
      };
    },
  }),

  // ------------------------------------------------------------------ 3 --
  "test-strategist": def({
    id: "test-strategist",
    name: "Test strategist",
    role: "Chooses how to test",
    description:
      "Decides, per acceptance criterion, which design techniques to apply, at which test level, with what priority, setup and data — and what the tests already linked in Xray cover, so nothing is duplicated.",
    order: 3,
    effort: "medium",
    tier: "main",
    input: P.TestStrategistIn,
    output: P.TestStrategistOut,
    tool: "submit_strategy",
    toolDescription: "Return the test strategy for this story.",
    maxTokens: 8000,
    system: `${HOUSE}

You are test-strategist, the third stage. You decide how this story is tested before anyone
writes a test.

Method:
- Risk first. Rank each criterion by impact × likelihood of failure; P1 for high risk or
  money, data loss, safety or compliance; P3 only for cosmetic or low-use paths.
- Choose techniques per criterion, not per story:
  boundary-value for limits and counts; equivalence-partitioning for input classes;
  decision-table when two or more conditions (parameters, flags, roles) combine;
  state-transition when something changes status (registered, allocated, closed);
  pairwise when many independent options multiply; error-guessing for failure paths the
  criteria imply but do not list; exploratory for what cannot be specified.
- Push each check to the lowest level that can prove it (the test pyramid): api or
  integration for rules, calculations and validation; ui-e2e only for what a user must see or
  do; manual only for what cannot be automated sensibly, with the reason.
- Preconditions and data are part of the test: name system parameters, configuration and
  records each scenario needs, and keep setup idempotent.
- Read the team's test notes as an oracle and reuse their scenarios. Read the comments:
  a later comment that changes the scope wins over the description — record it in
  scopeNotes and test the current scope.
- For every scenario, check the tests already linked in Xray; if one already covers it, set
  coveredBy to its key instead of proposing a duplicate.
- Label every scenario positive, negative or edge — the team prefixes Xray test summaries
  with [Positive], [Negative] and [Edge].
- levels shares add up to 100 across the new (not yet covered) scenarios.`,
    prompt: (i) =>
      [
        `Framework: ${i.framework}`,
        storyText(i.story),
        ``,
        `Behaviours story-analyzer derived:`,
        ...i.behaviours.map((b) => `- [${b.kind}, ${b.risk} risk] ${b.name}\n  from: ${b.criterion}`),
      ].join("\n"),
    simulate: (i) => {
      const criteria = [...new Set(i.behaviours.map((b) => b.criterion))];
      const plans = criteria.map((criterion) => {
        const bs = i.behaviours.filter((b) => b.criterion === criterion);
        const base = bs.some((b) => b.risk === "high") ? 2 : bs.some((b) => b.risk === "medium") ? 1 : 0;
        // Money, security and data loss raise the impact; so does a story the team marked urgent.
        const impact = HIGH_IMPACT.test(criterion) ? 1 : 0;
        const urgent = /^(highest|high|critical|blocker|urgent)$/i.test(i.story.priority) ? 1 : 0;
        const score = Math.min(2, base + Math.max(impact, urgent));
        const risk = score === 2 ? "high" : score === 1 ? "medium" : "low";
        const techniques = techniquesFor(criterion);
        const level = levelFor(criterion, i.story);
        const short = shortTitle(criterion);
        const wanted: { title: string; kind: "positive" | "negative" | "edge" }[] = [
          { title: `${short} — succeeds when the conditions hold`, kind: "positive" },
          { title: `${short} — rejected when a condition is not met`, kind: "negative" },
          ...(techniques.includes("boundary-value") || techniques.includes("decision-table")
            ? [{ title: `${short} — at the boundary between allowed and rejected`, kind: "edge" as const }]
            : []),
        ];
        const scenarios = wanted.map((w) => {
          const hit = i.story.existingTests.find((t) => (!t.kind || t.kind === w.kind) && overlap(t.summary, short) >= 0.75);
          return { ...w, coveredBy: hit?.key ?? "" };
        });
        return {
          criterion,
          techniques,
          level,
          priority: (risk === "high" ? "P1" : risk === "medium" ? "P2" : "P3") as "P1" | "P2" | "P3",
          risk: risk as "low" | "medium" | "high",
          automate: level !== "manual",
          why: `${techniques.join(" + ")} because ${
            techniques[0] === "boundary-value"
              ? "the criterion names a limit"
              : techniques[0] === "decision-table"
                ? "several conditions combine"
                : techniques[0] === "state-transition"
                  ? "an item changes state"
                  : techniques[0] === "error-guessing"
                    ? "it describes a failure path"
                    : "inputs fall into distinct classes"
          }; ${level} is the lowest level that can prove it.`,
          preconditions: preconditionsFor(criterion, i.story),
          testData: [],
          scenarios,
        };
      });
      const fresh = plans.flatMap((p) => p.scenarios.filter((s) => !s.coveredBy).map(() => p.level));
      const levels = [...new Set(fresh)].map((level) => ({
        level,
        share: Math.round((fresh.filter((l) => l === level).length / Math.max(fresh.length, 1)) * 100),
        why: level === "api" ? "Rules and validation are fastest and most stable to prove below the UI." : level === "ui-e2e" ? "What the operator must see is only provable through the UI." : "Crosses components that must be exercised together.",
      }));
      const covered = plans.flatMap((p) => p.scenarios).filter((s) => s.coveredBy).length;
      const scopeNotes = i.story.comments.filter((c) => /not (be )?(needed|required)|out of scope|descoped|no longer|changed the scope|updated (the )?(description|ac|test criteria)/i.test(c)).map((c) => c.slice(0, 300));
      return {
        summary: `${plans.length} criteria planned: ${plans.filter((p) => p.priority === "P1").length} P1; ${fresh.length} new scenarios, ${covered} already covered in Xray.`,
        approach: `Risk-based: P1 criteria first. ${levels.map((l) => `${l.share}% ${l.level}`).join(", ") || "No new tests needed"} — each check at the lowest level that can prove it. ${scopeNotes.length ? "Comments change the scope; the current scope is tested." : ""}`.trim(),
        levels,
        criteria: plans,
        risks: [
          ...(i.story.testCriteria ? [] : [{ risk: "No team test notes on the story.", mitigation: "Scenarios derive from the criteria alone; review them with the QA owner." }]),
          ...(scopeNotes.length ? [{ risk: "Scope changed in comments after the criteria were written.", mitigation: "Confirm the current scope with the story owner before publishing." }] : []),
        ],
        scopeNotes,
        nonFunctional: [],
      };
    },
  }),

  // ------------------------------------------------------------------ 4 --
  "asset-resolver": def({
    id: "asset-resolver",
    name: "Asset resolver",
    role: "Reuses what the repo already has",
    description:
      "Reads the Bitbucket repository to find fixtures, page objects and helpers that already exist, so the pipeline extends the suite instead of duplicating it.",
    order: 4,
    effort: "low",
    tier: "fast",
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

  // ------------------------------------------------------------------ 5 --
  "spec-author": def({
    id: "spec-author",
    name: "Spec author",
    role: "Writes the specs and Xray cases",
    description:
      "Writes complete, runnable spec files against the repo's conventions, and the matching Xray test cases with real steps and expected results.",
    order: 5,
    effort: "high",
    tier: "main",
    input: P.SpecAuthorIn,
    output: P.SpecAuthorOut,
    tool: "submit_specs",
    toolDescription: "Return the files to commit and the Xray test cases to create.",
    maxTokens: 12000,
    system: `${HOUSE}
${RULEBOOK}


You are spec-author, the fifth stage.

Method:
- Follow the test strategy: write the scenarios it lists (skip any with coveredBy — an
  existing Xray test already covers it), at its level (api scenarios call the API, ui-e2e ones
  drive the UI), with its preconditions and data in setup, highest priority first.
- Name each Xray test "[Positive] …", "[Negative] …" or "[Edge] …" after the scenario's kind,
  and label it positive, negative or edge — the team's convention. Priority: P1 → High,
  P2 → Medium, P3 → Low. The first step of a manual test establishes its preconditions.
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
        ...(i.strategy.length
          ? [
              ``,
              `Test strategy:`,
              ...i.strategy.map(
                (p) =>
                  `- ${p.priority} ${p.level}${p.automate ? "" : " (manual)"} — ${p.criterion}${
                    p.preconditions.length ? `\n  preconditions: ${p.preconditions.join("; ")}` : ""
                  }${p.testData.length ? `\n  data: ${p.testData.join("; ")}` : ""}\n${p.scenarios
                    .map((sc) => `  · [${sc.kind}] ${sc.title}${sc.coveredBy ? `  (covered by ${sc.coveredBy} — skip)` : ""}`)
                    .join("\n")}`
              ),
            ]
          : []),
        ...(i.story.existingTests.length
          ? [``, `Existing Xray tests (do not duplicate):`, ...i.story.existingTests.map((t) => `- ${t.key} ${t.summary}`)]
          : []),
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
    simulate: (i, memory) => {
      const s = slug(i.story.key);
      const camel = s.replace(/-/g, "");
      // Two habits a first draft often has, which only execution exposes: a fixed sleep before
      // the assertion, and a selector that follows styling rather than behaviour. Lessons from
      // earlier heals switch each habit off.
      const fixedWait = !hasLesson(memory, "no-fixed-waits");
      const styleSelector = !hasLesson(memory, "stable-selectors");
      const specPath = i.create.find((c) => c.kind === "spec")?.path ?? `tests/${s}.spec.ts`;
      const fixturePath = i.create.find((c) => c.kind === "fixture")?.path ?? `fixtures/${s}.ts`;
      const behaviours = i.behaviours.length ? i.behaviours : [{ name: i.story.summary, criterion: "unspecified", kind: "happy-path" }];

      const spec = `import { test, expect } from '@playwright/test';
import { ${camel}Fixtures } from '${fixturePath.startsWith("/") ? fixturePath : `../${fixturePath}`}';

// ${i.story.key} — ${i.story.summary}
test.describe('${i.story.key} ${i.story.summary}', () => {
${behaviours
  .map(
    (b, n) => `  test('${b.name.replace(/'/g, "\\'")}', async ({ page }) => {
    // covers: ${b.criterion.replace(/\n/g, " ")}
    await page.goto(${camel}Fixtures.entryPath);
    ${styleSelector && b.kind !== "happy-path" ? "await page.locator('.btn-primary').click();" : `await page.getByTestId('${s}-submit').click();`}${
      fixedWait && n === 0 ? "\n    await page.waitForTimeout(1500);" : ""
    }
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
        labels: ["autopilot"],
        gherkin: "",
        steps: stepsFor(c, "positive"),
      }));
      return {
        summary: i.revision
          ? `Revision ${i.revision.attempt}: closed ${extra.length} uncovered criterion/criteria and fixed ${i.revision.defects.length} defect(s).`
          : `Wrote ${behaviours.length} test(s) across 2 files, reusing ${i.reuse.length} existing asset(s).`,
        files: [
          { path: specPath, kind: "spec" as const, content: spec },
          { path: fixturePath, kind: "fixture" as const, content: fixture },
        ],
        testCases: [
          ...extra,
          ...(i.strategy.length
            ? i.strategy.flatMap((plan) =>
                plan.scenarios
                  .filter((sc) => !sc.coveredBy)
                  .map((sc) => ({
                    summary: `[${cap(sc.kind)}] ${sc.title}`,
                    testType: "Manual" as const,
                    priority: PRIORITY[plan.priority],
                    criterion: plan.criterion,
                    labels: [sc.kind, plan.automate ? "automated-candidate" : "manual", "autopilot"],
                    gherkin: "",
                    steps: stepsFor(plan.criterion, sc.kind, plan.preconditions),
                  }))
              )
            : behaviours.map((b) => {
                const kind: Kind = b.kind === "happy-path" ? "positive" : b.kind === "edge-case" ? "edge" : "negative";
                return {
                  summary: `[${cap(kind)}] ${b.name}`,
                  testType: "Manual" as const,
                  priority: "Medium" as const,
                  criterion: b.criterion,
                  labels: [kind, "automated-candidate", "autopilot"],
                  gherkin: "",
                  steps: stepsFor(b.criterion, kind),
                };
              })),
        ],
        branchName: `qe/${i.story.key}-specs`,
      };
    },
  }),

  // ------------------------------------------------------------------ 6 --
  verifier: def({
    id: "verifier",
    name: "Verifier",
    role: "Checks the work against the story",
    description:
      "Maps every acceptance criterion to the test that covers it and inspects the generated files for placeholders, broken imports and assertions that cannot fail.",
    order: 6,
    effort: "medium",
    tier: "main",
    input: P.VerifierIn,
    output: P.VerifierOut,
    tool: "submit_verification",
    toolDescription: "Return the coverage map and any defects found.",
    maxTokens: 6000,
    system: `${HOUSE}
${RULEBOOK}


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

  // ------------------------------------------------------------------ 7 --
  reviewer: def({
    id: "reviewer",
    name: "Reviewer",
    role: "The gate before anything is published",
    description:
      "Decides whether the suite is fit to propose to Xray and Bitbucket, and writes the pull request. Sends work back rather than waving through something a human would reject.",
    order: 7,
    effort: "high",
    tier: "main",
    input: P.ReviewerIn,
    output: P.ReviewerOut,
    tool: "submit_review",
    toolDescription: "Return the verdict and, when approving, the pull request text.",
    maxTokens: 5000,
    system: `${HOUSE}
${RULEBOOK}


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
          ? `Generated by Autopilot's qe-pipeline for ${i.story.key}.\n\n**Covers**\n${i.verifier.coverage
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
  effort: Effort;
  tier: "main" | "fast";
}

export const SUB_AGENT_LIST: SubAgentMeta[] = Object.values(SUB_AGENTS)
  .map((a) => ({ id: a.id, name: a.name, role: a.role, description: a.description, order: a.order, effort: a.effort, tier: a.tier }))
  .sort((a, b) => a.order - b.order);

export const isSubAgentId = (v: string): v is SubAgentId => v in SUB_AGENTS;
