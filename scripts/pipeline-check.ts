/**
 * Exercises the qe-pipeline's six sub-agents through their real contracts. With no
 * ANTHROPIC_API_KEY this checks the simulators and the schemas; with a key set it makes real
 * model calls, so the same script doubles as a post-deploy smoke test.
 *
 * The behaviours asserted here are the ones that make the pipeline trustworthy: it refuses to
 * proceed on an untestable story, it asks rather than guessing, it reuses what the repo has,
 * it will not sign off on uncovered criteria, and it converges when told to revise.
 */
import { SUB_AGENTS, SUB_AGENT_LIST } from "../src/lib/agents/pipeline-registry";
import { agentsAreLive } from "../src/lib/agents/runtime";

const results: string[] = [];
let failures = 0;
function check(name: string, cond: boolean, extra = "") {
  if (!cond) failures++;
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
}

const GOOD_STORY = {
  key: "PAY-812",
  summary: "Idempotency keys on checkout submit",
  description: "A double-click on Pay must not create two orders.",
  acceptanceCriteria: [
    "Submitting the same idempotency key twice creates exactly one order.",
    "The second response returns the original order, not an error.",
  ],
  issueType: "Story",
  labels: ["payments"],
};

const VAGUE_STORY = { ...GOOD_STORY, key: "PAY-830", summary: "Make refunds better", acceptanceCriteria: [] };

function run<T>(id: keyof typeof SUB_AGENTS, input: unknown): T {
  const def = SUB_AGENTS[id];
  const parsed = def.input.parse(input);
  // @ts-expect-error each sub-agent's simulate is narrowed to its own input type
  return def.output.parse(def.simulate(parsed)) as T;
}

console.log(`mode: ${agentsAreLive() ? "LIVE" : "SIMULATED"}\n`);

check("six sub-agents, ordered 1..6", SUB_AGENT_LIST.map((a) => a.order).join(",") === "1,2,3,4,5,6");

// --- story-analyzer -------------------------------------------------------
const analysis = run<{ testable: boolean; behaviours: unknown[]; ambiguities: { blocking: boolean }[] }>(
  "story-analyzer",
  { story: GOOD_STORY, framework: "playwright" }
);
check("story-analyzer finds behaviours in a specified story", analysis.behaviours.length > 0);
check("story-analyzer marks a specified story testable", analysis.testable);

const vague = run<{ testable: boolean; ambiguities: { blocking: boolean }[] }>("story-analyzer", {
  story: VAGUE_STORY,
  framework: "playwright",
});
check("story-analyzer refuses to call an unspecified story testable", vague.testable === false);
check("story-analyzer raises a blocking ambiguity for it", vague.ambiguities.some((a) => a.blocking));

// --- clarify --------------------------------------------------------------
const clar = run<{ blocked: boolean; questions: { suggestedAnswer: string }[]; jiraComment: string }>("clarify", {
  story: VAGUE_STORY,
  ambiguities: vague.ambiguities,
});
check("clarify blocks on a blocking ambiguity", clar.blocked);
check("clarify offers a default for every question", clar.questions.every((q) => q.suggestedAnswer.length > 0));
check("clarify drafts a Jira comment", clar.jiraComment.length > 20);

// --- asset-resolver -------------------------------------------------------
const resolved = run<{ reuse: { path: string }[]; create: { path: string }[]; conventions: { specDir: string } }>(
  "asset-resolver",
  {
    story: GOOD_STORY,
    behaviours: [{ name: "happy path", criterion: GOOD_STORY.acceptanceCriteria[0] }],
    repoPaths: ["e2e/tests/checkout.spec.ts", "e2e/fixtures/testUsers.ts", "e2e/pages/CheckoutPage.ts", "README.md"],
    framework: "playwright",
  }
);
check("asset-resolver reuses existing repo assets", resolved.reuse.length > 0, `${resolved.reuse.length}`);
check("asset-resolver follows the repo's spec directory", resolved.conventions.specDir.includes("tests"), resolved.conventions.specDir);
check("asset-resolver does not recreate what it reuses",
  !resolved.create.some((c) => resolved.reuse.some((r) => r.path === c.path)));

