/**
 * Live-Jira path, end to end, against a local fake of Jira Cloud and Xray Cloud.
 *
 * The fake answers the same REST and GraphQL calls a real site does, with the shapes a real
 * site returns them in (ADF bodies, custom fields found by name, "Xray Test" issue types,
 * "Defect" instead of "Bug"). The fixture is synthetic: no real site's data is in this repo.
 *
 * Covers: fetching and mapping a story, search, the agents' strategy and spec, the report,
 * and creating Xray tests that link back to the story.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

const results: string[] = [];
let failures = 0;
const check = (n: string, c: boolean, e = "") => {
  if (!c) failures++;
  results.push(`${c ? "PASS" : "FAIL"} ${n}${e ? ` — ${e}` : ""}`);
};

// ------------------------------------------------------------------ fixture --
const p = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const h = (text: string) => ({ type: "heading", attrs: { level: 4 }, content: [{ type: "text", text }] });
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });

const FIELDS = [
  { id: "summary", name: "Summary" },
  { id: "customfield_20001", name: "Acceptance Criteria" },
  { id: "customfield_20002", name: "Test Criteria" },
  { id: "customfield_20003", name: "Story Points" },
  { id: "customfield_20004", name: "Sprint" },
];

const STORY = {
  id: "50101",
  key: "SHOP-101",
  fields: {
    summary: "Apply a discount code at checkout",
    description: doc(p("Shoppers can enter one discount code on the checkout page before paying.")),
    issuetype: { name: "Story" },
    status: { name: "Ready for QA" },
    priority: { name: "High" },
    labels: ["checkout"],
    components: [{ name: "Web" }],
    fixVersions: [{ name: "2.4" }],
    parent: { key: "SHOP-90", fields: { summary: "Promotions" } },
    updated: "2026-09-20T10:00:00.000+0000",
    customfield_20001: doc(
      h("AC1 - Valid code"),
      p("Given a basket of 50.00 and the code SAVE10, when the shopper applies it, then the total shows 45.00."),
      h("AC2 - Invalid code"),
      p("Given an expired code, when the shopper applies it, then an error says the code has expired and the total is unchanged."),
      h("AC3 - Minimum spend"),
      p("Given a basket below the 20.00 minimum spend, when the shopper applies SAVE10, then the code is rejected.")
    ),
    customfield_20002: doc(p("Precondition: a signed-in shopper with items in the basket."), p("Check the order confirmation shows the discount.")),
    customfield_20003: 5,
    customfield_20004: [{ name: "Sprint 41", state: "closed" }, { name: "Sprint 42", state: "active" }],
    issuelinks: [
      {
        type: { name: "Test" },
        inwardIssue: {
          key: "SHOP-120",
          fields: { summary: "[Positive] Valid code reduces the total", status: { name: "Done" }, issuetype: { name: "Xray Test" } },
        },
      },
      {
        type: { name: "Relates" },
        outwardIssue: { key: "SHOP-77", fields: { summary: "Basket totals", status: { name: "Done" }, issuetype: { name: "Story" } } },
      },
    ],
    comment: {
      comments: [
        { author: { displayName: "Product Owner" }, created: "2026-09-18T09:00:00.000+0000", body: doc(p("Update: stacking two codes is out of scope for this sprint.")) },
      ],
    },
  },
};

// --------------------------------------------------------------- fake server --
const seen: { method: string; path: string; body: string }[] = [];
let nextTest = 200;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString();
  const url = new URL(req.url ?? "/", "http://fake");
  seen.push({ method: req.method ?? "GET", path: url.pathname + url.search, body });

  // Xray
  if (url.pathname === "/api/v2/authenticate") return send(res, 200, '"fake-xray-token"');
  if (url.pathname === "/api/v2/graphql") {
    if (req.headers.authorization !== "Bearer fake-xray-token") return send(res, 401, { error: "no token" });
    const key = `SHOP-${nextTest++}`;
    return send(res, 200, { data: { createTest: { test: { issueId: String(90000 + nextTest), jira: { key } }, warnings: [] } } });
  }

  // Jira
  if (!req.headers.authorization?.startsWith("Basic ")) return send(res, 401, { errorMessages: ["unauthorised"] });
  if (url.pathname === "/rest/api/3/field") return send(res, 200, FIELDS);
  if (url.pathname === "/rest/api/3/myself") return send(res, 200, { accountId: "a1", displayName: "Test Bot", emailAddress: "bot@example.test" });
  if (url.pathname === "/rest/api/3/issueLinkType") return send(res, 200, { issueLinkTypes: [{ name: "Test" }, { name: "Relates" }] });
  if (url.pathname === "/rest/api/3/issue/createmeta/SHOP/issuetypes")
    return send(res, 200, { issueTypes: [{ name: "Story" }, { name: "Defect" }, { name: "Xray Test" }] });
  if (url.pathname === "/rest/api/3/search/jql") {
    const jql = url.searchParams.get("jql") ?? "";
    const hit = /SHOP-101|discount/i.test(jql) || /project = "SHOP"/.test(jql);
    return send(res, 200, { issues: hit ? [STORY] : [] });
  }
  if (url.pathname === "/rest/api/3/issue/SHOP-101" && req.method === "GET") return send(res, 200, STORY);
  if (/^\/rest\/api\/3\/issue\/SHOP-\d+$/.test(url.pathname) && req.method === "PUT") {
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === "/rest/api/3/issue/SHOP-101/comment" && req.method === "POST") return send(res, 201, { id: "c1" });
  return send(res, 404, { errorMessages: [`fake has no ${req.method} ${url.pathname}`] });
}

async function main() {
  const server = createServer((req, res) => void handle(req, res).catch((e) => send(res, 500, String(e))));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.JIRA_BASE_URL = base;
  process.env.JIRA_EMAIL = "bot@example.test";
  process.env.JIRA_API_TOKEN = "fake";
  process.env.XRAY_BASE_URL = base;
  process.env.XRAY_CLIENT_ID = "id";
  process.env.XRAY_CLIENT_SECRET = "secret";

  const jira = await import("../src/lib/atlassian/jira");
  const xray = await import("../src/lib/atlassian/xray");
  const { db } = await import("../src/lib/db");
  const { upsertJiraStory, jiraSprintFor } = await import("../src/lib/atlassian/import");
  const { runPipeline } = await import("../src/lib/agents/pipeline");
  const { buildStoryReport, reportMarkdown, reportAsComment } = await import("../src/lib/agents/report");

  try {
    // ---- reading Jira ----
    const story = await jira.fetchStory("SHOP-101");
    check("criteria split on the AC headings", story.acceptanceCriteria.length === 3, `${story.acceptanceCriteria.length}`);
    check("each criterion keeps its title and its Given/When/Then",
      story.acceptanceCriteria[0]?.includes("Valid code") && story.acceptanceCriteria[0]?.includes("45.00"), story.acceptanceCriteria[0]);
    check("test criteria read from the field found by name", story.testCriteria.includes("signed-in shopper"));
    check("story points read from the field found by name", story.storyPoints === 5);
    check("the active sprint is chosen", story.sprint === "Sprint 42", story.sprint);
    check("the parent epic is kept", story.parent?.key === "SHOP-90");
    check("only test issues count as linked tests", story.linkedTests.length === 1 && story.linkedTests[0]?.key === "SHOP-120");
    check("a linked test's kind comes from its summary prefix", story.linkedTests[0]?.kind === "positive");
    check("comments are read as text", story.comments[0]?.text.includes("out of scope") ?? false);

    const byKey = await jira.searchStories({ text: "SHOP-101" });
    check("search by issue key", byKey.length === 1 && byKey[0]?.criteriaCount === 3);
    const searchJql = seen.filter((s) => s.path.startsWith("/rest/api/3/search/jql")).at(-1)?.path ?? "";
    check("a key search uses key = …", decodeURIComponent(searchJql).includes('key = "SHOP-101"') || decodeURIComponent(searchJql).includes("key = SHOP-101"));
    await jira.searchStories({ projectKey: "SHOP", text: 'code" OR project = "OTHER' });
    const escaped = decodeURIComponent(seen.filter((s) => s.path.startsWith("/rest/api/3/search/jql")).at(-1)?.path ?? "");
    check("free text cannot break out of the JQL string", !escaped.includes('project = "OTHER"'), escaped.slice(0, 160));
    check("the defect type falls back to Defect", (await jira.defectIssueType("SHOP")) === "Defect");
    check("the Test link type is found", await jira.linkTypeExists("Test"));

    // ---- automating it ----
    const ws = await db.workspace.create({
      data: { name: "Jira E2E", slug: `jira-e2e-${Date.now()}`, jiraProjectKey: "SHOP", bitbucketWorkspace: "acme", bitbucketRepo: "shop-web" },
    });
    const sprint = await jiraSprintFor(ws.id, "SHOP");
    const row = await upsertJiraStory(sprint.id, story);
    const again = await upsertJiraStory(sprint.id, story);
    check("re-importing refreshes the same story", again.id === row.id);
    const run = await db.run.create({
      data: { workspaceId: ws.id, sprintId: sprint.id, storyId: row.id, agent: "qe-pipeline", status: "running" },
    });
    await runPipeline({ runId: run.id, storyId: row.id });
    const full = await db.run.findUniqueOrThrow({
      where: { id: run.id },
      include: { stages: { orderBy: { order: "asc" } }, testCases: true, publications: true, assets: true },
    });
    check("the run reaches review", full.status === "needs_review", `${full.status} ${full.error ?? ""}`);
    check("the strategist ran as stage 3", full.stages[2]?.agent === "test-strategist" && full.stages[2]?.status === "passed");
    check("tests are proposed for every criterion", story.acceptanceCriteria.every((c) => full.testCases.some((t) => t.criterion === c)));
    check("no test duplicates the linked positive test for AC1",
      !full.testCases.some((t) => t.criterion === story.acceptanceCriteria[0] && /^\[Positive\]/.test(t.summary)),
      full.testCases.filter((t) => t.criterion === story.acceptanceCriteria[0]).map((t) => t.summary).join(" | "));
    check("new tests carry the team's [Positive]/[Negative]/[Edge] prefix", full.testCases.every((t) => /^\[(Positive|Negative|Edge)\]/.test(t.summary)));
    const xrayPub = full.publications.find((p) => p.target === "xray-tests");
    const xrayPayload = JSON.parse(xrayPub?.payloadJson ?? "{}");
    check("Xray tests go to the story's project", xrayPayload.projectKey === "SHOP", xrayPayload.projectKey);
    const reportPub = full.publications.find((p) => p.target === "jira-comment" && JSON.parse(p.payloadJson).kind === "report");
    check("the report is proposed as a Jira comment", Boolean(reportPub));
    check("nothing was written to Jira by the run", !seen.some((s) => s.method !== "GET" && s.path.startsWith("/rest/api/3/issue")));

    // ---- the report ----
    const report = await buildStoryReport(run.id);
    check("the report traces every criterion", report?.criteria.length === 3);
    check("the report lists the existing linked test", report?.existingTests.some((t) => t.key === "SHOP-120") ?? false);
    check("the report carries the scope change from comments", (report?.scopeNotes.length ?? 0) > 0);
    check("a High story's money criterion is P1", report?.criteria[0]?.priority === "P1", report?.criteria[0]?.priority);
    check("the linked test only counts for the criterion it covers",
      (report?.criteria[0]?.existingTests.includes("SHOP-120") ?? false) && !(report?.criteria[1]?.existingTests.includes("SHOP-120") ?? true));
    check("preconditions include the team's test notes, without stray punctuation",
      (report?.criteria[0]?.preconditions.some((x) => x.includes("signed-in shopper")) ?? false) &&
        (report?.criteria.every((c) => c.preconditions.every((x) => !/[,;]$/.test(x))) ?? false));
    check("each criterion has a priority and techniques", report?.criteria.every((c) => c.priority && c.techniques.length > 0) ?? false);
    const md = report ? reportMarkdown(report) : "";
    check("the Markdown report has a traceability table", md.includes("## Traceability") && md.includes("| 3 |"));
    check("the comment version is short", report ? reportAsComment(report).length < 4000 : false);

    // ---- publishing to Xray (what the approve button calls) ----
    const created = await xray.createTests(
      full.testCases.map((t) => ({
        summary: t.summary,
        testType: t.testType as "Manual",
        priority: t.priority,
        steps: JSON.parse(t.stepsJson),
        gherkin: t.gherkin,
        labels: JSON.parse(t.labelsJson),
        storyKey: "SHOP-101",
        projectKey: xrayPayload.projectKey,
      })),
      "Test"
    );
    check("every test is created in Xray", created.length === full.testCases.length && created.every((c) => /^SHOP-\d+$/.test(c.key)));
    check("every test is linked to the story", created.every((c) => c.linked));
    const link = seen.find((s) => s.method === "PUT");
    const linkBody = JSON.parse(link?.body ?? "{}");
    check("the link reads '<test> tests <story>'",
      linkBody.update?.issuelinks?.[0]?.add?.type?.name === "Test" && linkBody.update.issuelinks[0].add.outwardIssue?.key === "SHOP-101");
    const gql = JSON.parse(seen.find((s) => s.path === "/api/v2/graphql")?.body ?? "{}");
    check("manual tests are sent with their steps", (gql.variables?.steps?.length ?? 0) > 0);

    await db.workspace.delete({ where: { id: ws.id } }).catch(() => {});
  } finally {
    server.close();
    await db.$disconnect();
  }

  console.log(results.join("\n"));
  console.log(`\n${results.length - failures} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
