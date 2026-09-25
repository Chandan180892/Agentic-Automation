import { xrayConfig, xrayConfigured, httpJson, IntegrationError } from "./config";

export interface XrayStep {
  action: string;
  data: string;
  expected: string;
}

export interface XrayTestInput {
  summary: string;
  testType: "Manual" | "Cucumber" | "Generic";
  priority: string;
  steps: XrayStep[];
  gherkin: string;
  labels: string[];
  /** The Jira story this test verifies; Xray links them. */
  storyKey: string;
  projectKey: string;
}

/** Xray Cloud tokens last 24h; cache within the process rather than re-authenticating per call. */
let cached: { token: string; expires: number } | null = null;

async function authenticate(): Promise<string> {
  if (!xrayConfigured()) throw new Error("Xray is not configured on this deployment.");
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;

  const c = xrayConfig();
  const res = await fetch(`${c.baseUrl}/api/v2/authenticate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: c.clientId, client_secret: c.clientSecret }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new IntegrationError("xray", `authentication failed: ${res.status} ${text.slice(0, 200)}`);
  }
  // The endpoint returns the raw JWT as a quoted string.
  const token = text.trim().replace(/^"|"$/g, "");
  cached = { token, expires: Date.now() + 23 * 3600 * 1000 };
  return token;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const token = await authenticate();
  const data = await httpJson<{ data?: T; errors?: { message: string }[] }>(
    "xray",
    `${xrayConfig().baseUrl}/api/v2/graphql`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      timeoutMs: 30_000,
    }
  );
  if (data.errors?.length) {
    throw new IntegrationError("xray", data.errors.map((e) => e.message).join("; "));
  }
  if (!data.data) throw new IntegrationError("xray", "Xray returned no data.");
  return data.data;
}

const CREATE_TEST = `
mutation CreateTest($jira: JSON!, $testType: UpdateTestTypeInput!, $steps: [CreateStepInput], $gherkin: String) {
  createTest(jira: $jira, testType: $testType, steps: $steps, gherkin: $gherkin) {
    test { issueId jira(fields: ["key"]) }
    warnings
  }
}`;

export interface XrayCreated {
  key: string;
  issueId: string;
  summary: string;
  warnings: string[];
  /** Whether the "tests" link to the story was created. */
  linked: boolean;
}

/** Checks the Xray API credentials by authenticating. */
export async function xrayAuthOk(): Promise<boolean> {
  cached = null;
  await authenticate();
  return true;
}

/** Creates one Xray test. Manual tests carry steps; Cucumber tests carry gherkin. */
export async function createTest(input: XrayTestInput): Promise<XrayCreated> {
  const jira = {
    fields: {
      summary: input.summary,
      project: { key: input.projectKey },
      labels: input.labels,
      priority: { name: input.priority },
    },
  };

  const result = await graphql<{
    createTest: { test: { issueId: string; jira: { key: string } }; warnings: string[] };
  }>(CREATE_TEST, {
    jira,
    testType: { name: input.testType },
    steps:
      input.testType === "Manual"
        ? input.steps.map((s) => ({ action: s.action, data: s.data, result: s.expected }))
        : undefined,
    gherkin: input.testType === "Cucumber" ? input.gherkin : undefined,
  });

  return {
    key: result.createTest.test.jira.key,
    issueId: result.createTest.test.issueId,
    summary: input.summary,
    warnings: result.createTest.warnings ?? [],
    linked: false,
  };
}

/**
 * Creates the tests, then links each one to its story with the site's test link type
 * ("<test> tests <story>"), which is how Xray counts requirement coverage.
 */
export async function createTests(inputs: XrayTestInput[], linkType = "Test"): Promise<XrayCreated[]> {
  const { linkOutward } = await import("./jira");
  const created: XrayCreated[] = [];
  for (const input of inputs) {
    // Sequential on purpose: Xray Cloud rate-limits bursts, and a partial failure should
    // leave the tests already created intact rather than in an unknown state.
    const test = await createTest(input);
    if (input.storyKey) {
      try {
        await linkOutward(test.key, input.storyKey, linkType);
        test.linked = true;
      } catch (err) {
        test.warnings.push(`could not link to ${input.storyKey}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    created.push(test);
  }
  return created;
}
