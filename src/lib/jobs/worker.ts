import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { claim, finish, prune, renewLease, sweep, type JobRow } from "./queue";
import { HANDLERS } from "./handlers";

/**
 * The job worker. It runs inside the web server by default (WORKER_MODE=inline) or as its own
 * process (`npm run worker`) — the queue is the same either way, and any number of workers can
 * share it.
 */
export interface Worker {
  id: string;
  stop(graceMs?: number): Promise<void>;
  /** Jobs this worker is running right now. */
  active(): number;
}

const SWEEP_EVERY_MS = 30_000;
const PRUNE_EVERY_MS = 60 * 60_000;
const BEAT_EVERY_MS = 10_000;

export function startWorker(opts: { concurrency?: number; leaseMs?: number; pollMs?: number } = {}): Worker {
  const cfg = env();
  const concurrency = Math.max(1, opts.concurrency ?? cfg.WORKER_CONCURRENCY);
  const leaseMs = opts.leaseMs ?? cfg.JOB_LEASE_MS;
  const pollMs = opts.pollMs ?? 1000;
  const id = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;

  const running = new Map<string, Promise<void>>();
  let stopping = false;
  let lastSweep = 0;
  let lastPrune = 0;
  let lastBeat = 0;

  const execute = async (job: JobRow) => {
    const renew = setInterval(() => {
      renewLease(job.id, id, leaseMs).catch((err) => log.warn("lease renewal failed", { job: job.id, error: String(err) }));
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    const started = Date.now();
    log.info("job started", { job: job.id, kind: job.kind, attempt: job.attempts, worker: id });
    try {
      const handler = HANDLERS[job.kind];
      const res = handler ? await handler(job) : { ok: false as const, error: `No handler for job kind ${job.kind}` };
      await finish(job.id, id, res);
      log.info("job finished", { job: job.id, kind: job.kind, ok: res.ok, ms: Date.now() - started, ...(res.ok ? {} : { error: res.error }) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("job crashed", err, { job: job.id, kind: job.kind });
      await finish(job.id, id, { ok: false, error: msg }).catch(() => {});
    } finally {
      clearInterval(renew);
    }
  };

  const tick = async () => {
    const now = Date.now();
    if (now - lastBeat > BEAT_EVERY_MS) {
      lastBeat = now;
      await db.workerHeartbeat.upsert({
        where: { id },
        create: { id, running: running.size },
        update: { beatAt: new Date(), running: running.size },
      });
    }
    if (now - lastSweep > SWEEP_EVERY_MS) {
      lastSweep = now;
      const r = await sweep();
      if (r.interrupted || r.stale) log.warn("sweep recovered runs", r);
    }
    if (now - lastPrune > PRUNE_EVERY_MS) {
      lastPrune = now;
      const r = await prune(cfg.EVENT_RETENTION_DAYS);
      if (r.events || r.jobs) log.info("pruned old data", r);
    }
    while (!stopping && running.size < concurrency) {
      const job = await claim(id, leaseMs);
      if (!job) break;
      const p = execute(job).finally(() => running.delete(job.id));
      running.set(job.id, p);
    }
  };

  let timer: NodeJS.Timeout | null = null;
  const loop = async () => {
    try {
      await tick();
    } catch (err) {
      log.error("worker poll failed", err, { worker: id });
    }
    if (!stopping) timer = setTimeout(loop, pollMs);
  };
  void loop();
  log.info("worker started", { worker: id, concurrency, leaseMs });

  return {
    id,
    active: () => running.size,
    async stop(graceMs = 25_000) {
      stopping = true;
      if (timer) clearTimeout(timer);
      if (running.size) {
        log.info("worker draining", { worker: id, running: running.size });
        await Promise.race([Promise.allSettled(running.values()), new Promise((r) => setTimeout(r, graceMs))]);
      }
      await db.workerHeartbeat.delete({ where: { id } }).catch(() => {});
      // Anything still running keeps its lease until it expires; the next sweep fails it cleanly.
      log.info("worker stopped", { worker: id, abandoned: running.size });
    },
  };
}
