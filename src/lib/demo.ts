import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { slugify } from "@/lib/crypto";

/**
 * Demo sign-in.
 *
 * OAuth is the real way in. But a fresh deployment has no OAuth client IDs yet, which
 * would leave the app behind a door nobody can open. With ALLOW_DEMO_LOGIN=true the login
 * page offers a shared demo account so the deployment is explorable immediately.
 *
 * This is off unless explicitly switched on, and the login page says plainly what it is.
 * Auth.js cannot issue a credentials session while using the database strategy, so we mint
 * the session row and cookie exactly the way the Prisma adapter does.
 */
export function demoLoginEnabled() {
  return process.env.ALLOW_DEMO_LOGIN === "true";
}

const DEMO_EMAIL = "demo@gantry.local";
const SESSION_DAYS = 30;

/** Matches @auth/core's own cookie naming so the session is read back normally. */
function sessionCookieName() {
  const secure =
    process.env.AUTH_URL?.startsWith("https://") ?? process.env.NODE_ENV === "production";
  return secure ? "__Secure-authjs.session-token" : "authjs.session-token";
}

export async function signInAsDemo() {
  if (!demoLoginEnabled()) throw new Error("Demo sign-in is not enabled on this deployment.");

  let user = await db.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (!user) {
    user = await db.user.create({
      data: { email: DEMO_EMAIL, name: "Demo User", emailVerified: new Date() },
    });
  }

  const membership = await db.membership.findFirst({ where: { userId: user.id } });
  if (!membership) {
    let slug = slugify("demo-workspace");
    for (let i = 2; await db.workspace.findUnique({ where: { slug } }); i++) {
      slug = `demo-workspace-${i}`;
    }
    await db.workspace.create({
      data: {
        name: "Demo workspace",
        slug,
        members: { create: { userId: user.id, role: "owner" } },
      },
    });
  }

  const sessionToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000);
  await db.session.create({ data: { sessionToken, userId: user.id, expires } });

  const jar = await cookies();
  const name = sessionCookieName();
  jar.set(name, sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: name.startsWith("__Secure-"),
    expires,
  });
}
