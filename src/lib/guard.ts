import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import type { requireWorkspace, Role } from "@/lib/workspace";

type Ctx = NonNullable<Awaited<ReturnType<typeof requireWorkspace>>>;

/** A user-facing refusal. Server actions surface its message; it is never a crash. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

/**
 * Writing to Jira, Xray or Bitbucket, changing integrations and deciding what the agents learn
 * are admin decisions. Running agents is open to every member.
 */
export function assertRole(ctx: Ctx, allowed: Role[], what: string) {
  if (!allowed.includes(ctx.role)) {
    throw new ActionError(`Only a workspace ${allowed.join(" or ")} can ${what}. You are a ${ctx.role}.`);
  }
}

/** Records a decision a person made. Never fails the action it records. */
export async function audit(ctx: Ctx, action: string, target = "", detail: Record<string, unknown> = {}) {
  await db.auditLog
    .create({
      data: {
        workspaceId: ctx.workspace.id,
        actorId: ctx.session?.user?.id ?? "",
        actorEmail: ctx.session?.user?.email ?? "",
        action,
        target,
        detailJson: JSON.stringify(detail),
      },
    })
    .catch((err) => log.error("audit write failed", err, { action, target }));
}

/**
 * Agent-starting actions per workspace per minute, counted from the audit log — so the limit
 * holds across every server instance without a separate store.
 */
export async function rateLimit(ctx: Ctx, action: string) {
  const limit = env().ACTION_RATE_LIMIT_PER_MINUTE;
  if (limit <= 0) return;
  const recent = await db.auditLog.count({
    where: { workspaceId: ctx.workspace.id, action: { startsWith: "agent." }, at: { gte: new Date(Date.now() - 60_000) } },
  });
  if (recent >= limit) {
    throw new ActionError(`Too many agent runs started in the last minute (limit ${limit}). Wait a moment and try again.`);
  }
  await audit(ctx, `agent.${action}`);
}

/**
 * Wraps a server action so an ActionError reaches the person who clicked. Next.js hides thrown
 * messages in production, so instead of throwing, the action sends the browser back where it
 * came from with the message in `?notice=`, which the app shell shows. Anything else is a real
 * failure and still throws to the error boundary.
 */
export function action<A extends unknown[]>(fn: (...args: A) => Promise<void>) {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      if (!(err instanceof ActionError)) throw err;
      const { headers } = await import("next/headers");
      const { redirect } = await import("next/navigation");
      const h = await headers();
      let back = "/";
      try {
        const ref = new URL(h.get("referer") ?? "/", "http://local");
        ref.searchParams.set("notice", err.message);
        back = `${ref.pathname}${ref.search}`;
      } catch {
        back = `/?notice=${encodeURIComponent(err.message)}`;
      }
      redirect(back);
    }
  };
}
