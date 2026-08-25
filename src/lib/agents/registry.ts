import type { z } from "zod";
import type { AgentDef, AgentId, AgentMode } from "./types";
import * as S from "./schemas";

const HOUSE_RULES = `
You are one agent in Gantry, an agentic quality-engineering platform. Every agent here
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
  "qe-pipelines": defineAgent({
    id: "qe-pipelines",
    name: "QE pipelines",
    role: "Generation · single story",
    description:
      "Takes one story end to end: acceptance criteria to spec file, fixtures, page objects, and test data. Every scenario traces back to a criterion.",
    io: ["story", "spec + assets"],
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
  "qe-batch": defineAgent({
    id: "qe-batch",
    name: "QE batch",
    role: "Generation · parallel",
    description:
      "Fans a whole sprint out at once. Shards stories across every idle runner, dedupes fixtures they share, and merges the result into one changeset.",
    io: ["sprint plan", "n × specs"],
    mode: "batch",
    input: S.QeBatchIn,
    output: S.QeBatchOut,
    tool: "submit_batch_plan",
    toolDescription: "Return the shard plan for parallel spec generation.",
    maxTokens: 4000,
    system: `${HOUSE_RULES}

You are qe-batch. You plan how a sprint's worth of stories is generated in parallel.

Method:
- Order stories so that anything another story depends on is generated first.
- Split into shards of roughly equal cost, never more shards than available slots.
- Stories that will clearly share test data or page objects go in the same shard, and the
  shared file is listed in sharedFixtures so it is written once rather than n times.
- Estimate minutes per shard honestly; a shard that dwarfs the others is a bad split.`,
    prompt: (i) =>
      [
        `Sprint: ${i.sprintName}`,
        `Available runner slots: ${i.availableSlots}`,
        `Framework: ${i.framework}`,
        ``,
        `Stories:`,
        ...i.stories.map(
          (s) => `- ${s.key} [${s.points ?? "?"}] ${s.title} :: ${s.description || "(no description)"}`
        ),
      ].join("\n"),
    simulate: (i) => {
      const slots = Math.max(1, Math.min(i.availableSlots, i.stories.length));
      const shards = Array.from({ length: slots }, (_, n) => ({
        shard: n + 1,
        storyKeys: i.stories.filter((_, k) => k % slots === n).map((s) => s.key),
        estimatedMinutes: 0,
      })).map((sh) => ({ ...sh, estimatedMinutes: Math.max(2, sh.storyKeys.length * 3) }));
      return {
        summary: `Split ${i.stories.length} stories across ${slots} shards, dependency order preserved.`,
        shards,
        sharedFixtures: i.stories.length > 2
          ? [
              {
                path: "fixtures/testUsers.ts",
                reason: "Several stories authenticate as the same personas.",
                usedBy: i.stories.slice(0, 3).map((s) => s.key),
              },
            ]
          : [],
        order: i.stories.map((s) => s.key),
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
    simulate: (i) => {
      const selectorMiss = /selector|locator|not found|no element|resolved to 0/i.test(i.failureOutput);
      if (!selectorMiss) {
        return {
          diagnosis:
            "The assertion is still a correct description of the required behaviour, and the failure shows the application returning something else.",
          category: "app-bug" as const,
          shouldPatch: false,
          reason:
            "Changing this expectation would hide a real defect. Filing a bug with the reproduction instead.",
          confidence: "medium" as const,
          patch: null,
        };
      }
      const before = "await page.click('[data-test=submit]');";
      const after = "await page.click('[data-test=checkout-submit]');";
      return {
        diagnosis: "The element was renamed; the spec still references the old test id.",
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
