/**
 * The automation rulebook: the failure patterns that most often make API, UI and end-to-end
 * suites flaky, slow or blind, taken from public post-mortems and guidance (sources on each
 * rule). It is used three ways:
 *
 * 1. As guidance in spec-author's and verifier's system prompts, so the first draft avoids them
 *    (the prompt is static, so it is cached and costs almost nothing after the first call).
 * 2. As a deterministic quality gate over the generated code. It costs no model call: what it
 *    can fix with certainty it fixes, what it cannot it reports.
 * 3. As the checklist in the story's test report.
 *
 * `block` findings are defects: a suite with one should not merge. `warn` findings are risks
 * the report lists; the gate never guesses a fix for them (the right selector, for example,
 * depends on the page).
 */

export type Layer = "ui" | "api" | "e2e" | "any";
export type Severity = "block" | "warn";

export interface Source {
  name: string;
  url?: string;
}

const SRC = {
  pwBest: { name: "Playwright — Best Practices", url: "https://playwright.dev/docs/best-practices" },
  pwAssert: { name: "Playwright — Auto-retrying assertions", url: "https://playwright.dev/docs/test-assertions" },
  pwLocators: { name: "Playwright — Locators", url: "https://playwright.dev/docs/locators" },
  googleFlaky: { name: "Google Testing Blog — Flaky Tests at Google and How We Mitigate Them", url: "https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html" },
  fowlerNonDet: { name: "Martin Fowler — Eradicating Non-Determinism in Tests", url: "https://martinfowler.com/articles/nonDeterminism.html" },
  pyramid: { name: "Ham Vocke — The Practical Test Pyramid", url: "https://martinfowler.com/articles/practical-test-pyramid.html" },
  luo: { name: "Luo et al. — An Empirical Analysis of Flaky Tests (FSE 2014): async waits, concurrency and test-order dependency are the top root causes" },
  owasp: { name: "OWASP — Secrets Management Cheat Sheet", url: "https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html" },
} satisfies Record<string, Source>;

export interface Finding {
  rule: string;
  title: string;
  severity: Severity;
  path: string;
  line: number;
  text: string;
  fixed: boolean;
}

interface LineRule {
  kind: "line";
  test: RegExp;
  /** Returns the fixed line, or null to delete it. Absent when no fix is certain. */
  fix?: (line: string) => string | null;
}
interface BlockRule {
  kind: "test-block";
  /** Returns true when a single test body breaks the rule. */
  test: (name: string, body: string) => boolean;
}

export interface Rule {
  id: string;
  layer: Layer;
  severity: Severity;
  title: string;
  /** The real failure this prevents. */
  why: string;
  /** What to write instead; goes into the prompts. */
  instead: string;
  sources: Source[];
  check?: LineRule | BlockRule;
}

