/**
 * Next.js calls register() once when a server instance starts, and onRequestError() for every
 * uncaught error in a route, action or render — so each one is logged with where it happened.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { bootServer } = await import("./lib/boot");
  await bootServer();
}

export async function onRequestError(
  err: unknown,
  request: { path: string; method: string },
  context: { routerKind: string; routePath: string; routeType: string }
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { log } = await import("./lib/log");
  log.error("request failed", err, {
    method: request.method,
    path: request.path,
    route: context.routePath,
    type: context.routeType,
    digest: (err as { digest?: string } | null)?.digest,
  });
}
