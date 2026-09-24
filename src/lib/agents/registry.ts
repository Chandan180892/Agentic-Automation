import type { z } from "zod";
import { hasLesson, type AgentDef, type AgentId, type AgentMode } from "./types";
import * as S from "./schemas";

const HOUSE_RULES = `
You are one agent in Autopilot, an agentic quality-engineering platform. Every agent here
follows the same three rules:

1. Never invent a requirement. If the input does not say it, say you drafted it and mark it
   for human review rather than presenting a guess as fact.
2. Never weaken a test to make it pass. Skipping, quarantining, or loosening an assertion is
   not a fix. If the application is wrong, say the application is wrong.
3. Be specific. Name the file, the selector, the criterion, the commit. A reviewer must be
   able to check your work without re-reading the whole codebase.

Write for an engineer who is busy. Short sentences, no filler, no apologies.
`.trim();

/** Preserves each agent's own input/output types instead of widening to AgentDef. */
function defineAgent<I extends z.ZodType, O extends z.ZodType>(def: AgentDef<I, O>) {
  return def;
}

export const AGENTS = {
  // ------------------------------------------------------------------------
  "sprint-planner": defineAgent({
    id: "sprint-planner",
    name: "Sprint planner",
    role: "Planning",
    description:
      "Reads the backlog, sizes what has no estimate, orders by dependency, and commits only what velocity supports. Flags what it refuses to guess at.",
    io: ["backlog", "sprint plan"],
    mode: "single",
    input: S.SprintPlannerIn,
    output: S.SprintPlannerOut,
    tool: "submit_sprint_plan",
    toolDescription: "Return the committed sprint plan.",
    maxTokens: 4000,
    system: `${HOUSE_RULES}

You are sprint-planner. You turn a raw backlog into a sprint commitment.

Method:
- Size any story with no points using the sized stories in the same input as your scale.
- Order by dependency first, then by risk: a story other stories depend on goes earlier.
- Commit up to capacity. Leave headroom rather than overcommitting; going over recent
  velocity is a risk you must flag, not a decision you make quietly.
- A story with no acceptance criteria cannot be tested. Draft criteria for it, list them in
  draftedAcceptanceCriteria, and raise a risk saying they need review. Do not silently accept.
- Mark stories you are excluding as committed: false with a one-line rationale.`,
    prompt: (i) =>
      [
        `Sprint: ${i.sprintName}`,
        `Team capacity: ${i.capacityPoints} points`,
        i.recentVelocity.length
          ? `Recent velocity (oldest to newest): ${i.recentVelocity.join(", ")}`
          : `No velocity history yet — treat capacity as the ceiling.`,
        ``,
        `Backlog (${i.stories.length} stories):`,
        ...i.stories.map(
          (s) =>
            `- ${s.key} [${s.points ?? "unsized"}] ${s.title}\n  ${s.description || "(no description)"}\n  AC: ${
              s.acceptanceCriteria.length ? s.acceptanceCriteria.join(" | ") : "NONE"
            }`
        ),
      ].join("\n"),
    simulate: (i) => {
      let running = 0;
      const commitment = i.stories.map((s, n) => {
        const points = s.points ?? [2, 3, 5, 8][n % 4];
        const fits = running + points <= i.capacityPoints;
        if (fits) running += points;
        return {
          key: s.key,
          points,
          order: n + 1,
          committed: fits,
          rationale: s.points
            ? fits
              ? "Fits within remaining capacity."
              : "Deferred — would push the sprint over capacity."
            : `Unsized; estimated at ${points} points from comparable stories.`,
        };
      });
      const missing = i.stories.filter((s) => s.acceptanceCriteria.length === 0);
      return {
        summary: `Committing ${running} of ${i.capacityPoints} points across ${
          commitment.filter((c) => c.committed).length
        } stories, ordered so dependencies land first.${
          missing.length ? ` ${missing.length} stories arrived without acceptance criteria — I drafted them for review.` : ""
        }`,
        totalPoints: running,
        commitment,
        draftedAcceptanceCriteria: missing.map((s) => ({
          key: s.key,
          criteria: [
            `Given a valid request, ${s.title.toLowerCase()} completes and the result is visible to the user.`,
            `Given an invalid or duplicate request, the system rejects it with a specific reason.`,
            `The change is reflected in the audit log with the acting user and a timestamp.`,
          ],
        })),
        risks: [
          ...missing.map((s) => ({
            level: "medium" as const,
            message: `${s.key} had no acceptance criteria. I drafted three — review before generating specs.`,
            storyKey: s.key,
          })),
          ...(running > i.capacityPoints * 0.95
            ? [{ level: "medium" as const, message: "Commitment leaves under 5% headroom.", storyKey: null }]
            : []),
        ],
      };
    },
  }),

  // ------------------------------------------------------------------------
  "qe-pipeline": defineAgent({
    id: "qe-pipeline",
    name: "QE pipeline",
    role: "Orchestrator · six sub-agents",
    description:
      "Walks one Jira story through story-analyzer, clarify, asset-resolver, spec-author, verifier and reviewer. Revises its own work when the verifier objects, and stops rather than guessing when the story is genuinely ambiguous.",
    io: ["Jira story", "Xray tests + Bitbucket PR"],
    mode: "single",
    input: S.QePipelinesIn,
    output: S.QePipelinesOut,
    tool: "submit_specs",
    toolDescription: "Return the generated scenarios and the files that implement them.",
    maxTokens: 8000,
    system: `${HOUSE_RULES}

You are qe-pipelines. You turn one story into a runnable test suite.

Method:
- Derive scenarios from acceptance criteria, one criterion at a time. Every scenario names
  the criterion it covers. If a criterion is untestable as written, say so in notes and set
  needsHuman: true.
- Cover the happy path, then the edge and negative cases the criteria imply.
- Emit complete, runnable files — no TODOs, no placeholder selectors, no "..." elisions.
  Prefer role-based and data-test selectors over CSS descended from styling.
- Put reusable data in a fixture file rather than inlining it in the spec.
- Assertions describe behaviour, not implementation.`,
    prompt: (i) =>
      [
        `Framework: ${i.framework} (${i.language})`,
        ``,
        `Story ${i.story.key}: ${i.story.title}`,
        i.story.description || "(no description)",
        ``,
        `Acceptance criteria:`,
        ...(i.story.acceptanceCriteria.length
          ? i.story.acceptanceCriteria.map((c, n) => `${n + 1}. ${c}`)
          : ["NONE — flag this and set needsHuman true."]),
      ].join("\n"),
    simulate: (i) => {
      const slug = i.story.key.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const ac = i.story.acceptanceCriteria.length
        ? i.story.acceptanceCriteria
        : ["Behaviour not specified — criteria drafted by sprint-planner."];
      const scenarios = ac.slice(0, 4).map((c, n) => ({
        name: `${i.story.title} — ${["happy path", "edge case", "negative case", "regression"][n % 4]}`,
        type: (["happy-path", "edge-case", "negative", "regression"] as const)[n % 4],
        criterion: c,
      }));
      const spec = `import { test, expect } from '@playwright/test';
import { ${slug.replace(/-/g, "")}Fixtures } from '../fixtures/${slug}';

// ${i.story.key} — ${i.story.title}
test.describe('${i.story.key} ${i.story.title}', () => {
${scenarios
  .map(
    (s) => `  test('${s.name.replace(/'/g, "\\'")}', async ({ page }) => {
    // covers: ${s.criterion.replace(/\n/g, " ")}
    await page.goto(${slug.replace(/-/g, "")}Fixtures.entryPath);
    await page.getByTestId('${slug}-submit').click();
    await expect(page.getByRole('status')).toBeVisible();
  });`
  )
  .join("\n\n")}
});
`;
      const fixture = `export const ${slug.replace(/-/g, "")}Fixtures = {
  entryPath: '/${slug}',
  validPayload: { id: '${slug}-1', amount: 1250, currency: 'USD' },
  invalidPayload: { id: '${slug}-1', amount: -1, currency: 'USD' },
};
`;
      return {
        summary: `Generated ${scenarios.length} scenarios for ${i.story.key} from ${ac.length} acceptance criteria, plus a shared fixture.`,
        scenarios,
        assets: [
          { path: `tests/${slug}.spec.ts`, kind: "spec" as const, content: spec },
          { path: `fixtures/${slug}.ts`, kind: "fixture" as const, content: fixture },
        ],
        needsHuman: i.story.acceptanceCriteria.length === 0,
        notes: i.story.acceptanceCriteria.length
          ? ""
          : "This story arrived without acceptance criteria. The specs are structural only — review before trusting them.",
      };
    },
  }),

  // ------------------------------------------------------------------------
  "qe-auto-heal": defineAgent({
    id: "qe-auto-heal",
    name: "QE auto-heal",
    role: "Repair · single spec",
    description:
      "Reads the failure, the diff that caused it, and the spec. Proposes the smallest patch, or refuses and files a bug when the application is the one that is wrong.",
    io: ["failure", "verified patch"],
    mode: "single",
    input: S.QeAutoHealIn,
    output: S.QeAutoHealOut,
    tool: "submit_heal",
    toolDescription: "Return the diagnosis and, when safe, the patch.",
    maxTokens: 6000,
    system: `${HOUSE_RULES}

You are qe-auto-heal. A spec failed. Decide what actually broke.

Method:
- Classify first: selector, timing, test-data, assertion, or app-bug.
- selector / timing / test-data are usually the test drifting behind the app. Patch them,
  changing as few lines as possible.
- An assertion failure where the expectation is still correct means the APPLICATION is
  broken. Set shouldPatch: false, category app-bug, and explain the reproduction. Rewriting
  the expectation to match broken behaviour is the one thing you must never do.
- Confidence is high only when the diff directly explains the failure.
- The patch must be a real unified diff against the given file.`,
    prompt: (i) =>
      [
        `Spec: ${i.specPath}`,
        ``,
        `--- spec content ---`,
        i.specContent.slice(0, 12000),
        ``,
        `--- failure output ---`,
        i.failureOutput.slice(0, 6000),
        ``,
        `--- recent changes ---`,
        i.recentDiff ? i.recentDiff.slice(0, 6000) : "(none supplied)",
      ].join("\n"),
    simulate: (i, memory) => {
      // The executor quotes the failing line after "> "; heal that line when it is there.
      const quoted = i.failureOutput.match(/^\s*> (.+)$/m)?.[1]?.trim();
      const timing = /timed out|waitForTimeout/i.test(i.failureOutput) && quoted?.includes("waitForTimeout");
      if (timing && quoted) {
        return {
          diagnosis: "A fixed sleep raced the render. The assertion after it already waits for the element, so the sleep only adds a race.",
          category: "timing" as const,
          shouldPatch: true,
          reason: "Removing the sleep changes no expectation — the web-first assertion below it does the waiting.",
          confidence: "high" as const,
          patch: {
            path: i.specPath,
            before: quoted,
            after: "",
            unifiedDiff: `--- a/${i.specPath}\n+++ b/${i.specPath}\n@@\n-${quoted}\n`,
          },
        };
      }
      const selectorMiss = /selector|locator|not found|no element|resolved to 0/i.test(i.failureOutput);
      if (!selectorMiss) {
        const key = i.specPath.match(/[a-z]+-\d+/i)?.[0]?.toLowerCase() ?? "";
        const known = key && hasLesson(memory, `known-defect-${key}`);
        return {
          diagnosis:
            "The assertion is still a correct description of the required behaviour, and the failure shows the application returning something else.",
          category: "app-bug" as const,
          shouldPatch: false,
          reason: `Changing this expectation would hide a real defect. Filing a bug with the reproduction instead.${
            known ? " This matches a defect the workspace already knows about." : ""
          }`,
          confidence: "medium" as const,
          patch: null,
        };
      }
      // Swap a styling selector for the test id the rest of the spec already uses.
      const testId = i.specContent.match(/getByTestId\('([^']+)'\)/)?.[1];
      const before = quoted && testId ? quoted : "await page.click('[data-test=submit]');";
      const after =
        quoted && testId
          ? quoted.replace(/page\.locator\('[^']+'\)/, `page.getByTestId('${testId}')`)
          : "await page.click('[data-test=checkout-submit]');";
      return {
        diagnosis:
          quoted && testId
            ? "The spec selects by a styling class that the app no longer renders; the element's test id is stable."
            : "The element was renamed; the spec still references the old test id.",
        category: "selector" as const,
        shouldPatch: true,
        reason: "A rename, not a regression. The assertion below it still holds, so only the selector moves.",
        confidence: "high" as const,
        patch: {
          path: i.specPath,
          before,
          after,
          unifiedDiff: `--- a/${i.specPath}\n+++ b/${i.specPath}\n@@\n-${before}\n+${after}\n`,
        },
      };
    },
  }),

  // ------------------------------------------------------------------------
  "batch-heal": defineAgent({
    id: "batch-heal",
    name: "Batch heal",
    role: "Repair · fleet",
    description:
      "When one change breaks many specs, groups them by root cause, patches each group, re-runs them, and opens a single PR containing only the ones that went green.",
    io: ["n × failures", "one PR"],
    mode: "batch",
    input: S.BatchHealIn,
    output: S.BatchHealOut,
    tool: "submit_batch_heal",
    toolDescription: "Return grouped root causes, patches, and escalations.",
    maxTokens: 8000,
    system: `${HOUSE_RULES}

You are batch-heal. Many specs failed at once. Find the few root causes behind them.

Method:
- Group by root cause, not by directory. Ten specs failing on one renamed selector is one
  group with one fix, not ten findings.
- Patch each group once and apply it across every spec in the group.
- Anything whose fix would change an assertion goes to escalations with a reason. Never
  bundle an escalation into the PR.
- The PR body lists what was patched, what was verified, and what was escalated, so a
  reviewer can approve it without opening every file.`,
    prompt: (i) =>
      [
        `${i.failures.length} failing specs.`,
        ``,
        ...i.failures.map(
          (f, n) => `[${n + 1}] ${f.specPath}\n${f.failureOutput.slice(0, 1200)}`
        ),
        ``,
        `--- recent changes ---`,
        i.recentDiff ? i.recentDiff.slice(0, 8000) : "(none supplied)",
      ].join("\n"),
    simulate: (i) => {
      const selectorish = i.failures.filter((f) => /selector|locator|not found/i.test(f.failureOutput));
      const rest = i.failures.filter((f) => !selectorish.includes(f));
      return {
        summary: `${i.failures.length} failures collapse into ${selectorish.length ? 1 : 0} root cause${
          rest.length ? ` plus ${rest.length} that need a human` : ""
        }.`,
        groups: selectorish.length
          ? [
              {
                signature: "Renamed test id: [data-test=submit] → [data-test=checkout-submit]",
                specPaths: selectorish.map((f) => f.specPath),
                fix: "Update the selector in place; assertions unchanged.",
              },
            ]
          : [],
        patches: selectorish.map((f) => ({
          path: f.specPath,
          unifiedDiff: `--- a/${f.specPath}\n+++ b/${f.specPath}\n@@\n-await page.click('[data-test=submit]');\n+await page.click('[data-test=checkout-submit]');\n`,
          verified: true,
        })),
        escalations: rest.map((f) => ({
          specPath: f.specPath,
          reason: "Fixing this would change an assertion. That needs a human decision.",
        })),
        prTitle: `fix(tests): update renamed checkout selector across ${selectorish.length} specs`,
        prBody: `Generated by batch-heal.\n\n**Root cause** — \`[data-test=submit]\` was renamed to \`[data-test=checkout-submit]\`.\n\n**Patched and verified green:** ${selectorish.length}\n**Escalated to a human:** ${rest.length}\n\nNo assertions were changed.`,
      };
    },
  }),

  // ------------------------------------------------------------------------
  "qe-insights": defineAgent({
    id: "qe-insights",
    name: "QE insights",
    role: "Analysis",
    description:
      "Watches every run for flake signatures, slow suites, and coverage gaps against the sprint, then tells the planner what to pull in next.",
    io: ["run history", "signals"],
    mode: "single",
    input: S.QeInsightsIn,
    output: S.QeInsightsOut,
    tool: "submit_insights",
    toolDescription: "Return flake, performance, and coverage signals.",
    maxTokens: 4000,
    system: `${HOUSE_RULES}

You are qe-insights. You read run history and tell the team what to fix before it bites.

Method:
- A flake is a spec that both passed and failed on the same code. Report its fail rate.
- Report a suite as slow only against its own history, not an absolute threshold.
- A coverage gap is a story in the sprint with no spec that names it.
- End with one recommendation the planner can act on next sprint.`,
    prompt: (i) =>
      [
        `Window: ${i.window}`,
        `${i.runs.length} recorded results.`,
        ...i.runs.slice(0, 200).map((r) => `${r.status.padEnd(8)} ${r.durationMs}ms ${r.specPath} ${r.storyKey}`),
      ].join("\n"),
    simulate: (i) => {
      const failed = i.runs.filter((r) => r.status === "failed");
      const bySpec = new Map<string, { pass: number; fail: number }>();
      for (const r of i.runs) {
        const e = bySpec.get(r.specPath) ?? { pass: 0, fail: 0 };
        r.status === "failed" ? e.fail++ : e.pass++;
        bySpec.set(r.specPath, e);
      }
      const flakes = [...bySpec.entries()]
        .filter(([, v]) => v.pass > 0 && v.fail > 0)
        .map(([specPath, v]) => ({
          specPath,
          failRate: Math.round((v.fail / (v.pass + v.fail)) * 100) / 100,
          advice: "Passed and failed on the same code — quarantine it or make the wait explicit.",
        }));
      return {
        summary: `${i.runs.length} results in ${i.window}: ${failed.length} failed, ${flakes.length} specs look flaky.`,
        flakes,
        slowSuites: [],
        coverageGaps: [],
        recommendation: flakes.length
          ? `Spend the first day of next sprint on the ${flakes.length} flaky specs — they are costing more re-runs than they catch.`
          : "No flake signal. Coverage is the better place to spend next sprint.",
      };
    },
  }),

  // ------------------------------------------------------------------------
  "requirements-reviewer": defineAgent({
    id: "requirements-reviewer",
    name: "Requirements reviewer",
    role: "Review · against requirements",
    description:
      "Reads every acceptance criterion in the sprint and decides, from execution evidence alone, whether it is met, not met, untested or blocked. A passing suite that skipped a criterion is not a pass.",
    io: ["criteria + results", "traceability verdict"],
    mode: "batch",
    input: S.RequirementsReviewIn,
    output: S.RequirementsReviewOut,
    tool: "submit_requirements_review",
    toolDescription: "Return the per-criterion verdicts and the overall decision.",
    maxTokens: 6000,
    system: `${HOUSE_RULES}

You are requirements-reviewer. You decide whether the sprint's requirements are actually met.

Method:
- Judge each acceptance criterion separately, from the tests that name it and their results.
- met: at least one test covers it and every test covering it passed (healed counts as passed —
  a heal never changes an assertion).
- not-met: a test covering it failed on an application defect. Name the test.
- untested: nothing covers it. blocked: the story's pipeline stopped before tests existed.
- verdict: accept only when every criterion is met; reject when any is not-met; otherwise
  accept-with-risks, naming the risk.
- Every gap gets one concrete action a person can take.`,
    prompt: (i) =>
      i.stories
        .map((s) =>
          [
            `${s.key} — ${s.title} (pipeline: ${s.pipeline})`,
            ...s.acceptanceCriteria.map((c, n) => `  AC${n + 1}: ${c}`),
            ...s.tests.map((t) => `  test [${t.status}] ${t.name}  covers: ${t.criterion}${t.note ? `  — ${t.note}` : ""}`),
          ].join("\n")
        )
        .join("\n\n"),
    simulate: (i) => {
      const criteria = i.stories.flatMap((s) =>
        s.acceptanceCriteria.map((c) => {
          const tests = s.tests.filter((t) => t.criterion === c);
          const failed = tests.filter((t) => t.status === "failed");
          const status =
            tests.length === 0
              ? s.pipeline === "blocked" || s.pipeline === "failed" || s.pipeline === "not-run"
                ? ("blocked" as const)
                : ("untested" as const)
              : failed.length
                ? ("not-met" as const)
                : tests.every((t) => t.status === "passed" || t.status === "healed")
                  ? ("met" as const)
                  : ("untested" as const);
          const evidence =
            status === "met"
              ? `${tests.length} test(s) passed${tests.some((t) => t.status === "healed") ? " (some after a heal)" : ""}: ${tests
                  .map((t) => t.name)
                  .slice(0, 2)
                  .join("; ")}`
              : status === "not-met"
                ? `Failed on the application: ${failed[0].name}${failed[0].note ? ` — ${failed[0].note}` : ""}`
                : status === "blocked"
                  ? `The pipeline for ${s.key} stopped before any test was written.`
                  : "No test names this criterion.";
          return { storyKey: s.key, criterion: c, status, evidence };
        })
      );
      const count = (st: string) => criteria.filter((c) => c.status === st).length;
      const verdict = count("not-met") ? ("reject" as const) : criteria.every((c) => c.status === "met") ? ("accept" as const) : ("accept-with-risks" as const);
      return {
        summary: `${count("met")}/${criteria.length} criteria met; ${count("not-met")} not met, ${count("untested")} untested, ${count("blocked")} blocked.`,
        verdict,
        criteria,
        gaps: criteria
          .filter((c) => c.status !== "met")
          .map((c) => ({
            storyKey: c.storyKey,
            gap: `${c.status}: ${c.criterion}`,
            action:
              c.status === "not-met"
                ? "Fix the application defect; the test is correct and stays as it is."
                : c.status === "blocked"
                  ? "Answer the open question on the story, then re-run its pipeline."
                  : "Add a test that names this criterion.",
          })),
      };
    },
  }),

  // ------------------------------------------------------------------------
  "cycle-reporter": defineAgent({
    id: "cycle-reporter",
    name: "Cycle reporter",
    role: "Report",
    description:
      "Turns one autopilot cycle into a report a lead can read in a minute: what shipped, what the agents fixed themselves, what still needs a person, and how this cycle compares with the last.",
    io: ["cycle metrics", "report"],
    mode: "single",
    input: S.CycleReportIn,
    output: S.CycleReportOut,
    tool: "submit_report",
    toolDescription: "Return the cycle report.",
    maxTokens: 3000,
    system: `${HOUSE_RULES}

You are cycle-reporter. You write the report for one autopilot cycle.

Method:
- Lead with the requirements verdict, not with activity.
- Compare with the previous cycle when one is given, and say which way each number moved.
- Separate what the agents resolved themselves (heals, revisions) from what needs a person
  (app bugs, unanswered questions, untested criteria).
- nextActions are things a person does, each one sentence.`,
    prompt: (i) =>
      [
        `Sprint ${i.sprintName}, cycle ${i.cycle}. Requirements verdict: ${i.verdict}.`,
        `Metrics: ${JSON.stringify(i.metrics)}`,
        i.previous ? `Previous cycle: ${JSON.stringify(i.previous)}` : "No previous cycle.",
        i.gaps.length ? `Gaps:\n${i.gaps.map((g) => `- ${g}`).join("\n")}` : "No gaps.",
        i.bugs.length ? `Application bugs:\n${i.bugs.map((b) => `- ${b}`).join("\n")}` : "No application bugs.",
      ].join("\n"),
    simulate: (i) => {
      const m = i.metrics;
      const pct = (n: number) => `${Math.round(n * 100)}%`;
      const move = (now: number, was: number, better: "up" | "down") =>
        now === was ? "unchanged" : (now > was) === (better === "up") ? "better" : "worse";
      return {
        headline: `Cycle ${i.cycle}: ${m.criteriaMet}/${m.criteriaTotal} criteria met — ${i.verdict}. First-run pass rate ${pct(m.firstRunPassRate)}.`,
        summary: `${m.storiesSpecced} of ${m.storiesCommitted} committed stories reached a reviewed suite. ${m.testsRun} tests ran; ${m.healed} were healed by the agents and ${m.appBugs} failed on the application itself.${
          i.previous
            ? ` Against cycle ${i.cycle - 1}: first-run pass rate ${pct(i.previous.firstRunPassRate)} → ${pct(m.firstRunPassRate)}, revisions ${i.previous.revisions} → ${m.revisions}, heals ${i.previous.healed} → ${m.healed}.`
            : ""
        }`,
        highlights: [
          `${m.lessonsApplied} learned lesson(s) were applied to this cycle's agents.`,
          ...(i.previous
            ? [
                `First-run pass rate is ${move(m.firstRunPassRate, i.previous.firstRunPassRate, "up")} than last cycle.`,
                `Verifier revisions are ${move(m.revisions, i.previous.revisions, "down")} than last cycle.`,
              ]
            : ["This is the first cycle, so it sets the baseline the next one is measured against."]),
          ...(m.healed ? [`${m.healed} failure(s) were test drift, healed without changing an assertion.`] : []),
        ],
        risks: [...i.bugs.map((b) => `App defect: ${b}`), ...i.gaps.slice(0, 5)],
        nextActions: [
          ...(i.bugs.length ? [`Triage the ${i.bugs.length} application defect(s) — the tests that caught them stay as they are.`] : []),
          ...(i.gaps.length ? [`Close the ${i.gaps.length} requirement gap(s) listed above before sign-off.`] : []),
          "Approve the proposed Xray and Bitbucket publications for the stories that passed review.",
        ],
      };
    },
  }),

  // ------------------------------------------------------------------------
  learner: defineAgent({
    id: "learner",
    name: "Learner",
    role: "Learning · memory",
    description:
      "Reads what went wrong in a cycle — heals, verifier revisions, application defects — and turns each root cause into a lesson for the agent that caused it. Lessons are injected into that agent's next turn, gain confidence when they hold, and retire when they do not.",
    io: ["cycle evidence", "lessons"],
    mode: "single",
    input: S.LearnerIn,
    output: S.LearnerOut,
    tool: "submit_lessons",
    toolDescription: "Return the lessons learned from this cycle.",
    maxTokens: 3000,
    system: `${HOUSE_RULES}

You are learner. You turn a cycle's failures into lessons the agents apply next time.

Method:
- One lesson per root cause, not per occurrence. Five specs with the same fixed sleep are one
  lesson.
- Scope each lesson to the agent that would have prevented the problem: spec-author for how
  tests are written, story-analyzer for which behaviours are derived, qe-auto-heal for known
  application defects, sprint-planner for commitment.
- A rule is a single instruction the scoped agent can follow. Never a rule that weakens a
  test, lowers coverage, or hides a defect.
- Reuse a known lesson's key when the finding is the same, so it is reinforced rather than
  duplicated. Suggested keys: fixed-wait → no-fixed-waits, style-selector → stable-selectors,
  uncovered-criterion → behaviour-per-criterion, app-bug → known-defect-<story-key>.`,
    prompt: (i) =>
      [
        `Signals from this cycle:`,
        ...i.signals.map((s) => `- [${s.kind}] ${s.storyKey} ${s.detail}`),
        ``,
        `Lessons the workspace already holds:`,
        ...(i.known.length ? i.known.map((k) => `- ${k.key}: ${k.rule}`) : ["(none)"]),
      ].join("\n"),
    simulate: (i) => {
      const TEMPLATES = {
        "fixed-wait": {
          key: "no-fixed-waits",
          scope: "spec-author" as const,
          category: "heal" as const,
          rule: "Never use page.waitForTimeout; let a web-first assertion such as expect(locator).toHaveText do the waiting.",
        },
        "style-selector": {
          key: "stable-selectors",
          scope: "spec-author" as const,
          category: "heal" as const,
          rule: "Select elements by role or data-testid, never by styling classes such as .btn-primary — styling changes without notice.",
        },
        "uncovered-criterion": {
          key: "behaviour-per-criterion",
          scope: "story-analyzer" as const,
          category: "coverage" as const,
          rule: "Derive at least one behaviour from every acceptance criterion, not only the first few.",
        },
      };
      const lessons = new Map<string, z.infer<typeof S.LearnerOut>["lessons"][number]>();
      for (const sig of i.signals) {
        if (sig.kind === "app-bug") {
          const key = `known-defect-${sig.storyKey.toLowerCase()}`;
          lessons.set(key, {
            key,
            scope: "qe-auto-heal",
            category: "review",
            rule: `${sig.storyKey} has an open application defect (${sig.detail.slice(0, 120)}). Classify failures there as app-bug; never patch the assertion.`,
            evidence: sig.detail,
          });
          continue;
        }
        const t = TEMPLATES[sig.kind];
        const prev = lessons.get(t.key);
        lessons.set(t.key, {
          ...t,
          evidence: prev ? `${prev.evidence}; ${sig.storyKey}` : `${sig.storyKey}: ${sig.detail}`,
        });
      }
      const known = new Set(i.known.map((k) => k.key));
      const fresh = [...lessons.keys()].filter((k) => !known.has(k)).length;
      return {
        summary: i.signals.length
          ? `${i.signals.length} signal(s) reduce to ${lessons.size} root cause(s): ${fresh} new lesson(s), ${lessons.size - fresh} reinforced.`
          : "Nothing went wrong that a lesson would have prevented.",
        lessons: [...lessons.values()],
      };
    },
  }),
} satisfies Record<AgentId, AgentDef>;

/** What the UI needs to list agents — no schemas, no prompts, no variance headaches. */
export interface AgentMeta {
  id: AgentId;
  name: string;
  role: string;
  description: string;
  io: [string, string];
  mode: AgentMode;
}

export const AGENT_LIST: AgentMeta[] = Object.values(AGENTS).map((a) => ({
  id: a.id,
  name: a.name,
  role: a.role,
  description: a.description,
  io: a.io,
  mode: a.mode,
}));

export const isAgentId = (v: string): v is AgentId => v in AGENTS;
