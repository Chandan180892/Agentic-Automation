import { jiraConfig, jiraConfigured, httpJson, basicAuth } from "./config";

export interface JiraStory {
  key: string;
  id: string;
  url: string;
  summary: string;
  description: string;
  issueType: string;
  storyPoints: number | null;
  acceptanceCriteria: string[];
  labels: string[];
  status: string;
}

/** Atlassian Document Format comes back as a node tree; we only need the readable text. */
function adfToText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text" && typeof n.text === "string") return n.text;
  const inner = Array.isArray(n.content) ? n.content.map(adfToText).join("") : "";
  const breaks = ["paragraph", "heading", "listItem", "bulletList", "orderedList"];
  return breaks.includes(n.type ?? "") ? `${inner}\n` : inner;
}

function textOf(field: unknown): string {
  if (typeof field === "string") return field;
  if (field && typeof field === "object") return adfToText(field).trim();
  return "";
}

/**
 * Acceptance criteria have no standard field in Jira. Teams use a custom field or a
 * headed section in the description, so we try the common custom fields first and fall
 * back to parsing the description rather than declaring there are none.
 */
function extractCriteria(fields: Record<string, unknown>, description: string): string[] {
  for (const [key, value] of Object.entries(fields)) {
    if (!key.startsWith("customfield_")) continue;
    const text = textOf(value);
    if (!text) continue;
    const lines = text
      .split("\n")
      .map((l) => l.replace(/^\s*[-*•]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim())
      .filter(Boolean);
    if (lines.length >= 2 && /given|when|then|should|must/i.test(text)) return lines;
  }

  const match = description.match(
    /(?:acceptance criteria|ac)\s*[:\n]([\s\S]*?)(?:\n\s*\n[A-Z][a-z]+\s*:|$)/i
  );
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter((l) => l.length > 3);
}

function headers() {
  const c = jiraConfig();
  return { authorization: basicAuth(c.email, c.apiToken), accept: "application/json" };
}

function mapIssue(issue: {
  id: string;
  key: string;
  fields: Record<string, unknown>;
}): JiraStory {
  const f = issue.fields;
  const description = textOf(f.description);
  const points = Object.entries(f).find(
    ([k, v]) => k.startsWith("customfield_") && typeof v === "number"
  )?.[1];
  return {
    key: issue.key,
    id: issue.id,
    url: `${jiraConfig().baseUrl}/browse/${issue.key}`,
    summary: textOf(f.summary),
    description,
    issueType: (f.issuetype as { name?: string })?.name ?? "Story",
    storyPoints: typeof points === "number" ? points : null,
    acceptanceCriteria: extractCriteria(f, description),
    labels: Array.isArray(f.labels) ? (f.labels as string[]) : [],
    status: (f.status as { name?: string })?.name ?? "",
  };
}

/** Pulls a project's open stories. JQL is escaped so a project key cannot inject clauses. */
export async function fetchStories(projectKey: string, limit = 50): Promise<JiraStory[]> {
  if (!jiraConfigured()) throw new Error("Jira is not configured on this deployment.");
  const safeKey = projectKey.replace(/[^A-Za-z0-9_]/g, "");
  if (!safeKey) throw new Error("A Jira project key is required.");

  const jql = `project = "${safeKey}" AND issuetype in (Story, Bug, Task) AND statusCategory != Done ORDER BY priority DESC, created ASC`;
  const url = `${jiraConfig().baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(limit, 100)}&fields=summary,description,issuetype,labels,status,customfield_10016,*navigable`;

  const data = await httpJson<{ issues?: { id: string; key: string; fields: Record<string, unknown> }[] }>(
    "jira",
    url,
    { headers: headers() }
  );
  return (data.issues ?? []).map(mapIssue);
}

export async function fetchStory(issueKey: string): Promise<JiraStory> {
  if (!jiraConfigured()) throw new Error("Jira is not configured on this deployment.");
  const safe = issueKey.replace(/[^A-Za-z0-9_-]/g, "");
  const data = await httpJson<{ id: string; key: string; fields: Record<string, unknown> }>(
    "jira",
    `${jiraConfig().baseUrl}/rest/api/3/issue/${safe}`,
    { headers: headers() }
  );
  return mapIssue(data);
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
