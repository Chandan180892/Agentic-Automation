import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/workspace";
import { db } from "@/lib/db";
import { Rail } from "@/components/rail";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireWorkspace();
  if (!ctx) redirect("/login");
  const { session, workspace } = ctx;

  const [agentCount, runnerCount, liveRuns, sprint] = await Promise.all([
    Promise.resolve(6),
    db.runner.count({ where: { workspaceId: workspace.id } }),
    db.run.count({ where: { workspaceId: workspace.id, status: "running" } }),
    db.sprint.findFirst({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
      select: { name: true },
    }),
  ]);

  return (
    <div className="mx-auto max-w-[1440px] p-3 md:p-5">
      <div className="grid min-h-[calc(100dvh-40px)] overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-lift)] lg:grid-cols-[238px_1fr]">
        <Rail
          workspaceName={workspace.name}
          user={{
            name: session.user?.name ?? "Signed in",
            email: session.user?.email ?? "",
            image: session.user?.image ?? null,
          }}
          counts={{
            sprint: sprint?.name ?? "none",
            agents: agentCount,
            runners: runnerCount,
            live: liveRuns,
          }}
        />
        <div className="flex min-w-0 flex-col bg-surface">{children}</div>
      </div>
    </div>
  );
}