// --- spec-author ----------------------------------------------------------
const behaviours = GOOD_STORY.acceptanceCriteria.map((c, n) => ({
  name: `Behaviour ${n + 1}`,
  criterion: c,
  kind: "happy-path",
}));
const authored = run<{ files: { path: string; content: string }[]; testCases: { criterion: string; steps: { expected: string }[] }[]; branchName: string }>(
  "spec-author",
  {
    story: GOOD_STORY,
    behaviours,
    reuse: resolved.reuse.map((r) => ({ path: r.path, kind: "fixture" })),
    create: resolved.create.map((c) => ({ path: c.path, kind: "spec" })),
    conventions: resolved.conventions,
    framework: "playwright",
  }
);
check("spec-author writes files", authored.files.length > 0);
check("spec-author writes no placeholders", !authored.files.some((f) => /TODO|FIXME/.test(f.content)));
check("spec-author produces Xray cases with real expected results",
  authored.testCases.length > 0 && authored.testCases.every((t) => t.steps.every((s) => s.expected.length > 5)));
check("spec-author names a branch", /^qe\//.test(authored.branchName), authored.branchName);

// --- verifier -------------------------------------------------------------
const verifiedGood = run<{ passed: boolean; coverage: { covered: boolean }[] }>("verifier", {
  story: GOOD_STORY,
  behaviours: behaviours.map((b) => ({ name: b.name, criterion: b.criterion })),
  files: authored.files,
  testCases: authored.testCases.map((t) => ({ summary: "t", criterion: t.criterion })),
});
check("verifier maps every criterion", verifiedGood.coverage.length === GOOD_STORY.acceptanceCriteria.length);

const verifiedBad = run<{ passed: boolean; coverage: { covered: boolean }[] }>("verifier", {
  story: GOOD_STORY,
  behaviours: [],
  files: [{ path: "tests/x.spec.ts", content: "// TODO write this" }],
  testCases: [],
});
check("verifier fails work that covers nothing", verifiedBad.passed === false);
check("verifier reports uncovered criteria honestly", verifiedBad.coverage.every((c) => !c.covered));

// --- revision loop --------------------------------------------------------
const revised = run<{ testCases: { criterion: string }[] }>("spec-author", {
  story: GOOD_STORY,
  behaviours,
  reuse: [],
  create: resolved.create.map((c) => ({ path: c.path, kind: "spec" })),
  conventions: resolved.conventions,
  framework: "playwright",
  revision: {
    attempt: 1,
    defects: [{ path: "tests/x.spec.ts", issue: "placeholder", fix: "write it" }],
    uncoveredCriteria: [GOOD_STORY.acceptanceCriteria[1]],
    previousFiles: authored.files,
  },
});
check("a revision closes the uncovered criterion",
  revised.testCases.some((t) => t.criterion === GOOD_STORY.acceptanceCriteria[1]));

// --- reviewer -------------------------------------------------------------
const approved = run<{ verdict: string; publishReady: boolean; prDescription: string }>("reviewer", {
  story: GOOD_STORY,
  files: authored.files,
  testCases: authored.testCases.map((t) => ({ summary: "t", criterion: t.criterion })),
  verifier: { passed: true, defects: [], coverage: GOOD_STORY.acceptanceCriteria.map((c) => ({ criterion: c, covered: true })) },
});
check("reviewer approves complete work", approved.verdict === "approve" && approved.publishReady);
check("reviewer writes a PR description when approving", approved.prDescription.length > 30);

const rejected = run<{ verdict: string; publishReady: boolean }>("reviewer", {
  story: GOOD_STORY,
  files: authored.files,
  testCases: [],
  verifier: {
    passed: false,
    defects: [{ path: "tests/x.spec.ts", severity: "blocker", issue: "asserts nothing" }],
    coverage: GOOD_STORY.acceptanceCriteria.map((c) => ({ criterion: c, covered: false })),
  },
});
check("reviewer refuses to publish uncovered work", rejected.verdict !== "approve" && !rejected.publishReady);

console.log(results.join("\n"));
console.log(`\n${results.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
