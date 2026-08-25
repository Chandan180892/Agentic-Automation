// Verifies the contract demo sign-in depends on: a Session row plus the Auth.js
// cookie name must authenticate a real request against the authenticated pages.
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
const require = createRequire(import.meta.url);
const { PrismaClient } = require("../src/generated/prisma");
const db = new PrismaClient();
const BASE = process.env.BASE || "http://127.0.0.1:3210";
const ok = [], bad = [];
const check = (n, c, e = "") => (c ? ok : bad).push(`${c ? "PASS" : "FAIL"} ${n}${e ? ` — ${e}` : ""}`);

// 1. no cookie must not reach the app
let r = await fetch(`${BASE}/sprint`, { redirect: "manual" });
check("anonymous request is redirected away from /sprint", r.status === 307 || r.status === 302, `got ${r.status}`);

// 2. mint a session exactly the way src/lib/demo.ts does
const user = await db.user.create({
  data: { email: `demo-check-${Date.now()}@gantry.local`, name: "Demo Check", emailVerified: new Date() },
});
await db.workspace.create({
  data: { name: "Demo check ws", slug: `demo-check-${Date.now()}`, members: { create: { userId: user.id, role: "owner" } } },
});
const sessionToken = randomBytes(32).toString("hex");
await db.session.create({
  data: { sessionToken, userId: user.id, expires: new Date(Date.now() + 30 * 864e5) },
});
const cookie = `authjs.session-token=${sessionToken}`;

// 3. every authenticated page must now render
for (const path of ["/sprint", "/agents", "/runs", "/runners", "/results", "/settings"]) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  const body = res.ok ? await res.text() : "";
  check(`${path} renders for a session cookie`, res.status === 200, `got ${res.status}`);
  if (res.ok) check(`${path} shows the app shell`, body.includes("Gantry"), "no shell markup");
}

// 4. an expired session must be rejected
const staleToken = randomBytes(32).toString("hex");
await db.session.create({ data: { sessionToken: staleToken, userId: user.id, expires: new Date(Date.now() - 1000) } });
r = await fetch(`${BASE}/sprint`, { headers: { cookie: `authjs.session-token=${staleToken}` }, redirect: "manual" });
check("expired session is rejected", r.status !== 200, `got ${r.status}`);

// 5. a forged token must be rejected
r = await fetch(`${BASE}/sprint`, { headers: { cookie: `authjs.session-token=${randomBytes(32).toString("hex")}` }, redirect: "manual" });
check("forged session token is rejected", r.status !== 200, `got ${r.status}`);

await db.user.delete({ where: { id: user.id } });
await db.$disconnect();
console.log([...ok, ...bad].join("\n"));
console.log(`\n${ok.length} passed, ${bad.length} failed`);
process.exit(bad.length ? 1 : 0);
