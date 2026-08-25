import { auth } from "@/auth";
import { db } from "@/lib/db";
import { slugify } from "@/lib/crypto";

export type Session = Awaited<ReturnType<typeof auth>>;

/** The signed-in user's workspace, created on demand if the sign-in event missed it. */
export async function requireWorkspace() {
  const session = await auth();
  if (!session?.user?.id) return null;

  const membership = await db.membership.findFirst({
    where: { userId: session.user.id },
    include: { workspace: true },
    orderBy: { createdAt: "asc" },
  });
  if (membership) return { session, workspace: membership.workspace };

  const label = session.user.name?.split(" ")[0] ?? "My";
  let slug = slugify(`${label}-workspace`);
  for (let i = 2; await db.workspace.findUnique({ where: { slug } }); i++) {
    slug = `${slugify(`${label}-workspace`)}-${i}`;
  }
  const workspace = await db.workspace.create({
    data: {
      name: `${label}'s workspace`,
      slug,
      members: { create: { userId: session.user.id, role: "owner" } },
    },
  });
  return { session, workspace };
}
