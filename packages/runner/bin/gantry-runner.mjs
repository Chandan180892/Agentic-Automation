#!/usr/bin/env node
/**
 * Gantry runner.
 *
 * Dials OUT to Gantry over HTTPS and claims jobs for its workspace. Nothing listens on this
 * machine: no inbound port, no VPN, no SSH key held by the server. Works identically on a
 * cloud CI worker and on a laptop behind NAT.
 *
 *   npx @gantry/runner connect --url https://gantry.example.com --token gnt_rnr_… --name my-laptop
 */

import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve, normalize } from "node:path";
import { hostname, platform, arch } from "node:os";

const VERSION = "1.0.0";

// ------------------------------------------------------------------- args --

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "connect";

const URL_BASE = (args.url || process.env.GANTRY_URL || "").replace(/\/+$/, "");
const TOKEN = args.token || process.env.GANTRY_TOKEN || "";
const NAME = args.name || process.env.GANTRY_RUNNER_NAME || hostname();
const SLOTS = Math.max(1, Math.min(16, Number(args.slots ?? process.env.GANTRY_SLOTS ?? 2)));
const WORKDIR = resolve(args.workdir || process.env.GANTRY_WORKDIR || process.cwd());
const EXEC = args.exec || process.env.GANTRY_EXEC || "";
const ONCE = Boolean(args.once);
const POLL_MS = Math.max(1000, Number(args["poll-ms"] ?? 3000));
const HEARTBEAT_MS = 20_000;

// ------------------------------------------------------------------- log ---

const C = process.stdout.isTTY
  ? { dim: "\x1b[2m", ok: "\x1b[32m", err: "\x1b[31m", warn: "\x1b[33m", acc: "\x1b[36m", off: "\x1b[0m", b: "\x1b[1m" }
  : { dim: "", ok: "", err: "", warn: "", acc: "", off: "", b: "" };

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`${C.dim}${stamp()}${C.off} ${msg}`);
const good = (msg) => log(`${C.ok}${msg}${C.off}`);
const warn = (msg) => log(`${C.warn}${msg}${C.off}`);
const fail = (msg) => log(`${C.err}${msg}${C.off}`);

function usage(exitCode = 0) {
  console.log(`
${C.b}gantry-runner${C.off} v${VERSION}

  Runs Gantry QE jobs on this machine. Connects outbound only.

${C.b}Usage${C.off}
  npx @gantry/runner connect --url <gantry-url> --token <token> [options]

${C.b}Required${C.off}
  --url <url>        Your Gantry deployment           (env GANTRY_URL)
  --token <token>    Runner token from Settings → Runners  (env GANTRY_TOKEN)

${C.b}Options${C.off}
  --name <name>      Runner name              default: this machine's hostname
  --slots <n>        Concurrent jobs          default: 2
  --workdir <path>   Where generated files land   default: current directory
  --exec "<cmd>"     Command that runs the tests, e.g. "npx playwright test"
                     Omit it and the runner writes the files without executing them.
  --poll-ms <n>      Poll interval            default: 3000
  --once             Take one job, then exit  (useful in CI)
  --help             This text

${C.b}Example${C.off}
  npx @gantry/runner connect \\
    --url https://gantry.example.com \\
    --token gnt_rnr_… \\
    --name ci-worker-1 --slots 4 \\
    --workdir ./e2e --exec "npx playwright test"
`);
  process.exit(exitCode);
}

if (args.help || command === "help") usage(0);
if (command !== "connect") {
  fail(`Unknown command "${command}". Try: npx @gantry/runner connect --help`);
  process.exit(2);
}
if (!URL_BASE || !TOKEN) {
  fail("Both --url and --token are required.");
  usage(2);
}

// ------------------------------------------------------------------ http ---

async function api(path, body, { timeoutMs = 180_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${URL_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* a non-JSON body is reported through res.ok below */
    }
    if (!res.ok) {
      const detail = json?.error || text.slice(0, 200) || res.statusText;
      throw new Error(`${res.status} ${detail}`);
    }
    return json ?? {};
  } finally {
    clearTimeout(timer);
  }
}

let active = 0;

async function heartbeat() {
  return api("/api/runner/heartbeat", {
    version: VERSION,
    slots: SLOTS,
    activeJobs: active,
    location: `${platform()}-${arch()} · ${hostname()}`,
  });
}

/** Buffers log lines and ships them so a chatty test suite does not make one request per line. */
function makeShipper(jobId) {
  let queue = [];
  let timer = null;
  const flush = async () => {
    if (queue.length === 0) return;
    const batch = queue.splice(0, 100);
    try {
      await api(`/api/runner/jobs/${jobId}/log`, { lines: batch });
    } catch {
      /* dropping a log line must never take down the job */
    }
  };
  return {
    push(message, level = "info") {
      queue.push({ message: String(message).slice(0, 4000), level });
      if (!timer) timer = setTimeout(() => ((timer = null), void flush()), 700);
    },
    /** Ships whatever is queued right now, so ordering against server-side lines holds. */
    async flushNow() {
      if (timer) clearTimeout(timer);
      timer = null;
      await flush();
    },
    async done() {
      if (timer) clearTimeout(timer);
      timer = null;
      await flush();
    },
  };
}

