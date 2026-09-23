/**
 * Structured logging. One JSON object per line in production, so any log pipeline can index it;
 * a short readable line in development.
 */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const v = process.env.LOG_LEVEL as Level | undefined;
  return ORDER[v && v in ORDER ? v : "info"];
}

const pretty = process.env.NODE_ENV !== "production";

function errorFields(err: unknown) {
  return err instanceof Error ? { error: err.message, stack: err.stack?.split("\n").slice(0, 6).join("\n") } : { error: String(err) };
}

function write(level: Level, msg: string, fields: Record<string, unknown> = {}) {
  if (ORDER[level] < threshold()) return;
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  if (pretty) {
    const extra = Object.entries(fields)
      .filter(([k]) => k !== "stack")
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
    out.write(`${level.toUpperCase().padEnd(5)} ${msg}${extra ? `  ${extra}` : ""}\n`);
    return;
  }
  out.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })}\n`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write("warn", msg, fields),
  error: (msg: string, err?: unknown, fields?: Record<string, unknown>) =>
    write("error", msg, { ...fields, ...(err === undefined ? {} : errorFields(err)) }),
};
