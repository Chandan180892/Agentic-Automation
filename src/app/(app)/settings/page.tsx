import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { PageBar, Pane } from "@/components/page-bar";
import { Card, CardHeader, CardBody, Pill, Label, Sub } from "@/components/ui";
import { agentsAreLive } from "@/lib/agents/runtime";
import { enabledProviders } from "@/auth";

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

export default async function SettingsPage() {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace, session } = ctx;

  const [members, runners, runs] = await Promise.all([
    db.membership.count({ where: { workspaceId: workspace.id } }),
    db.runner.count({ where: { workspaceId: workspace.id } }),
    db.run.count({ where: { workspaceId: workspace.id } }),
  ]);

  return (
    <>
      <PageBar crumb={`${workspace.slug} / settings`} title="Settings" />
      <Pane>
        <div className="grid items-start gap-4 xl:grid-cols-2">
          <Card>
            <CardHeader title="Workspace" />
            <CardBody className="grid gap-2.5">
              <div className="grid gap-1.5">
                <Label>Name</Label>
                <div className="text-[13.5px] font-semibold">{workspace.name}</div>
              </div>
              <div className="grid gap-1.5">
                <Label>Slug</Label>
                <div className="font-mono text-[12.5px] text-ink-2">{workspace.slug}</div>
              </div>
              <div className="grid gap-1.5">
                <Label>Signed in as</Label>
                <div className="text-[12.5px] text-ink-2">{session.user?.email ?? session.user?.name}</div>
              </div>
              <hr className="my-1 border-line-soft" />
              <div className="flex gap-5 font-mono text-[12px] text-muted">
                <span>{members} member{members === 1 ? "" : "s"}</span>
                <span>{runners} runner{runners === 1 ? "" : "s"}</span>
                <span>{runs} run{runs === 1 ? "" : "s"}</span>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Configuration">
              <Pill tone={agentsAreLive() ? "pass" : "heal"}>
                {agentsAreLive() ? "agents live" : "simulator mode"}
              </Pill>
            </CardHeader>
            <CardBody>
              <Row
                label="ANTHROPIC_API_KEY"
                value={agentsAreLive() ? "set" : "not set"}
                tone={agentsAreLive() ? "pass" : "heal"}
              />
              <Row label="ANTHROPIC_MODEL" value={process.env.ANTHROPIC_MODEL || "claude-sonnet-5"} tone="idle" />
              <Row
                label="Google OAuth"
                value={enabledProviders.google ? "configured" : "not configured"}
                tone={enabledProviders.google ? "pass" : "heal"}
              />
              <Row
                label="GitHub OAuth"
                value={enabledProviders.github ? "configured" : "not configured"}
                tone={enabledProviders.github ? "pass" : "heal"}
              />
              <Row label="Database" value={process.env.DATABASE_URL?.startsWith("file:") ? "sqlite" : "postgres"} tone="idle" />
              <Sub className="mt-3">
                These come from environment variables, so they change with a redeploy rather than in the
                UI — nothing secret is stored in the database. See <code className="font-mono">.env.example</code>.
              </Sub>
            </CardBody>
          </Card>
        </div>
      </Pane>
    </>
  );
}
