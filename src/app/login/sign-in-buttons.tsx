"use client";

import { useState, useTransition } from "react";
import { signInWith } from "./actions";

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[19px] shrink-0" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.27-4.74 3.27-8.09Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.05l3.66 2.84C6.71 7.29 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-[19px] shrink-0" aria-hidden="true">
      <path fill="currentColor" d="M12 1a11 11 0 0 0-3.48 21.44c.55.1.75-.24.75-.53v-1.9c-3.06.67-3.71-1.3-3.71-1.3-.5-1.28-1.22-1.62-1.22-1.62-1-.68.08-.67.08-.67 1.1.08 1.68 1.14 1.68 1.14.98 1.69 2.58 1.2 3.21.92.1-.72.38-1.2.7-1.48-2.44-.28-5.01-1.23-5.01-5.47 0-1.21.43-2.2 1.14-2.97-.11-.28-.5-1.4.11-2.93 0 0 .93-.3 3.05 1.14a10.5 10.5 0 0 1 5.56 0c2.12-1.44 3.05-1.14 3.05-1.14.61 1.53.22 2.65.11 2.93.71.77 1.14 1.76 1.14 2.97 0 4.25-2.58 5.19-5.03 5.46.4.34.75 1 .75 2.02v3c0 .29.2.64.76.53A11 11 0 0 0 12 1Z" />
    </svg>
  );
}

export function SignInButtons({
  providers,
  callbackUrl,
}: {
  providers: { google: boolean; github: boolean };
  callbackUrl: string;
}) {
  const [pending, start] = useTransition();
  const [active, setActive] = useState<string | null>(null);

  function go(provider: string) {
    setActive(provider);
    start(() => {
      void signInWith(provider, callbackUrl);
    });
  }

  const cls =
    "flex w-full items-center gap-3 rounded-[10px] border border-line bg-surface px-4 py-3 text-[14px] font-semibold transition-[border-color,background,box-shadow] hover:border-accent-line hover:bg-surface-2 hover:shadow-[var(--shadow)] disabled:opacity-60";

  return (
    <div className="flex flex-col gap-2.5">
      {providers.google && (
        <button className={cls} onClick={() => go("google")} disabled={pending}>
          <GoogleMark />
          Continue with Google
          <span className="ml-auto font-mono text-[11px] text-muted">
            {pending && active === "google" ? "…" : "↵"}
          </span>
        </button>
      )}
      {providers.github && (
        <button className={cls} onClick={() => go("github")} disabled={pending}>
          <GitHubMark />
          Continue with GitHub
          <span className="ml-auto font-mono text-[11px] text-muted">
            {pending && active === "github" ? "…" : "↵"}
          </span>
        </button>
      )}
    </div>
  );
}
