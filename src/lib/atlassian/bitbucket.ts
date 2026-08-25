import { bitbucketConfig, bitbucketConfigured, httpJson, basicAuth } from "./config";

export interface RepoFile {
  path: string;
  content: string;
}

function headers() {
  const c = bitbucketConfig();
  return { authorization: basicAuth(c.username, c.appPassword), accept: "application/json" };
}

const repoPath = (workspace: string, repo: string) =>
  `${bitbucketConfig().baseUrl}/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repo)}`;

/** Lists source paths on a branch, so asset-resolver can see what already exists. */
export async function listFiles(
  workspace: string,
  repo: string,
  branch: string,
  prefix = "",
  limit = 300
): Promise<string[]> {
  if (!bitbucketConfigured()) throw new Error("Bitbucket is not configured on this deployment.");
  const url = `${repoPath(workspace, repo)}/src/${encodeURIComponent(branch)}/${prefix}?max_depth=6&pagelen=100&fields=values.path,values.type,next`;

  const paths: string[] = [];
  let next: string | undefined = url;
  while (next && paths.length < limit) {
    const page: { values?: { path: string; type: string }[]; next?: string } = await httpJson(
      "bitbucket",
      next,
      { headers: headers() }
    );
    for (const v of page.values ?? []) {
      if (v.type === "commit_file") paths.push(v.path);
    }
    next = page.next;
  }
  return paths.slice(0, limit);
}

export async function readFile(
  workspace: string,
  repo: string,
  branch: string,
  path: string
): Promise<string> {
  if (!bitbucketConfigured()) throw new Error("Bitbucket is not configured on this deployment.");
  const res = await fetch(`${repoPath(workspace, repo)}/src/${encodeURIComponent(branch)}/${path}`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`Could not read ${path}: ${res.status}`);
  return res.text();
}

export async function branchExists(workspace: string, repo: string, branch: string) {
  try {
    await httpJson("bitbucket", `${repoPath(workspace, repo)}/refs/branches/${encodeURIComponent(branch)}`, {
      headers: headers(),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Commits the generated files onto a new branch. Bitbucket's /src endpoint creates the
 * branch and the commit in one form post, which keeps this atomic from our side.
 */
export async function commitFiles(opts: {
  workspace: string;
  repo: string;
  branch: string;
  fromBranch: string;
  message: string;
  files: RepoFile[];
}): Promise<{ branch: string; commitUrl: string }> {
  if (!bitbucketConfigured()) throw new Error("Bitbucket is not configured on this deployment.");
  const form = new FormData();
  form.append("branch", opts.branch);
  form.append("parents", opts.fromBranch);
  form.append("message", opts.message);
  for (const f of opts.files) form.append(f.path, f.content);

  const res = await fetch(`${repoPath(opts.workspace, opts.repo)}/src`, {
    method: "POST",
    headers: { authorization: headers().authorization },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Bitbucket rejected the commit: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
  return {
    branch: opts.branch,
    commitUrl: `https://bitbucket.org/${opts.workspace}/${opts.repo}/branch/${opts.branch}`,
  };
}

export async function createPullRequest(opts: {
  workspace: string;
  repo: string;
  title: string;
  description: string;
  sourceBranch: string;
  destinationBranch: string;
}): Promise<{ id: number; url: string }> {
  if (!bitbucketConfigured()) throw new Error("Bitbucket is not configured on this deployment.");
  const pr = await httpJson<{ id: number; links: { html: { href: string } } }>(
    "bitbucket",
    `${repoPath(opts.workspace, opts.repo)}/pullrequests`,
    {
      method: "POST",
      headers: { ...headers(), "content-type": "application/json" },
      body: JSON.stringify({
        title: opts.title,
        description: opts.description,
        source: { branch: { name: opts.sourceBranch } },
        destination: { branch: { name: opts.destinationBranch } },
        close_source_branch: true,
      }),
    }
  );
  return { id: pr.id, url: pr.links.html.href };
}
