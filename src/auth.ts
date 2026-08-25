import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import GitHub from "next-auth/providers/github";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/db";
import { slugify } from "@/lib/crypto";

const providers = [];
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
  providers.push(
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
      allowDangerousEmailAccountLinking: true,
    })
  );
}
if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
  providers.push(
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID,
      clientSecret: process.env.AUTH_GITHUB_SECRET,
      allowDangerousEmailAccountLinking: true,
    })
  );
}

/** Which sign-in buttons the login page should render. */
export const enabledProviders = {
  google: Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET),
  github: Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET),
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  providers,
  session: { strategy: "database" },
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    async session({ session, user }) {
      if (session.user) session.user.id = user.id;
      return session;
    },
  },
  events: {
    /** First sign-in creates the user's workspace, so nobody lands on an empty app. */
    async createUser({ user }) {
      if (!user.id) return;
      const label = user.name?.split(" ")[0] ?? user.email?.split("@")[0] ?? "My";
      const base = slugify(`${label}-workspace`);
      let slug = base;
      for (let i = 2; await db.workspace.findUnique({ where: { slug } }); i++) {
        slug = `${base}-${i}`;
      }
      await db.workspace.create({
        data: {
          name: `${label}'s workspace`,
          slug,
          members: { create: { userId: user.id, role: "owner" } },
        },
      });
    },
  },
});
