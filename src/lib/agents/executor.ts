/**
 * Test execution for the autopilot.
 *
 * Autopilot does not yet drive a real browser against your application, so this is a simulated
 * executor, and every result it produces is labelled `simulated` in the run log. It is not a
 * random-number generator, though: it reads the spec source and fails a test for the same
 * reasons a real run would —
 *
 *  - a fixed `waitForTimeout` races the simulated app, which renders after 1.8 s;
 *  - a styling-class selector (`page.locator('.btn-primary')`) matches nothing, because the
 *    simulated app's last release renamed its classes;
 *  - a test that covers a criterion the simulated app violates fails its assertion.
 *
 * So a heal that removes the sleep or swaps the selector genuinely turns the test green on the
 * next execution, and a heal that tried to rewrite an assertion would have nothing to fix.
 *
 * To run against a real app, replace `executeSpec` with a call to your runner and map its
 * report into `ExecutedTest[]`; nothing else in the autopilot changes.
 */

export interface ExecutedTest {
  name: string;
  criterion: string;
  status: "passed" | "failed";
  /** Runner-style failure output. The failing line is quoted after "> ". */
  failure?: string;
  cause?: "timing" | "selector" | "app-bug";
  durationMs: number;
}

/** Behaviour the simulated application gets wrong, matched on the criterion under test. */
export const SIMULATED_DEFECTS: { match: RegExp; failure: string }[] = [
  {
    match: /retried exactly once/i,
    failure:
      "AssertionError: expect(gatewayCalls).toBe(2)\n  Expected: 2 (one attempt, one retry)\n  Received: 3\n  The client retries a 5xx twice.",
  },
  {
    match: /drift over one cent/i,
    failure:
      "AssertionError: expect(alerts).toHaveLength(1)\n  Expected: 1 alert for a drift of $0.02\n  Received: 0\n  The job compares drift against 1.00 dollars, not one cent.",
  },
];

interface ParsedTest {
  name: string;
  criterion: string;
  body: string;
}

/** Splits a Playwright file into its test() blocks. Tolerant of quote style and spacing. */
export function parseTests(content: string): ParsedTest[] {
  const starts = [...content.matchAll(/\btest\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,/g)];
  return starts.map((m, n) => {
    const from = m.index ?? 0;
    const to = n + 1 < starts.length ? (starts[n + 1].index ?? content.length) : content.length;
    const body = content.slice(from, to);
    return {
      name: m[2].replace(/\\(['"`])/g, "$1"),
      criterion: body.match(/\/\/\s*covers:\s*(.+)/)?.[1]?.trim() ?? "",
      body,
    };
  });
}

const lineOf = (body: string, pattern: RegExp) => body.split("\n").find((l) => pattern.test(l))?.trim() ?? "";

function runOne(path: string, t: ParsedTest): ExecutedTest {
  const base = { name: t.name, criterion: t.criterion };
  // Deterministic "duration" so the same spec always reports the same time.
  const durationMs = 400 + ((t.name.length * 37) % 900);

  const wait = lineOf(t.body, /waitForTimeout\(/);
  if (wait) {
    return {
      ...base,
      status: "failed",
      cause: "timing",
      durationMs: durationMs + 1500,
      failure: `TimeoutError: expect(locator).toHaveText timed out — the fixed sleep ended before the status rendered (app renders at 1.8s)\n    at ${path}\n  > ${wait}`,
    };
  }

  const styled = lineOf(t.body, /page\.locator\(\s*['"`]\.[\w-]+/);
  if (styled) {
    const sel = styled.match(/locator\(\s*['"`]([^'"`]+)/)?.[1] ?? "?";
    return {
      ...base,
      status: "failed",
      cause: "selector",
      durationMs,
      failure: `Error: locator('${sel}') resolved to 0 elements — no element carries that class in the current build\n    at ${path}\n  > ${styled}`,
    };
  }

  const defect = SIMULATED_DEFECTS.find((d) => d.match.test(t.criterion));
  if (defect) {
    return { ...base, status: "failed", cause: "app-bug", durationMs, failure: `${defect.failure}\n    at ${path}` };
  }

  return { ...base, status: "passed", durationMs };
}

/** Executes every test in one spec file. */
export function executeSpec(path: string, content: string): ExecutedTest[] {
  return parseTests(content).map((t) => runOne(path, t));
}

/** Re-executes one test by name, after a heal. */
export function executeTest(path: string, content: string, name: string): ExecutedTest | null {
  const t = parseTests(content).find((p) => p.name === name);
  return t ? runOne(path, t) : null;
}

/**
 * Applies a heal's before/after to the spec. Matches on the trimmed line so indentation in the
 * file does not have to match the patch exactly; an empty `after` removes the line.
 */
export function applyPatch(content: string, before: string, after: string): { content: string; applied: boolean } {
  const want = before.trim();
  if (!want) return { content, applied: false };
  const lines = content.split("\n");
  const i = lines.findIndex((l) => l.trim() === want);
  if (i === -1) {
    return content.includes(want)
      ? { content: content.replace(want, after.trim()), applied: true }
      : { content, applied: false };
  }
  const indent = lines[i].match(/^\s*/)?.[0] ?? "";
  if (after.trim()) lines[i] = indent + after.trim();
  else lines.splice(i, 1);
  return { content: lines.join("\n"), applied: true };
}
