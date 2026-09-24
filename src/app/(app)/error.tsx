"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui";

/** Anything a page or action did not expect. The digest matches the server log line. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-20 text-center">
      <h2 className="text-[18px]">Something went wrong</h2>
      <p className="max-w-[52ch] text-[13px] leading-[1.6] text-muted">
        The page could not finish loading. Nothing was published. Try again; if it keeps happening, give your
        administrator this reference so they can find it in the server log.
      </p>
      {error.digest && <code className="rounded bg-surface-3 px-2 py-1 font-mono text-[12px]">{error.digest}</code>}
      <Button variant="primary" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
