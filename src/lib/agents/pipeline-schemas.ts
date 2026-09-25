import { z } from "zod";

export const ExistingTest = z.object({
  key: z.string(),
  summary: z.string(),
  kind: z.string().default("").describe("positive | negative | edge, from the team's summary prefix"),
});

export const StoryContext = z.object({
  key: z.string(),
  summary: z.string(),
  description: z.string().default(""),
  acceptanceCriteria: z.array(z.string()).default([]),
  issueType: z.string().default("Story"),
  labels: z.array(z.string()).default([]),
  /** The Jira priority (Highest … Lowest); raises the test priority of risky criteria. */
  priority: z.string().default(""),
  /** The team's own manual test notes on the story (e.g. Jira "Test Criteria"), verbatim. */
  testCriteria: z.string().default(""),
  /** Recent comments, oldest first. Later comments can change the scope. */
  comments: z.array(z.string()).default([]),
  parent: z.string().default("").describe("Parent epic, as 'KEY: summary'"),
  components: z.array(z.string()).default([]),
  /** Tests already linked to the story in Xray; extend them, never duplicate them. */
  existingTests: z.array(ExistingTest).default([]),
});

// ----------------------------------------------------------- test-strategist
export const TECHNIQUES = [
  "equivalence-partitioning",
  "boundary-value",
  "decision-table",
  "state-transition",
  "pairwise",
  "error-guessing",
  "use-case",
  "exploratory",
] as const;
export const LEVELS = ["unit", "api", "integration", "ui-e2e", "manual"] as const;

export const TestStrategistIn = z.object({
  story: StoryContext,
  behaviours: z.array(
    z.object({ name: z.string(), criterion: z.string(), kind: z.string(), risk: z.enum(["low", "medium", "high"]) })
  ),
  framework: z.string().default("playwright"),
});

export const TestStrategistOut = z.object({
  summary: z.string(),
  approach: z.string().describe("The overall strategy in two or three sentences: levels, emphasis, what is deliberately not tested"),
  levels: z.array(
    z.object({ level: z.enum(LEVELS), share: z.number().describe("Percent of the new tests at this level"), why: z.string() })
  ),
  criteria: z.array(
    z.object({
      criterion: z.string().describe("Exactly as given"),
      techniques: z.array(z.enum(TECHNIQUES)).min(1),
      level: z.enum(LEVELS),
      priority: z.enum(["P1", "P2", "P3"]),
      risk: z.enum(["low", "medium", "high"]),
      automate: z.boolean(),
      why: z.string().describe("Why these techniques, this level and this priority"),
      preconditions: z.array(z.string()).default([]),
      testData: z.array(z.string()).default([]),
      scenarios: z.array(
        z.object({
          title: z.string(),
          kind: z.enum(["positive", "negative", "edge"]),
          coveredBy: z.string().default("").describe("Key of an existing test that already covers it, or empty"),
        })
      ),
    })
  ),
  risks: z.array(z.object({ risk: z.string(), mitigation: z.string() })).default([]),
  scopeNotes: z.array(z.string()).default([]).describe("Scope changes or conflicts found in comments"),
  nonFunctional: z.array(z.string()).default([]),
});

// ---------------------------------------------------------- story-analyzer
export const StoryAnalyzerIn = z.object({
  story: StoryContext,
  framework: z.string().default("playwright"),
});

export const StoryAnalyzerOut = z.object({
  summary: z.string(),
  testable: z.boolean().describe("False when nothing here can be verified as written"),
  behaviours: z.array(
    z.object({
      name: z.string(),
      criterion: z.string().describe("The acceptance criterion or description line it comes from"),
      kind: z.enum(["happy-path", "edge-case", "negative", "regression", "non-functional"]),
      risk: z.enum(["low", "medium", "high"]),
    })
  ),
  ambiguities: z.array(
    z.object({
      quote: z.string().describe("The exact wording that is unclear"),
      why: z.string(),
      blocking: z.boolean().describe("True when a spec cannot be written without an answer"),
    })
  ).default([]),
  outOfScope: z.array(z.string()).default([]),
});

// ------------------------------------------------------------------ clarify
export const ClarifyIn = z.object({
  story: StoryContext,
  ambiguities: z.array(z.object({ quote: z.string(), why: z.string(), blocking: z.boolean() })),
});

export const ClarifyOut = z.object({
  summary: z.string(),
  questions: z.array(
    z.object({
      question: z.string(),
      why: z.string().describe("What the answer changes about the tests"),
      blocking: z.boolean(),
      suggestedAnswer: z.string().default("").describe("A default the team can accept or correct"),
    })
  ),
  /** True when the pipeline must stop and wait for a human. */
  blocked: z.boolean(),
  jiraComment: z.string().describe("The comment to post on the Jira story, if approved"),
});

