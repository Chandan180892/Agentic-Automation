import { z } from "zod";

/**
 * Every setting the server reads, validated once. In production a missing or malformed value
 * stops the server at boot with a message naming it, instead of failing on the first request
 * that happens to need it.
 */
const num = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? fallback : Number(v)))
    .pipe(z.number().finite().nonnegative());

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .min(1, "is required")
    .refine((v) => /^postgres(ql)?:\/\//.test(v), "must be a postgresql:// connection string"),
  AUTH_SECRET: z.string().optional(),
  AUTH_URL: z.string().url().optional().or(z.literal("")),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-sonnet-5"),
  /** Per request, in milliseconds. Retries each get their own timeout. */
  MODEL_TIMEOUT_MS: num(120_000),
  MODEL_MAX_RETRIES: num(3),
  /** Input + output tokens a workspace may spend per UTC day. 0 disables the cap. */
  AGENT_DAILY_TOKEN_BUDGET: num(3_000_000),

  /** "inline": the web server also runs the job worker. "off": run `npm run worker` separately. */
  WORKER_MODE: z.enum(["inline", "off"]).default("inline"),
  WORKER_CONCURRENCY: num(2),
  /** How long a claimed job may go without a heartbeat before it is considered abandoned. */
  JOB_LEASE_MS: num(60_000),
  /** Log lines and finished jobs older than this are deleted. 0 keeps everything. */
  EVENT_RETENTION_DAYS: num(30),
  /** Agent-starting actions allowed per workspace per minute. */
  ACTION_RATE_LIMIT_PER_MINUTE: num(10),

  AUTOPILOT_PACE_MS: z.string().optional(),
  AUTOPILOT_MAX_CYCLES: z.string().optional(),
  ALLOW_DEMO_LOGIN: z.string().optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type AppEnv = z.infer<typeof Env>;

let cached: AppEnv | null = null;

export function env(): AppEnv {
  if (cached) return cached;
  const parsed = Env.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment:\n${lines}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * Production-only checks that would be noise in development. Returns warnings to log; throws on
 * anything that would make the deployment unsafe.
 */
export function checkProductionEnv(): string[] {
  const e = env();
  if (e.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!e.AUTH_SECRET || e.AUTH_SECRET.length < 32) problems.push("AUTH_SECRET must be set to at least 32 characters (openssl rand -base64 32).");
  if (!e.AUTH_URL) warnings.push("AUTH_URL is not set; OAuth callbacks and secure cookies may resolve against the wrong origin.");
  if (!e.ANTHROPIC_API_KEY) warnings.push("ANTHROPIC_API_KEY is not set; every agent runs on its simulator.");
  if (e.ALLOW_DEMO_LOGIN === "true") warnings.push("ALLOW_DEMO_LOGIN is on: anyone can sign in to the shared demo workspace. Turn it off once OAuth is configured.");
  if (e.AGENT_DAILY_TOKEN_BUDGET === 0) warnings.push("AGENT_DAILY_TOKEN_BUDGET is 0: model spend is uncapped.");
  if (problems.length) throw new Error(`Refusing to start:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return warnings;
}

/** For tests: forget the parsed environment so a changed process.env is read again. */
export function resetEnvForTests() {
  cached = null;
}
