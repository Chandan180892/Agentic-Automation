import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth, enabledProviders } from "@/auth";
import { SignInButtons } from "./sign-in-buttons";
import { Pill } from "@/components/ui";

export const metadata: Metadata = { title: "Sign in" };

const CHAIN = [
  {
    t: "Plan the sprint",
    d: "sprint-planner sizes and sequences the backlog",
    p: "M4 6h16M4 12h10M4 18h13",
  },
  {
    t: "Generate specs & assets",
    d: "qe-pipelines and qe-batch turn stories into runnable suites",
    p: "M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5",
  },
  {
    t: "Run on your servers",
    d: "outbound runners — no inbound ports, no SSH keys",
    p: "M8 20h8M12 16v4",
    rect: true,
  },
  {
    t: "Heal what breaks",
    d: "qe-auto-heal proposes the patch; batch-heal fixes the fleet",
    p: "M21 12a9 9 0 1 1-3-6.7M21 4v5h-5",
  },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const session = await auth();
  if (session?.user) redirect("/sprint");
  const { error, callbackUrl } = await searchParams;
  const anyProvider = enabledProviders.google || enabledProviders.github;

  return (
    <main className="mx-auto grid min-h-dvh max-w-[1320px] lg:grid-cols-[1.05fr_0.95fr]">
      <section className="blueprint flex flex-col border-line bg-surface-2 px-7 py-10 lg:border-r lg:px-12 lg:py-14">
        <div className="flex items-center gap-2.5">
          <span className="grid size-[30px] shrink-0 place-items-center rounded-lg bg-accent font-display text-[15px] font-extrabold text-accent-ink shadow-[inset_0_-2px_0_rgba(0,0,0,0.18)]">
            G
          </span>
          <span>
            <b className="block font-display text-[17px] leading-[1.1] tracking-[-0.03em]">Gantry</b>
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.11em] text-muted">
              Agentic QE
            </span>
          </span>
        </div>

        <h1 className="mt-7 max-w-[13ch] text-[clamp(32px,5vw,40px)] leading-[1.04] tracking-[-0.035em]">
          Sprint in.
          <br />
          <em className="not-italic text-accent">Green out.</em>
        </h1>
        <p className="mt-4 max-w-[46ch] text-[15px] leading-[1.6] text-ink-2">
          Gantry reads your sprint, writes the specs and test assets, and runs them on your own
          machines — cloud or the laptop under your desk. When a spec breaks, it fixes itself and
          shows you the diff.
        </p>

        <div className="mt-auto pt-10">
          <span className="text-[10px] font-bold uppercase tracking-[0.13em] text-muted">
            How a story becomes green
          </span>
          <ol className="mt-2">
            {CHAIN.map((c, i) => (
              <li key={c.t}>
                <div className="flex items-center gap-3 py-2.5">
                  <span className="grid size-[30px] shrink-0 place-items-center rounded-lg border border-line bg-surface">
                    <svg viewBox="0 0 24 24" className="size-[15px] fill-none stroke-accent stroke-[1.8]" strokeLinecap="round" strokeLinejoin="round">
                      {c.rect && <rect x="3" y="4" width="18" height="12" rx="2" />}
                      <path d={c.p} />
                    </svg>
                  </span>
                  <span>
                    <span className="block text-[13px] font-semibold">{c.t}</span>
                    <span className="block text-[12px] text-muted">{c.d}</span>
                  </span>
                </div>
                {i < CHAIN.length - 1 && <span className="ml-[15px] block h-3 w-px bg-line" />}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="flex flex-col justify-center gap-5 px-7 py-10 lg:px-12 lg:py-14">
        <div>
          <h2 className="text-[24px] tracking-[-0.03em]">Sign in to Gantry</h2>
          <p className="mt-1.5 text-[12.5px] text-muted">Use the account your code already lives under.</p>
        </div>

        {error && (
          <div className="rounded-lg border border-fail/30 bg-fail-soft px-3.5 py-3 text-[12.5px] text-fail">
            {error === "OAuthAccountNotLinked"
              ? "That email is already signed in through the other provider. Use the one you started with."
              : "Sign-in did not complete. Try again, and check the provider's callback URL if it keeps failing."}
          </div>
        )}

        {anyProvider ? (
          <SignInButtons providers={enabledProviders} callbackUrl={callbackUrl ?? "/sprint"} />
        ) : (
          <div className="rounded-lg border border-heal/30 bg-heal-soft px-4 py-3.5">
            <p className="text-[13px] font-semibold text-heal">No sign-in provider is configured yet</p>
            <p className="mt-1.5 text-[12.5px] leading-[1.6] text-heal/90">
              Set <code className="font-mono">AUTH_GOOGLE_ID</code> and{" "}
              <code className="font-mono">AUTH_GOOGLE_SECRET</code>, or the GitHub pair, then restart.
              The buttons appear on their own — see <code className="font-mono">.env.example</code>.
            </p>
          </div>
        )}

        <div className="flex items-center gap-3 text-[11px] font-bold uppercase tracking-[0.1em] text-muted">
          <span className="h-px flex-1 bg-line" />
          then
          <span className="h-px flex-1 bg-line" />
        </div>

        <div className="rounded-[10px] border border-line bg-surface-2 p-3.5">
          <div className="flex flex-wrap items-start gap-2.5">
            <Pill tone="accent">Workspace</Pill>
            <p className="flex-1 text-[11.5px] leading-[1.6] text-muted">
              Your first sign-in creates a workspace. Invite your team, connect a runner, and point
              Gantry at a repo — the agents pick up from there.
            </p>
          </div>
        </div>

        <p className="text-[11.5px] leading-[1.6] text-muted">
          Sessions are httpOnly cookies signed by Auth.js. Gantry never stores a password, and never
          asks for one.
        </p>
      </section>
    </main>
  );
}
