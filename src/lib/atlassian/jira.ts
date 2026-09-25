import { jiraConfig, jiraConfigured, httpJson, basicAuth } from "./config";

/**
 * Jira Cloud, read and (approved) write.
 *
 * Jira sites differ: acceptance criteria may live in a custom field or in the description,
 * story points may be "Story Points" or "Story point estimate", Xray tests may be "Test" or
 * "Xray Test", defects "Bug" or "Defect". So fields are resolved by their display name from
 * the site's own field list, and issue types from the project's own create metadata —
 * never hard-coded ids.
 */

export interface LinkedTest {
  key: string;
  summary: string;
  status: string;
  issueType: string;
  /** From the team's [Positive] / [Negative] / [Edge] summary prefix, when present. */
  kind: string;
}

export interface JiraComment {
  author: string;
  created: string;
  text: string;
}

export interface JiraStory {
  key: string;
  id: string;
  url: string;
  summary: string;
  description: string;
  issueType: string;
  status: string;
  priority: string;
  storyPoints: number | null;
  acceptanceCriteria: string[];
  /** Manual test notes the team keeps on the story ("Test Criteria"), verbatim. */
  testCriteria: string;
  labels: string[];
  components: string[];
  fixVersions: string[];
  sprint: string;
  parent: { key: string; summary: string } | null;
  comments: JiraComment[];
  linkedTests: LinkedTest[];
  updated: string;
}

export interface JiraStorySummary {
  key: string;
  summary: string;
  status: string;
  priority: string;
  issueType: string;
  storyPoints: number | null;
  criteriaCount: number;
  linkedTests: number;
  updated: string;
  url: string;
}

// ------------------------------------------------------------ ADF → text --

/**
 * Atlassian Document Format to readable text that keeps the structure the criteria splitter
 * relies on: headings on their own line with "## ", list items with "- ", hard breaks as
 * newlines, mentions and links as their text.
 */
export function adfToText(node: unknown, depth = 0): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[]; attrs?: Record<string, unknown> };
  const kids = () => (Array.isArray(n.content) ? n.content.map((c) => adfToText(c, depth + 1)).join("") : "");
  switch (n.type) {
    case "text":
      return n.text ?? "";
    case "hardBreak":
      return "\n";
    case "mention":
      return String(n.attrs?.text ?? "");
    case "inlineCard":
    case "blockCard":
      return String(n.attrs?.url ?? "");
    case "heading":
      return `\n## ${kids().trim()}\n`;
    case "paragraph":
      return `${kids()}\n`;
    case "listItem":
      return `- ${kids().trim()}\n`;
    case "bulletList":
    case "orderedList":
      return `${kids()}\n`;
    case "codeBlock":
      return `\n${kids()}\n`;
    default:
      return kids();
  }
}

export function textOf(field: unknown): string {
  if (typeof field === "string") return field;
  if (field && typeof field === "object") return adfToText(field).replace(/\n{3,}/g, "\n\n").trim();
  return "";
}

