import { db } from "@/lib/db";
import { hashToken } from "@/lib/crypto";

export type AuthedRunner = NonNullable<Awaited<ReturnType<typeof authenticateRunner>>>;

/**
 * Runners authenticate with a bearer token issued in the UI. We only ever hold the hash,
 * so a database read cannot leak a working credential.
 */
export async function authenticateRunner(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const runner = await db.runner.findUnique({ where: { tokenHash: hashToken(token) } });
  return runner;
}

export function unauthorized() {
  return Response.json(
    { error: "Invalid or missing runner token." },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
  );
}
