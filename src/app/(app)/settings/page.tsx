import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { PageBar, Pane } from "@/components/page-bar";
import { Card, CardHeader, CardBody, Pill, Label, Sub, Button } from "@/components/ui";
import { agentsAreLive } from "@/lib/agents/runtime";
import { enabledProviders } from "@/auth";
import { jiraConfigured, xrayConfigured, bitbucketConfigured } from "@/lib/atlassian/config";
import { saveIntegrations } from "../actions";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

function Row({ label, value, tone }: { label: string; value: string; tone: "pass" | "heal" | "idle" }) {
  return (
    <div className="flex items-center gap-3 border-b border-line-soft py-2.5 last:border-b-0">
      <span className="font-mono text-[12px] text-ink-2">{label}</span>
      <Pill tone={tone} className="ml-auto">{value}</Pill>
    </div>
  );
}

const field =
  "rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[12.5px] outline-none focus:border-accent-line";

export default async function SettingsPage() {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace, session } = ctx;

  const [members, runs] = await Promise.all([
    db.membership.count({ where: { workspaceId: workspace.id } }),
    db.run.count({ where: { workspaceId: workspace.id } }),
  ]);

  return (
    <>
      <PageBar crumb={`${workspace.slug} / settings`} title="Settings" />
      <Pane>
        <div className="grid items-start gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader title="Atlassian wiring">
              <Pill tone={jiraConfigured() && bitbucketConfigured() ? "pass" : "heal"}>
                {jiraConfigured() && bitbucketConfigured() ? "connected" : "incomplete"}
              </Pill>
            </CardHeader>
            <CardBody>
              <form action={saveIntegrations} className="grid gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-1.5">
                    <Label>Jira project key</Label>
                    <input name="jiraProjectKey" defaultValue={workspace.jiraProjectKey} placeholder="PAY" className={field} />
                  </label>
                  <label className="grid gap-1.5">
                    <Label>Xray project key</Label>
                    <input name="xrayProjectKey" defaultValue={workspace.xrayProjectKey} placeholder="PAY" className={field} />
                  </label>
                  <label className="grid gap-1.5">
                    <Label>Bitbucket workspace</Label>
                    <input name="bitbucketWorkspace" defaultValue={workspace.bitbucketWorkspace} placeholder="acme" className={field} />
                  </label>
                  <label className="grid gap-1.5">
                    <Label>Bitbucket repository</Label>
                    <input name="bitbucketRepo" defaultValue={workspace.bitbucketRepo} placeholder="payments-web" className={field} />
                  </label>
                  <label className="grid gap-1.5">
                    <Label>Default branch</Label>
                    <input name="defaultBranch" defaultValue={workspace.defaultBranch} className={field} />
                  </label>
                  <label className="grid gap-1.5">
                    <Label>Test framework</Label>
                    <input name="testFramework" defaultValue={workspace.testFramework} className={field} />
                  </label>
                </div>
                <Button type="submit" variant="primary" className="justify-center">Save</Button>
                <Sub>
                  These are coordinates, not credentials. The API tokens live in environment
                  variables so nothing secret is stored in the database.
                </Sub>
              </form>
            </CardBody>
          </Card>

          <div className="grid gap-4">
            <Card>
              <CardHeader title="Credentials">
                <Pill tone={agentsAreLive() ? "pass" : "heal"}>
                  {agentsAreLive() ? "agents live" : "simulator mode"}
                </Pill>
              </CardHeader>
              <CardBody>
                <Row label="ANTHROPIC_API_KEY" value={agentsAreLive() ? "set" : "not set"} tone={agentsAreLive() ? "pass" : "heal"} />
                <Row label="ANTHROPIC_MODEL" value={process.env.ANTHROPIC_MODEL || "claude-sonnet-5"} tone="idle" />
                <Row label="JIRA_BASE_URL / EMAIL / API_TOKEN" value={jiraConfigured() ? "set" : "not set"} tone={jiraConfigured() ? "pass" : "heal"} />
                <Row label="XRAY_CLIENT_ID / SECRET" value={xrayConfigured() ? "set" : "not set"} tone={xrayConfigured() ? "pass" : "heal"} />
                <Row label="BITBUCKET_USERNAME / APP_PASSWORD" value={bitbucketConfigured() ? "set" : "not set"} tone={bitbucketConfigured() ? "pass" : "heal"} />
                <Row label="Google OAuth" value={enabledProviders.google ? "configured" : "not configured"} tone={enabledProviders.google ? "pass" : "heal"} />
                <Row label="GitHub OAuth" value={enabledProviders.github ? "configured" : "not configured"} tone={enabledProviders.github ? "pass" : "heal"} />
                <Row label="Database" value={process.env.DATABASE_URL?.startsWith("file:") ? "sqlite" : "postgres"} tone="idle" />
                <Sub className="mt-3">
                  Anything not set degrades rather than breaks: the pipeline still runs, and each
                  stage says in its log which system it could not reach.
                </Sub>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Workspace" />
              <CardBody className="grid gap-2.5">
                <div className="grid gap-1.5">
                  <Label>Name</Label>
                  <div className="text-[13.5px] font-semibold">{workspace.name}</div>
                </div>
                <div className="grid gap-1.5">
                  <Label>Signed in as</Label>
                  <div className="text-[12.5px] text-ink-2">{session.user?.email ?? session.user?.name}</div>
                </div>
                <div className="flex gap-5 font-mono text-[12px] text-muted">
                  <span>{members} member{members === 1 ? "" : "s"}</span>
                  <span>{runs} run{runs === 1 ? "" : "s"}</span>
                </div>
              </CardBody>
            </Card>
          </div>
        </div>
      </Pane>
    </>
  );
}
