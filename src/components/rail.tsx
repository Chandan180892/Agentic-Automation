"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { signOutAction } from "@/app/login/actions";

interface NavLink {
  href: string;
  label: string;
  key: string | null;
  d: string;
  rect?: [number, number, number, number];
}

const ITEMS: { group: string; links: NavLink[] }[] = [
  {
    group: "Workspace",
    links: [
      { href: "/sprint", label: "Sprint planner", key: "sprint", d: "M4 6h16M4 12h10M4 18h13" },
      { href: "/agents", label: "Agents", key: "agents", d: "M12 8V4M9 14h.01M15 14h.01", rect: [4, 8, 16, 12] as [number, number, number, number] },
    ],
  },
  {
    group: "Delivery",
    links: [
      { href: "/results", label: "Results", key: "live", d: "M3 18l5-6 4 4 4-7 5 6M3 21h18" },
      { href: "/settings", label: "Settings", key: null, d: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" },
    ],
  },
];


export function Rail({
  workspaceName,
  user,
  counts,
}: {
  workspaceName: string;
  user: { name: string; email: string; image: string | null };
  counts: { sprint: string; agents: number; live: number };
}) {
  const path = usePathname();
  const tick = (key: string | null) =>
    key === "sprint" ? counts.sprint : key === "agents" ? String(counts.agents) : key === "live" ? String(counts.live) : null;

  const initials =
    user.name
      .split(" ")
      .map((s) => s[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-line bg-surface-2 p-3 lg:flex-col lg:overflow-visible lg:border-b-0 lg:border-r lg:p-4">
      <div className="flex shrink-0 items-center gap-2.5 px-2 lg:pb-4">
        <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-accent font-display text-[15px] font-extrabold text-accent-ink shadow-[inset_0_-2px_0_rgba(0,0,0,0.18)]">
          G
        </span>
        <span className="min-w-0">
          <b className="block font-display text-[17px] leading-[1.1] tracking-[-0.03em]">Gantry</b>
          <span className="block truncate text-[10.5px] font-semibold uppercase tracking-[0.11em] text-muted">
            {workspaceName}
          </span>
        </span>
      </div>

      {ITEMS.map((section) => (
        <div key={section.group} className="contents lg:block">
          <span className="hidden px-2.5 pb-1.5 pt-3.5 text-[10px] font-bold uppercase tracking-[0.13em] text-muted lg:block">
            {section.group}
          </span>
          {section.links.map((l) => {
            const active = path === l.href || path.startsWith(l.href + "/");
            const t = tick(l.key);
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors",
                  active
                    ? "bg-accent-soft font-semibold text-accent"
                    : "text-ink-2 hover:bg-surface-3 hover:text-ink"
                )}
              >
                <svg viewBox="0 0 24 24" className="size-4 shrink-0 fill-none stroke-current stroke-[1.7]" strokeLinecap="round" strokeLinejoin="round">
                  {l.rect && <rect x={l.rect[0]} y={l.rect[1]} width={l.rect[2]} height={l.rect[3]} rx="2" />}
                  <path d={l.d} />
                </svg>
                <span className="whitespace-nowrap">{l.label}</span>
                {t && <span className="ml-auto hidden font-mono text-[11px] font-medium text-muted lg:inline">{t}</span>}
              </Link>
            );
          })}
        </div>
      ))}

      <div className="ml-auto flex shrink-0 items-center lg:ml-0 lg:mt-auto lg:block lg:border-t lg:border-line lg:pt-3">
        <div className="flex items-center gap-2.5 rounded-lg px-2 py-1.5">
          {user.image ? (
            /* the avatar is a remote OAuth URL, so a plain img avoids the optimizer round-trip */
            <img src={user.image} alt="" className="size-[26px] shrink-0 rounded-full" />
          ) : (
            <span className="grid size-[26px] shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-live text-[11px] font-bold text-white">
              {initials}
            </span>
          )}
          <span className="hidden min-w-0 lg:block">
            <span className="block truncate text-[12.5px] font-semibold leading-[1.25]">{user.name}</span>
            <span className="block truncate text-[11px] leading-[1.25] text-muted">{user.email}</span>
          </span>
          <form action={signOutAction} className="ml-auto">
            <button
              type="submit"
              title="Sign out"
              className="rounded-md p-1 text-muted transition-colors hover:bg-surface-3 hover:text-ink"
            >
              <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-[1.7]" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
            </button>
          </form>
        </div>
      </div>
    </nav>
  );
}
