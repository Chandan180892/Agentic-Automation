"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/** Shows the message a refused action sent back in `?notice=`, then tidies the URL. */
export function Notice() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const n = params.get("notice");
    if (!n) return;
    setMessage(n.slice(0, 400));
    const rest = new URLSearchParams(params);
    rest.delete("notice");
    router.replace(rest.size ? `${path}?${rest}` : path, { scroll: false });
  }, [params, path, router]);

  if (!message) return null;
  return (
    <div role="alert" className="mx-5 mt-4 flex items-start gap-3 rounded-[10px] border border-heal/30 bg-heal-soft px-4 py-3">
      <p className="text-[12.5px] leading-[1.6] text-heal">{message}</p>
      <button
        type="button"
        onClick={() => setMessage(null)}
        className="ml-auto rounded-md px-1.5 text-[12px] font-semibold text-heal hover:bg-heal/10"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