// ----------------------------------------------------------- asset-resolver
export const AssetResolverIn = z.object({
  story: StoryContext,
  behaviours: z.array(z.object({ name: z.string(), criterion: z.string() })),
  repoPaths: z.array(z.string()).describe("Existing files in the Bitbucket repo"),
  framework: z.string().default("playwright"),
});

export const AssetResolverOut = z.object({
  summary: z.string(),
  reuse: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["spec", "fixture", "pageobject", "data", "helper"]),
      why: z.string(),
    })
  ).default([]),
  create: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["spec", "fixture", "pageobject", "data", "helper"]),
      why: z.string(),
    })
  ),
  conventions: z.object({
    specDir: z.string(),
    fixtureDir: z.string(),
    naming: z.string().describe("The file naming pattern this repo already follows"),
  }),
});

// --------------------------------------------------------------- spec-author
export const SpecAuthorIn = z.object({
  story: StoryContext,
  behaviours: z.array(z.object({ name: z.string(), criterion: z.string(), kind: z.string() })),
  reuse: z.array(z.object({ path: z.string(), kind: z.string() })).default([]),
  create: z.array(z.object({ path: z.string(), kind: z.string() })),
  conventions: z.object({ specDir: z.string(), fixtureDir: z.string(), naming: z.string() }),
  framework: z.string().default("playwright"),
  /** test-strategist's plan: which scenarios to write, at which level, with what setup. */
  strategy: z
    .array(
      z.object({
        criterion: z.string(),
        level: z.string(),
        priority: z.enum(["P1", "P2", "P3"]),
        automate: z.boolean(),
        preconditions: z.array(z.string()).default([]),
        testData: z.array(z.string()).default([]),
        scenarios: z.array(z.object({ title: z.string(), kind: z.enum(["positive", "negative", "edge"]), coveredBy: z.string().default("") })),
      })
    )
    .default([]),
  /** Present only on a re-attempt, carrying what the verifier rejected. */
  revision: z
    .object({
      attempt: z.number(),
      defects: z.array(z.object({ path: z.string(), issue: z.string(), fix: z.string() })),
      uncoveredCriteria: z.array(z.string()),
      previousFiles: z.array(z.object({ path: z.string(), content: z.string() })),
    })
    .optional(),
});

export const SpecAuthorOut = z.object({
  summary: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      kind: z.enum(["spec", "fixture", "pageobject", "data", "helper"]),
      content: z.string().describe("Complete runnable file — no TODOs, no elisions"),
    })
  ),
  testCases: z.array(
    z.object({
      summary: z.string(),
      testType: z.enum(["Manual", "Cucumber", "Generic"]),
      priority: z.enum(["Highest", "High", "Medium", "Low", "Lowest"]),
      criterion: z.string(),
      labels: z.array(z.string()).default([]),
      gherkin: z.string().default(""),
      steps: z.array(
        z.object({ action: z.string(), data: z.string().default(""), expected: z.string() })
      ).default([]),
    })
  ),
  branchName: z.string().describe("Bitbucket branch to commit onto, e.g. qe/PAY-812-specs"),
});

// ----------------------------------------------------------------- verifier
export const VerifierIn = z.object({
  story: StoryContext,
  behaviours: z.array(z.object({ name: z.string(), criterion: z.string() })),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  testCases: z.array(z.object({ summary: z.string(), criterion: z.string() })),
});

export const VerifierOut = z.object({
  summary: z.string(),
  passed: z.boolean(),
  coverage: z.array(
    z.object({
      criterion: z.string(),
      covered: z.boolean(),
      by: z.array(z.string()).default([]).describe("Test case summaries covering it"),
    })
  ),
  defects: z.array(
    z.object({
      path: z.string(),
      severity: z.enum(["blocker", "major", "minor"]),
      issue: z.string(),
      fix: z.string(),
    })
  ).default([]),
});

// ----------------------------------------------------------------- reviewer
export const ReviewerIn = z.object({
  story: StoryContext,
  files: z.array(z.object({ path: z.string(), content: z.string() })),
  testCases: z.array(z.object({ summary: z.string(), criterion: z.string() })),
  verifier: z.object({
    passed: z.boolean(),
    defects: z.array(z.object({ path: z.string(), severity: z.string(), issue: z.string() })),
    coverage: z.array(z.object({ criterion: z.string(), covered: z.boolean() })),
  }),
});

export const ReviewerOut = z.object({
  summary: z.string(),
  verdict: z.enum(["approve", "request-changes", "reject"]),
  rationale: z.string(),
  changesRequested: z.array(z.object({ path: z.string(), change: z.string() })).default([]),
  publishReady: z.boolean().describe("Safe to propose to Xray and Bitbucket"),
  prTitle: z.string().default(""),
  prDescription: z.string().default(""),
});
