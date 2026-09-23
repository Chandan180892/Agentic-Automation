/**
 * Standalone job worker: `npm run worker`. Use it with WORKER_MODE=off on the web server to scale
 * agent work separately from web traffic. Any number can run against the same database.
 */
import { env, checkProductionEnv } from "../src/lib/env";
import { log } from "../src/lib/log";
import { startWorker } from "../src/lib/jobs/worker";

env();
for (const w of checkProductionEnv()) log.warn(w);
const worker = startWorker();
const stop = async (signal: string) => {
  log.info("shutting down", { signal });
  await worker.stop();
  process.exit(0);
};
process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));
