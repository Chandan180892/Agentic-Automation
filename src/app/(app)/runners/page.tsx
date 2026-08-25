import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireWorkspace } from "@/lib/workspace";
import { relTime } from "@/lib/utils";
import { PageBar, Pane } from "@/components/page-bar";
import { Card, CardHeader, CardBody, Pill, Label, Sub, Meter, Button, Empty } from "@/components/ui";
import { createRunner, deleteRunner } from "../actions";
import { TokenReveal } from "./token-reveal";

export const metadata: Metadata = { title: "Runners" };
export const dynamic = "force-dynamic";

/** A runner that has not checked in for two minutes is treated as offline. */
const STALE_MS = 120_000;

export default async function RunnersPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; name?: string }>;
}) {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { workspace } = ctx;
  const { token, name } = await searchParams;

  const [runners, queued, live] = await Promise.all([
    db.runner.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "asc" } }),
    db.job.findMany({
      where: { status: "queued", run: { workspaceId: workspace.id } },
      orderBy: { createdAt: "asc" },
      take: 12,
      include: { story: { select: { key: true, title: true } } },
    }),
    db.run.count({ where: { workspaceId: workspace.id, status: "running" } }),
  ]);

  const withState = runners.map((r) => {
    const stale = !r.lastSeenAt || Date.now() - r.lastSeenAt.getTime() > STALE_MS;
    const status = stale ? "offline" : r.activeJobs > 0 ? "busy" : "online";
    return { ...r, live: status };
  });
  const up = withState.filter((r) => r.live !== "offline").length;

  return (
    <>
      <PageBar crumb={`${workspace.slug} / runners`} title="Runners" live={live} />
      <Pane>
        {token && <TokenReveal token={token} name={name ?? "runner"} />}

        <div className="grid items-start gap-4 xl:grid-cols-[1fr_372px]">
          <Card>
            <CardHeader title="Connected runners">
              <Pill tone={up ? "pass" : "idle"}>{up} up</Pill>
            </CardHeader>
            {withState.length === 0 ? (
              <Empty title="No runners registered">
                Gantry runs nothing on its own machines. Register a runner, then start it on any box you
                control — a CI worker, a bare-metal rack, or the laptop in front of you.
              </Empty>
            ) : (
              <ul>
                {withState.map((r) => {
                  const use = r.slots ? Math.round((r.activeJobs / r.slots) * 100) : 0;
                  const tone = r.live === "busy" ? "live" : r.live === "online" ? "pass" : "idle";
                  return (
                    <li
                      key={r.id}
                      className="grid grid-cols-[auto_1fr_auto] items-center gap-3.5 border-b border-line-soft px-4 py-3.5 last:border-b-0 md:grid-cols-[auto_1fr_auto_auto]"
                    >
                      <span
                        className={`relative size-2.5 shrink-0 rounded-full ${
                          r.live === "busy" ? "bg-live text-live beat" : r.live === "online" ? "bg-pass text-pass beat" : "bg-muted"
                        }`}
                      />
                      <div className="min-w-0">
                        <div className="font-mono text-[12.5px] font-semibold">{r.name}</div>
                        <div className="mt-0.5 text-[11.5px] text-muted">
                          {r.location || (r.kind === "local" ? "Local machine" : "Cloud")} · {r.kind}
                          {r.version && ` · ${r.version}`} · seen {relTime(r.lastSeenAt)}
                        </div>
                      </div>
                      <div className="hidden w-24 md:block">
                        <div className="mb-1 flex justify-between font-mono text-[11px] text-muted">
                          <span>
                            {r.activeJobs} / {r.slots}
                          </span>
                          <span>{use}%</span>
                        </div>
                        <Meter value={use} tone={r.live === "busy" ? "live" : "pass"} />
                      </div>
                      <div className="flex items-center gap-2">
                        <Pill tone={tone}>{r.live === "busy" ? "running" : r.live}</Pill>
                        <span className="hidden font-mono text-[11px] text-muted sm:inline">…{r.tokenHint}</span>
                        <form action={deleteRunner.bind(null, r.id)}>
                          <Button type="submit" size="sm" variant="ghost" aria-label={`Revoke ${r.name}`}>
                            Revoke
                          </Button>
                        </form>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <div className="grid gap-4">
            <Card>
              <CardHeader title="Register a machine" />
              <CardBody>
                <form action={createRunner} className="grid gap-3">
                  <label className="grid gap-1.5">
                    <Label>Name</Label>
                    <input
                      name="name"
                      required
                      placeholder="my-laptop"
                      className="rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[12.5px] outline-none focus:border-accent-line"
                    />
                  </label>
                  <label className="grid gap-1.5">
                    <Label>Where it lives</Label>
                    <input
                      name="location"
                      placeholder="AWS us-east-1, or under my desk"
                      className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent-line"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="grid gap-1.5">
                      <Label>Kind</Label>
                      <select
                        name="kind"
                        className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent-line"
                      >
                        <option value="cloud">Cloud</option>
                        <option value="local">Local</option>
                      </select>
                    </label>
                    <label className="grid gap-1.5">
                      <Label>Slots</Label>
                      <input
                        name="slots"
                        type="number"
                        min={1}
                        max={16}
                        defaultValue={2}
                        className="rounded-lg border border-line bg-surface px-2.5 py-1.5 font-mono text-[12.5px] outline-none focus:border-accent-line"
                      />
                    </label>
                  </div>
                  <Button type="submit" variant="primary" className="justify-center">
                    Create token
                  </Button>
                  <Sub>
                    The token is shown once, here, and stored only as a hash. Revoking a runner
                    invalidates it immediately.
                  </Sub>
                </form>
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="Queue">
                <Pill tone={queued.length ? "heal" : "idle"}>{queued.length} waiting</Pill>
              </CardHeader>
              <CardBody className="grid gap-2">
                {queued.length === 0 ? (
                  <Sub>Nothing waiting. Queued jobs appear here until a runner claims them.</Sub>
                ) : (
                  queued.map((j) => (
                    <div
                      key={j.id}
                      className="flex items-center gap-2.5 rounded-lg border border-line-soft bg-surface-2 px-3 py-2"
                    >
                      <svg viewBox="0 0 24 24" className="size-[15px] shrink-0 fill-none stroke-muted stroke-[1.7]" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3v18M5 8l7-5 7 5" />
                      </svg>
                      <span className="truncate font-mono text-[11.5px] font-medium">
                        {j.story?.key ?? j.kind} · {j.kind}
                      </span>
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">
                        {relTime(j.createdAt)}
                      </span>
                    </div>
                  ))
                )}
              </CardBody>
            </Card>
          </div>
        </div>
      </Pane>
    </>
  );
}
