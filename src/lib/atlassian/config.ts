/**
 * Atlassian Cloud wiring. Credentials come from the environment; the per-workspace
 * coordinates (project keys, repo slug) live on the Workspace row.
 *
 * Every client degrades the same way: when its credentials are missing it reports
 * `configured: false` and the caller works from what Gantry already holds. Nothing
 * silently pretends a remote call happened.
 */

export const jiraConfig = () => ({
  baseUrl: (process.env.JIRA_BASE_URL ?? "").replace(/\/+$/, ""),
  email: process.env.JIRA_EMAIL ?? "",
  apiToken: process.env.JIRA_API_TOKEN ?? "",
});

export const xrayConfig = () => ({
  baseUrl: (process.env.XRAY_BASE_URL ?? "https://xray.cloud.getxray.app").replace(/\/+$/, ""),
  clientId: process.env.XRAY_CLIENT_ID ?? "",
  clientSecret: process.env.XRAY_CLIENT_SECRET ?? "",
});

export const bitbucketConfig = () => ({
  baseUrl: "https://api.bitbucket.org/2.0",
  username: process.env.BITBUCKET_USERNAME ?? "",
  appPassword: process.env.BITBUCKET_APP_PASSWORD ?? "",
});

export const jiraConfigured = () => {
  const c = jiraConfig();
  return Boolean(c.baseUrl && c.email && c.apiToken);
};
export const xrayConfigured = () => {
  const c = xrayConfig();
  return Boolean(c.clientId && c.clientSecret);
};
export const bitbucketConfigured = () => {
  const c = bitbucketConfig();
  return Boolean(c.username && c.appPassword);
};

export class IntegrationError extends Error {
  constructor(
    readonly system: "jira" | "xray" | "bitbucket",
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

/** Shared fetch with a timeout, so a hung Atlassian call cannot wedge a pipeline. */
export async function httpJson<T>(
  system: "jira" | "xray" | "bitbucket",
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 20_000, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...rest, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new IntegrationError(
        system,
        `${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ""}`,
        res.status
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  } catch (err) {
    if (err instanceof IntegrationError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new IntegrationError(system, `Request timed out after ${timeoutMs}ms`);
    }
    throw new IntegrationError(system, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

export const basicAuth = (user: string, secret: string) =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;