/** Keeps a generated path inside the working directory, whatever the server sent. */
function safeJoin(base, candidate) {
  const target = normalize(join(base, candidate.replace(/^([a-zA-Z]:)?[\\/]+/, "")));
  if (target !== base && !target.startsWith(base + (process.platform === "win32" ? "\\" : "/"))) {
    throw new Error(`Refusing to write outside the workdir: ${candidate}`);
  }
  return target;
}

function runCommand(cmd, cwd, onLine) {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, { cwd, shell: true, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    let tail = "";
    const feed = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-8000);
      for (const line of text.split("\n")) if (line.trim()) onLine(line.trimEnd());
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (err) => resolvePromise({ code: 1, tail: `${tail}\n${err.message}` }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, tail }));
  });
}

// ------------------------------------------------------------------ jobs ---

async function handleJob(job) {
  active++;
  const label = job.storyKey ? `${job.storyKey}` : job.kind;
  good(`claimed ${C.b}${label}${C.off}${C.ok} (${job.kind})${C.off}`);
  const ship = makeShipper(job.id);

  let status = "passed";
  let failureOutput = null;
  const written = [];

  try {
    let assets = [];

    if (job.kind === "spec-gen") {
      ship.push("asking Gantry to generate specs for this story");
      await ship.flushNow();
      const gen = await api(`/api/runner/jobs/${job.id}/generate`, {});
      assets = gen.assets ?? [];
      if (gen.mode === "simulated") ship.push("server has no ANTHROPIC_API_KEY — specs came from the simulator", "warn");
      if (gen.summary) ship.push(gen.summary);
      for (const s of gen.scenarios ?? []) ship.push(`scenario: ${s.name}`);
      if (gen.needsHuman) ship.push(gen.notes || "flagged for human review", "warn");
    } else {
      assets = job.payload?.assets ?? [];
    }

    for (const a of assets) {
      if (!a?.path || typeof a.content !== "string") continue;
      const target = safeJoin(WORKDIR, a.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, a.content, "utf8");
      written.push(a.path);
      ship.push(`wrote ${a.path}`, "ok");
      log(`  ${C.dim}wrote${C.off} ${a.path}`);
    }

    if (EXEC) {
      ship.push(`$ ${EXEC}`);
      log(`  ${C.acc}$ ${EXEC}${C.off}`);
      const { code, tail } = await runCommand(EXEC, WORKDIR, (line) => {
        ship.push(line, /\berror\b|\bfailed\b|✘/i.test(line) ? "error" : "info");
        log(`  ${C.dim}${line}${C.off}`);
      });
      if (code !== 0) {
        status = "failed";
        failureOutput = tail;
        ship.push(`command exited ${code}`, "error");
      } else {
        ship.push("command exited 0", "ok");
      }
    } else if (written.length) {
      ship.push("no --exec given, so the files were written but not executed", "warn");
    }
  } catch (err) {
    status = "failed";
    failureOutput = err instanceof Error ? err.message : String(err);
    ship.push(failureOutput, "error");
    fail(`  ${failureOutput}`);
  }

  await ship.done();

  try {
    await api(`/api/runner/jobs/${job.id}/complete`, {
      status,
      failureOutput,
      result: { written, exec: EXEC || null },
    });
    (status === "passed" ? good : fail)(`${label} → ${status}`);
  } catch (err) {
    fail(`could not report completion for ${label}: ${err.message}`);
  } finally {
    active = Math.max(0, active - 1);
  }
}

// ------------------------------------------------------------------ loop ---

let running = true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!running) process.exit(1);
    running = false;
    warn("shutting down — finishing in-flight jobs");
  });
}

async function main() {
  console.log(
    `\n${C.b}Gantry runner${C.off} ${C.dim}v${VERSION}${C.off}\n` +
      `  ${C.dim}gantry${C.off}   ${URL_BASE}\n` +
      `  ${C.dim}name${C.off}     ${NAME}\n` +
      `  ${C.dim}slots${C.off}    ${SLOTS}\n` +
      `  ${C.dim}workdir${C.off}  ${WORKDIR}\n` +
      `  ${C.dim}exec${C.off}     ${EXEC || "(none — files are written, not executed)"}\n`
  );

  try {
    const hb = await heartbeat();
    good(`connected as ${hb.runner?.name ?? NAME}`);
  } catch (err) {
    fail(`could not connect: ${err.message}`);
    fail("check --url, and that the token has not been revoked in Settings → Runners.");
    process.exit(1);
  }

  const beat = setInterval(() => {
    heartbeat().catch(() => warn("heartbeat failed — will retry"));
  }, HEARTBEAT_MS);

  let idleLogged = false;
  let backoff = POLL_MS;

  while (running) {
    if (active >= SLOTS) {
      await sleep(POLL_MS);
      continue;
    }
    try {
      const { job } = await api("/api/runner/claim", {}, { timeoutMs: 30_000 });
      backoff = POLL_MS;
      if (job) {
        idleLogged = false;
        void handleJob(job).then(() => {
          if (ONCE) running = false;
        });
        if (ONCE) {
          while (active > 0) await sleep(300);
          break;
        }
      } else {
        if (!idleLogged) {
          log(`${C.dim}waiting for work…${C.off}`);
          idleLogged = true;
        }
        await sleep(POLL_MS);
      }
    } catch (err) {
      warn(`poll failed: ${err.message}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  clearInterval(beat);
  while (active > 0) await sleep(300);
  await heartbeat().catch(() => {});
  good("runner stopped");
  process.exit(0);
}

main().catch((err) => {
  fail(err?.stack || String(err));
  process.exit(1);
});
