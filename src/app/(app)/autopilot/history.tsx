"use client";

import { useState } from "react";

const KIND_GLYPH: Record<string, string> = {
  created: "+",
  reinforced: "↑",
  confirmed: "✓",
  contradicted: "✗",
  retired: "–",
  resolved: "✓",
  approved: "✓",
  rejected: "✗",
};

/** A lesson's confidence over its life: one mark per event, hover for what happened. */
export function History({ events }: { events: { kind: string; confidence: number; at: string; note: string }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 220;
  const H = 34;
  const x = (i: number) => 4 + (events.length === 1 ? 0 : (i / (events.length - 1)) * (W - 8));
  const y = (c: number) => 4 + (1 - c) * (H - 8);
  const e = hover === null ? events[events.length - 1] : events[hover];

  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-[34px] w-[220px] max-w-full overflow-visible"
        role="img"
        aria-label={`confidence history: ${events.map((v) => `${v.kind} ${v.confidence.toFixed(2)}`).join(", ")}`}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={4} x2={W - 4} y1={y(0.25)} y2={y(0.25)} className="stroke-line" strokeDasharray="2 3" />
        <polyline
          points={events.map((v, i) => `${x(i)},${y(v.confidence)}`).join(" ")}
          fill="none"
          className="stroke-accent"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
        {events.map((v, i) => (
          <g key={i}>
            <rect x={x(i) - 8} y={0} width={16} height={H} fill="transparent" onMouseEnter={() => setHover(i)} />
            <circle
              cx={x(i)}
              cy={y(v.confidence)}
              r={hover === i ? 4 : 2.6}
              className={v.kind === "contradicted" || v.kind === "rejected" ? "fill-fail" : "fill-accent"}
              pointerEvents="none"
            />
          </g>
        ))}
      </svg>
      <span className="min-w-0 flex-1 font-mono text-[11px] text-muted">
        {KIND_GLYPH[e.kind] ?? "·"} {e.kind} → {e.confidence.toFixed(2)}
        {e.note ? ` — ${e.note.slice(0, 80)}` : ""}
      </span>
    </div>
  );
}
