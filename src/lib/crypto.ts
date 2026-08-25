import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Runner tokens are shown once at creation and never stored in the clear.
 * We keep a SHA-256 hash plus a short hint so the UI can tell tokens apart.
 */
export function newRunnerToken() {
  const token = `gnt_rnr_${randomBytes(24).toString("base64url")}`;
  return { token, hash: hashToken(token), hint: token.slice(-6) };
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function slugify(input: string) {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "workspace"
  );
}
