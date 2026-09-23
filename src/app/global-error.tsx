"use client";

/** Last resort when the root layout itself fails. Keeps its own markup: no app CSS is guaranteed. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 32, background: "#edf0f5", color: "#0d1526" }}>
        <h1 style={{ fontSize: 20 }}>Gantry could not load</h1>
        <p style={{ fontSize: 14 }}>Reload the page. If it keeps failing, give your administrator this reference: {error.digest ?? "none"}.</p>
        <button type="button" onClick={reset} style={{ padding: "8px 14px", fontSize: 14 }}>
          Try again
        </button>
      </body>
    </html>
  );
}