const clean = (s: string) =>
  s
    .replace(/\*\*|__|\\(?=[*#_\-.])/g, "")
    .replace(/^#+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Splits acceptance-criteria text into one entry per criterion, keeping a criterion's
 * Given/When/Then lines together. Recognises, in order: "AC1 -" / "Scenario:" headed sections,
 * repeated Given blocks, list items, then plain lines.
 */
export function splitCriteria(text: string): string[] {
  const lines = text.split("\n").map((l) => l.trimEnd());
  const heading = /^\s*(#+\s*)?(\*\*)?\s*(AC\s*[-#]?\s*\d+|Acceptance criteri(on|a)\s*\d+|Scenario( Outline)?\s*[:\d-])/i;
  const sections = (starts: (l: string) => boolean) => {
    const out: string[][] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      if (starts(l) || out.length === 0) out.push([l]);
      else out[out.length - 1].push(l);
    }
    return out;
  };

  if (lines.filter((l) => heading.test(l)).length >= 1) {
    const secs = sections((l) => heading.test(l)).filter((sec) => heading.test(sec[0]));
    return secs.map((sec) => {
      const [h, ...body] = sec;
      const title = clean(h).replace(/[:\s]+$/, "");
      const rest = body.map(clean).filter(Boolean).join(" ");
      return rest ? `${title}: ${rest}` : title;
    });
  }
  const givens = lines.filter((l) => /^\s*[-*]?\s*(\*\*)?given\b/i.test(l));
  if (givens.length >= 2) {
    return sections((l) => /^\s*[-*]?\s*(\*\*)?given\b/i.test(l))
      .map((sec) => sec.map(clean).filter(Boolean).join(" "))
      .filter((c) => /given/i.test(c));
  }
  const items = lines.filter((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l));
  if (items.length >= 2) return items.map((l) => clean(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""))).filter((l) => l.length > 3);
  return lines.map(clean).filter((l) => l.length > 3);
}

/** Pulls an "Acceptance Criteria" section out of a description, for sites without the field. */
export function criteriaFromDescription(description: string): string[] {
  const m = description.match(/(?:^|\n)\s*(?:#+\s*)?(?:\*\*)?acceptance criteria(?:\*\*)?\s*:?\s*\n([\s\S]*?)(?=\n\s*(?:#+\s*)?(?:\*\*)?(?:notes?|out of scope|technical notes|design|test criteria)(?:\*\*)?\s*:?\s*\n|$)/i);
  return m ? splitCriteria(m[1]) : [];
}

// ---------------------------------------------------------------- fields --

interface FieldIds {
  acceptanceCriteria: string[];
  testCriteria: string[];
  storyPoints: string[];
  sprint: string[];
}

let fieldCache: { at: number; ids: FieldIds } | null = null;

/** Resolves the site's custom fields by display name. Cached for ten minutes. */
export async function fieldIds(): Promise<FieldIds> {
  if (fieldCache && Date.now() - fieldCache.at < 600_000) return fieldCache.ids;
  const fields = await httpJson<{ id: string; name: string }[]>("jira", `${jiraConfig().baseUrl}/rest/api/3/field`, {
    headers: headers(),
  });
  const pick = (...patterns: RegExp[]) =>
    patterns.flatMap((re) => fields.filter((f) => re.test(f.name)).map((f) => f.id)).filter((v, i, a) => a.indexOf(v) === i);
  const ids: FieldIds = {
    acceptanceCriteria: pick(/^acceptance criteria$/i, /acceptance criteri/i),
    testCriteria: pick(/^test criteria$/i, /^test notes$/i),
    storyPoints: pick(/^story points$/i, /^story point estimate$/i),
    sprint: pick(/^sprint$/i),
  };
  fieldCache = { at: Date.now(), ids };
  return ids;
}

/** For tests: forget the cached field ids. */
export function resetJiraCaches() {
  fieldCache = null;
  typeCache.clear();
}

function headers() {
  const c = jiraConfig();
  return { authorization: basicAuth(c.email, c.apiToken), accept: "application/json" };
}

const safeKey = (k: string) => k.replace(/[^A-Za-z0-9_-]/g, "");

type RawIssue = { id: string; key: string; fields: Record<string, unknown> };

const firstNumber = (f: Record<string, unknown>, ids: string[]) => {
  for (const id of ids) if (typeof f[id] === "number") return f[id] as number;
  return null;
};
const firstText = (f: Record<string, unknown>, ids: string[]) => {
  for (const id of ids) {
    const t = textOf(f[id]);
    if (t) return t;
  }
  return "";
};

const TEST_TYPE = /(^|\s)test$/i;

function linkedTestsOf(f: Record<string, unknown>): LinkedTest[] {
  const links = (f.issuelinks as { outwardIssue?: RawLinkIssue; inwardIssue?: RawLinkIssue }[] | undefined) ?? [];
  const out: LinkedTest[] = [];
  for (const l of links) {
    const other = l.outwardIssue ?? l.inwardIssue;
    const type = other?.fields?.issuetype?.name ?? "";
    if (!other || !TEST_TYPE.test(type)) continue;
    const summary = other.fields?.summary ?? "";
    out.push({
      key: other.key,
      summary,
      status: other.fields?.status?.name ?? "",
      issueType: type,
      kind: summary.match(/^\s*\[([A-Za-z -]+)\]/)?.[1]?.toLowerCase() ?? "",
    });
  }
  return out;
}
type RawLinkIssue = { key: string; fields?: { summary?: string; status?: { name?: string }; issuetype?: { name?: string } } };

function sprintName(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return "";
  const sprints = v as { name?: string; state?: string }[];
  return (sprints.find((s) => s.state === "active") ?? sprints[sprints.length - 1])?.name ?? "";
}

export function mapIssue(issue: RawIssue, ids: FieldIds): JiraStory {
  const f = issue.fields;
  const description = textOf(f.description);
  const acText = firstText(f, ids.acceptanceCriteria);
  const comments = ((f.comment as { comments?: { author?: { displayName?: string }; created?: string; body?: unknown }[] })?.comments ?? [])
    .slice(-8)
    .map((c) => ({ author: c.author?.displayName ?? "", created: c.created ?? "", text: textOf(c.body).slice(0, 1200) }))
    .filter((c) => c.text);
  const parent = f.parent as { key?: string; fields?: { summary?: string } } | undefined;
  return {
    key: issue.key,
    id: issue.id,
    url: `${jiraConfig().baseUrl}/browse/${issue.key}`,
    summary: textOf(f.summary),
    description,
    issueType: (f.issuetype as { name?: string })?.name ?? "Story",
    status: (f.status as { name?: string })?.name ?? "",
    priority: (f.priority as { name?: string })?.name ?? "",
    storyPoints: firstNumber(f, ids.storyPoints),
    acceptanceCriteria: acText ? splitCriteria(acText) : criteriaFromDescription(description),
    testCriteria: firstText(f, ids.testCriteria),
    labels: Array.isArray(f.labels) ? (f.labels as string[]) : [],
    components: ((f.components as { name?: string }[]) ?? []).map((c) => c.name ?? "").filter(Boolean),
    fixVersions: ((f.fixVersions as { name?: string }[]) ?? []).map((c) => c.name ?? "").filter(Boolean),
    sprint: ids.sprint.map((id) => sprintName(f[id])).find(Boolean) ?? "",
    parent: parent?.key ? { key: parent.key, summary: parent.fields?.summary ?? "" } : null,
    comments,
    linkedTests: linkedTestsOf(f),
    updated: String(f.updated ?? ""),
  };
}

const BASE_FIELDS = ["summary", "description", "issuetype", "status", "priority", "labels", "components", "fixVersions", "issuelinks", "parent", "updated"];

async function search(jql: string, fields: string[], limit: number): Promise<RawIssue[]> {
  const url = `${jiraConfig().baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(Math.max(limit, 1), 100)}&fields=${encodeURIComponent(fields.join(","))}`;
  const data = await httpJson<{ issues?: RawIssue[] }>("jira", url, { headers: headers() });
  return data.issues ?? [];
}

function requireJira() {
  if (!jiraConfigured()) throw new Error("Jira is not configured on this deployment (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN).");
}

/** Pulls a project's open stories, fully mapped. JQL is built from a sanitised key only. */
export async function fetchStories(projectKey: string, limit = 50): Promise<JiraStory[]> {
  requireJira();
  const key = projectKey.replace(/[^A-Za-z0-9_]/g, "");
  if (!key) throw new Error("A Jira project key is required.");
  const ids = await fieldIds();
  const jql = `project = "${key}" AND issuetype in (Story, Bug, Task) AND statusCategory != Done ORDER BY priority DESC, created ASC`;
  const issues = await search(jql, [...BASE_FIELDS, ...ids.acceptanceCriteria, ...ids.testCriteria, ...ids.storyPoints, ...ids.sprint], limit);
  return issues.map((i) => mapIssue(i, ids));
}

/**
 * Finds stories to automate: by issue key, by free text within a project, or the project's
 * open stories, most recently updated first. Every user input is escaped into a JQL string.
 */
export async function searchStories(opts: { projectKey?: string; text?: string; limit?: number }): Promise<JiraStorySummary[]> {
  requireJira();
  const ids = await fieldIds();
  const text = (opts.text ?? "").trim();
  const project = (opts.projectKey ?? "").replace(/[^A-Za-z0-9_]/g, "");
  const quote = (v: string) => `"${v.replace(/["\\]/g, " ").slice(0, 120)}"`;
  let jql: string;
  if (/^[A-Z][A-Z0-9_]*-\d+$/i.test(text)) jql = `key = ${safeKey(text).toUpperCase()}`;
  else {
    const parts = [
      project ? `project = ${quote(project)}` : "",
      "issuetype not in subTaskIssueTypes()",
      "issuetype not in (Epic)",
      text ? `text ~ ${quote(text)}` : "statusCategory != Done",
    ].filter(Boolean);
    jql = `${parts.join(" AND ")} ORDER BY updated DESC`;
  }
  const issues = await search(jql, [...BASE_FIELDS, ...ids.acceptanceCriteria, ...ids.storyPoints], opts.limit ?? 25);
  return issues.map((i) => {
    const m = mapIssue(i, ids);
    return {
      key: m.key,
      summary: m.summary,
      status: m.status,
      priority: m.priority,
      issueType: m.issueType,
      storyPoints: m.storyPoints,
      criteriaCount: m.acceptanceCriteria.length,
      linkedTests: m.linkedTests.length,
      updated: m.updated,
      url: m.url,
    };
  });
}

/** One story with everything the agents use: criteria, test notes, comments, linked tests. */
export async function fetchStory(issueKey: string): Promise<JiraStory> {
  requireJira();
  const ids = await fieldIds();
  const fields = [...BASE_FIELDS, "comment", ...ids.acceptanceCriteria, ...ids.testCriteria, ...ids.storyPoints, ...ids.sprint];
  const data = await httpJson<RawIssue>(
    "jira",
    `${jiraConfig().baseUrl}/rest/api/3/issue/${safeKey(issueKey)}?fields=${encodeURIComponent(fields.join(","))}`,
    { headers: headers() }
  );
  return mapIssue(data, ids);
}

// ----------------------------------------------------- site & project meta --

export async function myself(): Promise<{ accountId: string; displayName: string; emailAddress: string }> {
  requireJira();
  return httpJson("jira", `${jiraConfig().baseUrl}/rest/api/3/myself`, { headers: headers() });
}

const typeCache = new Map<string, { at: number; names: string[] }>();

/** The issue types a project can create — "Bug" or "Defect", "Test" or "Xray Test". */
export async function projectIssueTypes(projectKey: string): Promise<string[]> {
  requireJira();
  const key = safeKey(projectKey);
  const hit = typeCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.names;
  const data = await httpJson<{ issueTypes?: { name: string }[]; values?: { name: string }[] }>(
    "jira",
    `${jiraConfig().baseUrl}/rest/api/3/issue/createmeta/${key}/issuetypes?maxResults=100`,
    { headers: headers() }
  );
  const names = (data.issueTypes ?? data.values ?? []).map((t) => t.name);
  typeCache.set(key, { at: Date.now(), names });
  return names;
}

/** The project's defect type: "Bug" where it exists, otherwise "Defect". */
export async function defectIssueType(projectKey: string): Promise<string> {
  const names = await projectIssueTypes(projectKey);
  return names.find((n) => /^bug$/i.test(n)) ?? names.find((n) => /^defect$/i.test(n)) ?? "Bug";
}

export async function linkTypeExists(name: string): Promise<boolean> {
  requireJira();
  const data = await httpJson<{ issueLinkTypes?: { name: string }[] }>("jira", `${jiraConfig().baseUrl}/rest/api/3/issueLinkType`, {
    headers: headers(),
  });
  return (data.issueLinkTypes ?? []).some((t) => t.name.toLowerCase() === name.toLowerCase());
}

/**
 * Links `fromKey` to `toKey` with the named link type, in its outward direction — for the
 * Xray "Test" type that reads "<test> tests <story>", which is how Xray counts coverage.
 */
export async function linkOutward(fromKey: string, toKey: string, typeName: string): Promise<void> {
  requireJira();
  await httpJson("jira", `${jiraConfig().baseUrl}/rest/api/3/issue/${safeKey(fromKey)}`, {
    method: "PUT",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({ update: { issuelinks: [{ add: { type: { name: typeName }, outwardIssue: { key: safeKey(toKey) } } }] } }),
  });
}

/** Posts the clarify agent's open questions back onto the story, once approved. */
export async function addComment(issueKey: string, body: string): Promise<{ id: string }> {
  if (!jiraConfigured()) throw new Error("Jira is not configured on this deployment.");
  const safe = issueKey.replace(/[^A-Za-z0-9_-]/g, "");
  return httpJson<{ id: string }>(
    "jira",
    `${jiraConfig().baseUrl}/rest/api/3/issue/${safe}/comment`,
    {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: body.split("\n\n").map((para) => ({
            type: "paragraph",
            content: [{ type: "text", text: para }],
          })),
        },
      }),
    }
  );
}

/**
 * Files an application defect the autopilot found, once a person approves it, and links it to
 * the story whose acceptance criterion it breaks. The link is best-effort: a site without the
 * "Relates" link type still gets the bug.
 */
export async function createBug(opts: {
  projectKey: string;
  storyKey: string;
  summary: string;
  description: string;
  labels?: string[];
}): Promise<{ id: string; key: string; linked: boolean }> {
  if (!jiraConfigured()) throw new Error("Jira is not configured on this deployment.");
  const base = jiraConfig().baseUrl;
  const created = await httpJson<{ id: string; key: string }>("jira", `${base}/rest/api/3/issue`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({
      fields: {
        project: { key: opts.projectKey },
        issuetype: { name: await defectIssueType(opts.projectKey) },
        summary: opts.summary.slice(0, 250),
        labels: opts.labels ?? ["autopilot"],
        description: {
          type: "doc",
          version: 1,
          content: opts.description.split("\n\n").map((para) => ({
            type: "paragraph",
            content: [{ type: "text", text: para }],
          })),
        },
      },
    }),
  });

  let linked = false;
  if (opts.storyKey) {
    try {
      await httpJson("jira", `${base}/rest/api/3/issueLink`, {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: JSON.stringify({
          type: { name: "Relates" },
          inwardIssue: { key: created.key },
          outwardIssue: { key: opts.storyKey.replace(/[^A-Za-z0-9_-]/g, "") },
        }),
      });
      linked = true;
    } catch {
      /* the bug exists either way; the caller reports linked: false */
    }
  }
  return { ...created, linked };
}
