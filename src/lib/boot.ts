import { env, checkProductionEnv } from "@/lib/env";
import { log } from "@/lib/log";
import type { Worker } from "@/lib/jobs/worker";

const g = globalThis as unknown as { __autopilotBooted?: boolean; __autopilotWorker?: Worker };

/**
 * Runs once per server process: validates the environment (refusing to start on an unsafe
 * production config), then starts the inline job worker unless WORKER_MODE=off.
 */
export async function bootServer() {
  if (g.__autopilotBooted) return;
  g.__autopilotBooted = true;

  const cfg = env();
  for (const w of checkProductionEnv()) log.warn(w);

  if (cfg.WORKER_MODE === "inline") {
    const { startWorker } = await import("@/lib/jobs/worker");
    g.__autopilotWorker = startWorker();
    const shutdown = async (signal: string) => {
      log.info("shutting down", { signal });
      await g.__autopilotWorker?.stop();
      process.exit(0);
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
  } else {
    log.info("inline worker disabled (WORKER_MODE=off); run `npm run worker` alongside the web server");
  }
}