const hasAssertion = (body: string) => /\bexpect(\.poll|\.soft)?\s*\(|\bassert\w*\s*\(|\.should\(/.test(body);

export const RULES: Rule[] = [
  // --------------------------------------------------------------- waiting --
  {
    id: "no-fixed-waits",
    layer: "any",
    severity: "block",
    title: "No fixed sleeps",
    why: "A fixed wait is either too short on a slow CI runner (flaky) or too long everywhere else (slow). Async waiting is the most common root cause of flaky tests.",
    instead: "Let a web-first assertion wait (await expect(locator).toBeVisible()), or poll a condition with expect.poll / expect(...).toPass().",
    sources: [SRC.luo, SRC.pwAssert, SRC.googleFlaky],
    check: {
      kind: "line",
      test: /\bwaitForTimeout\s*\(|\bawait\s+(sleep|delay|wait)\s*\(\s*\d|new Promise\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*setTimeout\(/,
      fix: (line) => (/^\s*await\s+[\w.]*(waitForTimeout|sleep|delay|wait)\s*\([^)]*\)\s*;?\s*$/.test(line) || /^\s*await new Promise\(.*setTimeout.*\);?\s*$/.test(line) ? null : line),
    },
  },
  {
    id: "web-first-assertions",
    layer: "ui",
    severity: "warn",
    title: "Assertions that retry",
    why: "expect(await el.isVisible()).toBe(true) reads the page once; if it renders 50 ms later the test fails for no reason.",
    instead: "await expect(locator).toBeVisible() / toHaveText() / toBeEnabled() — they retry until the timeout.",
    sources: [SRC.pwAssert, SRC.pwBest],
    check: {
      kind: "line",
      test: /expect\(\s*await\s+[^;]+?\.(isVisible|isHidden|isEnabled|isDisabled|isChecked)\(\)\s*\)\.toBe(Truthy|Falsy)?\(/,
      fix: (line) => {
        const m = line.match(/^(\s*)expect\(\s*await\s+(.+?)\.(isVisible|isHidden|isEnabled|isDisabled|isChecked)\(\)\s*\)\.(toBe\((true|false)\)|toBeTruthy\(\)|toBeFalsy\(\))\s*;?\s*$/);
        if (!m) return line;
        const [, indent, target, method, matcher, bool] = m;
        const negate = matcher === "toBeFalsy()" || bool === "false";
        const assertion = { isVisible: "toBeVisible", isHidden: "toBeHidden", isEnabled: "toBeEnabled", isDisabled: "toBeDisabled", isChecked: "toBeChecked" }[method as "isVisible"];
        return `${indent}await expect(${target})${negate ? ".not" : ""}.${assertion}();`;
      },
    },
  },
  // ------------------------------------------------------------- selectors --
  {
    id: "stable-selectors",
    layer: "ui",
    severity: "warn",
    title: "Selectors users would recognise",
    why: "Styling classes, XPath and nth-child positions change with every redesign and break tests that are otherwise correct.",
    instead: "page.getByRole('button', { name: 'Pay' }), getByLabel, getByText, or getByTestId for things with no accessible name.",
    sources: [SRC.pwLocators, SRC.pwBest],
    check: {
      kind: "line",
      test: /locator\(\s*['"`](\.[\w-]*(btn|button|col-|row|mt-|mb-|ml-|mr-|p-\d|px-|py-|flex|grid|text-|bg-|w-\d|h-\d|css-|sc-)[\w-]*|\/\/|xpath=|[^'"`]*:nth-(child|of-type)\()/i,
    },
  },
  {
    id: "no-element-handles",
    layer: "ui",
    severity: "warn",
    title: "Locators, not element handles",
    why: "page.$() returns a handle to a node that may be detached a moment later; actions on it fail with 'element is not attached'.",
    instead: "Use page.locator()/getByRole(); locators re-resolve on every action.",
    sources: [SRC.pwLocators],
    check: { kind: "line", test: /\bpage\.\$\$?\(|\.\$eval\(|\.\$\$eval\(/ },
  },
  {
    id: "no-force",
    layer: "ui",
    severity: "warn",
    title: "No forced actions",
    why: "{ force: true } clicks through overlays and disabled states, so the test passes while a real user is blocked.",
    instead: "Wait for the element to become actionable, or assert why it is not.",
    sources: [SRC.pwBest],
    check: {
      kind: "line",
      test: /\{\s*force\s*:\s*true\s*\}/,
      fix: (line) => line.replace(/,\s*\{\s*force\s*:\s*true\s*\}/, "").replace(/\(\s*\{\s*force\s*:\s*true\s*\}\s*\)/, "()"),
    },
  },
  // --------------------------------------------------------- independence --
  {
    id: "no-focused-tests",
    layer: "any",
    severity: "block",
    title: "No test.only",
    why: "A committed .only silently skips every other test in the run.",
    instead: "Remove .only before committing.",
    sources: [SRC.pwBest],
    check: { kind: "line", test: /\b(test|it|describe)\.only\s*\(/, fix: (line) => line.replace(/\b(test|it|describe)\.only\s*\(/, "$1(") },
  },
  {
    id: "no-skipped-tests",
    layer: "any",
    severity: "block",
    title: "No skipped tests",
    why: "A generated test that is skipped covers nothing but still counts as coverage in reports.",
    instead: "Write the test fully, or leave the criterion uncovered and say so.",
    sources: [SRC.googleFlaky],
    check: { kind: "line", test: /\b(test|it|describe)\.(skip|fixme)\s*\(/ },
  },
  {
    id: "independent-tests",
    layer: "e2e",
    severity: "warn",
    title: "Tests that run in any order",
    why: "Serial suites share state; one failure cascades and the suite cannot run in parallel. Order dependency is a top-three cause of flakiness.",
    instead: "Each test sets up its own data (preferably through the API) and cleans up after itself.",
    sources: [SRC.luo, SRC.fowlerNonDet],
    check: { kind: "line", test: /describe\.serial\s*\(|configure\(\s*\{[^}]*mode\s*:\s*['"]serial/ },
  },
  {
    id: "no-retry-masking",
    layer: "any",
    severity: "warn",
    title: "Retries do not hide failures",
    why: "Retries configured inside a spec turn a real intermittent bug into a green build.",
    instead: "Keep retries in CI config only, and report retried passes as flaky.",
    sources: [SRC.googleFlaky],
    check: { kind: "line", test: /configure\(\s*\{[^}]*retries\s*:\s*[1-9]/ },
  },
  // ------------------------------------------------------------ assertions --
  {
    id: "test-has-assertion",
    layer: "any",
    severity: "block",
    title: "Every test asserts something",
    why: "A test with no assertion passes as long as nothing throws, so it cannot detect the bug it is named after.",
    instead: "End every test with an assertion on the outcome the criterion describes.",
    sources: [SRC.pyramid],
    check: { kind: "test-block", test: (_name, body) => !hasAssertion(body) },
  },
  {
    id: "assertion-can-fail",
    layer: "any",
    severity: "block",
    title: "Assertions that can fail",
    why: "expect(true).toBe(true) and friends always pass; they inflate coverage and hide gaps.",
    instead: "Assert on a value the system under test produced.",
    sources: [SRC.pyramid],
    check: { kind: "line", test: /expect\(\s*(true|false|1|0|null|undefined|['"][^'"]*['"])\s*\)\.(toBe|toEqual|toBeTruthy|toBeFalsy|toBeDefined)\(/ },
  },
  {
    id: "no-placeholders",
    layer: "any",
    severity: "block",
    title: "No placeholders",
    why: "TODOs and 'not implemented' stubs ship as passing tests that verify nothing.",
    instead: "Write the step, or leave the scenario out and report it as uncovered.",
    sources: [SRC.pyramid],
    check: { kind: "line", test: /\/\/\s*(TODO|FIXME|XXX)\b|throw new Error\(\s*['"`](not implemented|todo)/i },
  },
  {
    id: "api-assert-body",
    layer: "api",
    severity: "warn",
    title: "API tests check the body, not just the status",
    why: "A 200 with the wrong payload, or a 400 for the wrong reason, passes a status-only check. Most API regressions are in the body.",
    instead: "Assert the status and the fields the criterion names (toMatchObject / schema); for rejections, assert the error code or message.",
    sources: [SRC.pyramid],
    check: {
      kind: "test-block",
      test: (_name, body) =>
        /\brequest\.(get|post|put|patch|delete|fetch)\(/.test(body) &&
        /\.status\(\)|toBeOK\(\)/.test(body) &&
        !/\.json\(\)|\.text\(\)|toMatchObject|toHaveProperty|toEqual\(\s*\{|toContain|schema|\.body/.test(body),
    },
  },
  // ------------------------------------------------------------------ data --
  {
    id: "no-hardcoded-secrets",
    layer: "any",
    severity: "block",
    title: "No secrets in test code",
    why: "Tokens and passwords committed to a test repo leak with every clone and cannot be rotated safely.",
    instead: "Read them from environment variables or the CI secret store (process.env.X).",
    sources: [SRC.owasp],
    check: {
      kind: "line",
      test: /(password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"`](?!\$\{)[^'"`\s]{6,}['"`]|['"`]Bearer\s+[A-Za-z0-9._-]{12,}['"`]/i,
    },
  },
  {
    id: "no-hardcoded-hosts",
    layer: "any",
    severity: "warn",
    title: "No hard-coded environments",
    why: "A URL baked into a spec ties it to one environment; the suite cannot run against staging or a preview build.",
    instead: "Use baseURL from the Playwright config and relative paths (page.goto('/checkout')).",
    sources: [SRC.pwBest],
    check: { kind: "line", test: /(goto|request\.(get|post|put|patch|delete|fetch)|fetch)\(\s*['"`]https?:\/\//},
  },
  {
    id: "unique-test-data",
    layer: "e2e",
    severity: "warn",
    title: "Unique test data per test",
    why: "Fixed ids and emails collide when tests run in parallel or re-run against a dirty environment.",
    instead: "Generate ids per test (crypto.randomUUID(), Date.now() suffix) from a data factory, and clean up afterwards.",
    sources: [SRC.fowlerNonDet],
    check: { kind: "line", test: /\b(orderId|userId|accountId|customerId|id)\s*:\s*['"`]?\d{3,}['"`]?\s*[,}]|['"`][\w.+-]+@(test|example)\.(com|org)['"`]/ },
  },
  {
    id: "locale-independent",
    layer: "any",
    severity: "warn",
    title: "No locale or time-zone dependent values",
    why: "toLocaleString() and 'now' differ between a laptop and a CI runner in another region, so the same test passes in one place and fails in another.",
    instead: "Fix the clock (page.clock / a fixed date) and the locale in config; compare ISO values.",
    sources: [SRC.fowlerNonDet],
    check: { kind: "line", test: /\.toLocale(Date|Time)?String\(\s*\)|new Date\(\)\.get(Date|Day|Hours)\(/ },
  },
  {
    id: "no-debug-output",
    layer: "any",
    severity: "warn",
    title: "No debug logging",
    why: "console.log in tests floods CI output and often prints data that should stay private.",
    instead: "Use test.info().attach() or the trace viewer.",
    sources: [SRC.pwBest],
    check: { kind: "line", test: /^\s*console\.log\(.*\);?\s*$/, fix: () => null },
  },
  // ------------------------------------------------- guidance only (prompts) --
  {
    id: "lowest-level",
    layer: "any",
    severity: "warn",
    title: "Test at the lowest level that can prove it",
    why: "UI tests are 10–100× slower and flakier than API tests for the same rule; an inverted pyramid is the most common reason suites become unmaintainable.",
    instead: "Business rules and validation at API level; UI tests only for what the user must see or do.",
    sources: [SRC.pyramid],
  },
  {
    id: "setup-through-api",
    layer: "e2e",
    severity: "warn",
    title: "Arrange through the API, act through the UI",
    why: "Clicking through setup screens in every test multiplies runtime and failure points that are not what the test is about.",
    instead: "Create users, orders and state through API calls or fixtures; reuse storage state for sign-in.",
    sources: [SRC.pwBest, SRC.pyramid],
  },
  {
    id: "one-behaviour-per-test",
    layer: "any",
    severity: "warn",
    title: "One behaviour per test, named after it",
    why: "A test that checks five things fails with an unclear reason, and its name no longer traces to a criterion.",
    instead: "One scenario per test; name it after the Xray case ([Positive] …) and comment the criterion it covers.",
    sources: [SRC.pwBest],
  },
  {
    id: "negative-and-boundary",
    layer: "any",
    severity: "warn",
    title: "Cover rejections and limits, not only the happy path",
    why: "Most production defects sit in validation and boundaries, which happy-path suites never touch.",
    instead: "For each criterion: the positive case, at least one rejection with its reason, and the values either side of every limit.",
    sources: [SRC.pyramid],
  },
];

// ------------------------------------------------------------------ prompts --

/** The rulebook as prompt text: stable, so it sits in the cached system prompt. */
export function rulebookPrompt(): string {
  const byLayer = (l: Layer) => RULES.filter((r) => r.layer === l);
  const line = (r: Rule) => `- ${r.title}${r.severity === "block" ? " [blocking]" : ""}: ${r.instead}`;
  return [
    "Automation rulebook — known causes of flaky, slow or blind suites. Follow it in every file:",
    "Everywhere:",
    ...byLayer("any").map(line),
    "UI:",
    ...byLayer("ui").map(line),
    "API:",
    ...byLayer("api").map(line),
    "End to end:",
    ...byLayer("e2e").map(line),
    "Generated code is checked against these rules automatically; blocking findings send the work back.",
  ].join("\n");
}

// --------------------------------------------------------------------- gate --

const isTestFile = (path: string) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(path);
const isCode = (path: string) => /\.[cm]?[jt]sx?$/.test(path);

/** Splits a spec into test blocks by matching braces from each test( call. */
function testBlocks(content: string): { name: string; body: string; line: number }[] {
  const out: { name: string; body: string; line: number }[] = [];
  const re = /\b(?:test|it)(?:\.only)?\s*\(\s*(['"`])(.*?)\1\s*,\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*=>\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    let depth = 1;
    let i = re.lastIndex;
    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      i++;
    }
    out.push({ name: m[2], body: content.slice(re.lastIndex, i - 1), line: content.slice(0, m.index).split("\n").length });
  }
  return out;
}

export interface GateResult {
  files: { path: string; content: string }[];
  findings: Finding[];
  checked: number;
  fixed: number;
  blocking: number;
  warnings: number;
  summary: string;
}

/**
 * Runs every checkable rule over the generated files, applies the fixes it is certain of, and
 * returns the fixed files with what it found. Deterministic and free: no model call.
 */
export function qualityGate<F extends { path: string; content: string }>(files: F[]): GateResult & { files: F[] } {
  const findings: Finding[] = [];
  const out = files.map((f) => {
    if (!isCode(f.path)) return f;
    const lines = f.content.split("\n");
    const kept: string[] = [];
    lines.forEach((raw, idx) => {
      let line: string | null = raw;
      for (const r of RULES) {
        if (line === null || r.check?.kind !== "line") continue;
        if (!r.check.test.test(line)) continue;
        // Most rules are about test code; placeholders and secrets apply to every file.
        if (!isTestFile(f.path) && !["no-placeholders", "no-hardcoded-secrets", "no-debug-output"].includes(r.id)) continue;
        const fixedLine: string | null = r.check.fix ? r.check.fix(line) : line;
        const fixed = r.check.fix !== undefined && fixedLine !== line;
        findings.push({ rule: r.id, title: r.title, severity: r.severity, path: f.path, line: idx + 1, text: raw.trim().slice(0, 160), fixed });
        if (fixed) line = fixedLine;
      }
      if (line !== null) kept.push(line);
    });
    const content = kept.join("\n");
    if (isTestFile(f.path)) {
      for (const b of testBlocks(content)) {
        for (const r of RULES) {
          if (r.check?.kind !== "test-block" || !r.check.test(b.name, b.body)) continue;
          findings.push({ rule: r.id, title: r.title, severity: r.severity, path: f.path, line: b.line, text: `test "${b.name.slice(0, 100)}"`, fixed: false });
        }
      }
    }
    return content === f.content ? f : { ...f, content };
  });
  const fixed = findings.filter((x) => x.fixed).length;
  const blocking = findings.filter((x) => !x.fixed && x.severity === "block").length;
  const warnings = findings.filter((x) => !x.fixed && x.severity === "warn").length;
  const checked = RULES.filter((r) => r.check).length;
  return {
    files: out,
    findings,
    checked,
    fixed,
    blocking,
    warnings,
    summary:
      findings.length === 0
        ? `${checked} rules checked: clean.`
        : `${checked} rules checked: ${fixed} fixed automatically, ${blocking} blocking, ${warnings} warning(s).`,
  };
}
