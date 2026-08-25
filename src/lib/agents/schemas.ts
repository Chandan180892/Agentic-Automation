import { z } from "zod";

export const StoryInput = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string().default(""),
  acceptanceCriteria: z.array(z.string()).default([]),
  points: z.number().nullable().optional(),
});

// ------------------------------------------------------------ sprint-planner
export const SprintPlannerIn = z.object({
  sprintName: z.string(),
  capacityPoints: z.number(),
  recentVelocity: z.array(z.number()).default([]),
  stories: z.array(StoryInput),
});

export const SprintPlannerOut = z.object({
  summary: z.string().describe("Two or three sentences addressed to the team lead."),
  totalPoints: z.number(),
  commitment: z.array(
    z.object({
      key: z.string(),
      points: z.number(),
      order: z.number().describe("1-based execution order, dependencies first"),
      committed: z.boolean(),
      rationale: z.string(),
    })
  ),
  draftedAcceptanceCriteria: z.array(
    z.object({ key: z.string(), criteria: z.array(z.string()) })
  ).default([]),
  risks: z.array(
    z.object({
      level: z.enum(["low", "medium", "high"]),
      message: z.string(),
      storyKey: z.string().nullable().optional(),
    })
  ).default([]),
});

// ------------------------------------------------------------- qe-pipelines
export const QePipelinesIn = z.object({
  story: StoryInput,
  framework: z.string().default("playwright"),
  language: z.string().default("typescript"),
});

export const AssetOut = z.object({
  path: z.string(),
  kind: z.enum(["spec", "fixture", "pageobject", "data", "report", "patch"]),
  content: z.string(),
});

export const QePipelinesOut = z.object({
  summary: z.string(),
  scenarios: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["happy-path", "edge-case", "negative", "regression"]),
      criterion: z.string().describe("Which acceptance criterion this covers"),
    })
  ),
  assets: z.array(AssetOut),
  needsHuman: z.boolean().default(false),
  notes: z.string().default(""),
});

// ----------------------------------------------------------------- qe-batch
export const QeBatchIn = z.object({
  sprintName: z.string(),
  stories: z.array(StoryInput),
  availableSlots: z.number().default(2),
  framework: z.string().default("playwright"),
});

export const QeBatchOut = z.object({
  summary: z.string(),
  shards: z.array(
    z.object({
      shard: z.number(),
      storyKeys: z.array(z.string()),
      estimatedMinutes: z.number(),
    })
  ),
  sharedFixtures: z.array(
    z.object({ path: z.string(), reason: z.string(), usedBy: z.array(z.string()) })
  ).default([]),
  order: z.array(z.string()).describe("Story keys in dependency-safe order"),
});

// ------------------------------------------------------------- qe-auto-heal
export const QeAutoHealIn = z.object({
  specPath: z.string(),
  specContent: z.string(),
  failureOutput: z.string(),
  recentDiff: z.string().default(""),
});

export const QeAutoHealOut = z.object({
  diagnosis: z.string(),
  category: z.enum(["selector", "timing", "test-data", "assertion", "app-bug"]),
  shouldPatch: z.boolean().describe("False when the app is wrong and the test is right"),
  reason: z.string().describe("Why it is or is not safe to patch automatically"),
  confidence: z.enum(["low", "medium", "high"]),
  patch: z
    .object({ path: z.string(), before: z.string(), after: z.string(), unifiedDiff: z.string() })
    .nullable()
    .optional(),
});

// -------------------------------------------------------------- batch-heal
export const BatchHealIn = z.object({
  failures: z.array(
    z.object({ specPath: z.string(), failureOutput: z.string(), specContent: z.string().default("") })
  ),
  recentDiff: z.string().default(""),
});

export const BatchHealOut = z.object({
  summary: z.string(),
  groups: z.array(
    z.object({
      signature: z.string().describe("The one root cause shared by these specs"),
      specPaths: z.array(z.string()),
      fix: z.string(),
    })
  ),
  patches: z.array(
    z.object({ path: z.string(), unifiedDiff: z.string(), verified: z.boolean() })
  ).default([]),
  escalations: z.array(z.object({ specPath: z.string(), reason: z.string() })).default([]),
  prTitle: z.string(),
  prBody: z.string(),
});

// -------------------------------------------------------------- qe-insights
export const QeInsightsIn = z.object({
  window: z.string().default("last 30 runs"),
  runs: z.array(
    z.object({
      specPath: z.string(),
      status: z.string(),
      durationMs: z.number().default(0),
      storyKey: z.string().default(""),
    })
  ),
});

export const QeInsightsOut = z.object({
  summary: z.string(),
  flakes: z.array(z.object({ specPath: z.string(), failRate: z.number(), advice: z.string() })).default([]),
  slowSuites: z.array(z.object({ suite: z.string(), p95Seconds: z.number() })).default([]),
  coverageGaps: z.array(z.object({ area: z.string(), why: z.string() })).default([]),
  recommendation: z.string(),
});
