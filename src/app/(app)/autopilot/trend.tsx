"use client";

import { useState } from "react";

/**
 * One metric across cycles: a single series, so no legend — the title names it. The first and
 * last values are labelled directly; every point has a hover readout.
 */
export function Trend({
  title,
  points,
  unit = "",
  max,
  better,
}: {
  title: string;
  points: { x: number; y: number }[];
  unit?: string;
  max?: number;
  better: "up" | "down";
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 300;
  const H = 120;
  const pad = { l: 8, r: 8, t: 18, b: 20 };
  const top = Math.max(max ?? 0, ...points.map((p) => p.y), 1);
  const x = (i: number) => pad.l + (points.length === 1 ? 0 : (i / (points.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const first = points[0];
  const last = points[points.length - 1];
  const delta = last.y - first.y;
  const improved = delta === 0 ? null : (delta > 0) === (better === "up");

  return (
    <figure className="min-w-0">
      <figcaption className="flex items-baseline gap-2">
        <span className="text-[12.5px] font-semibold">{title}</span>
        <span className={`ml-auto font-mono text-[11px] ${improved === null ? "text-muted" : improved ? "text-pass" : "text-fail"}`}>
          {first.y}
          {unit} → {last.y}
          {unit}
          {improved === null ? "" : improved ? " ▲ better" : " ▼ worse"}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="mt-1 w-full overflow-visible"
        role="img"
        aria-label={`${title}: ${points.map((p) => `cycle ${p.x} ${p.y}${unit}`).join(", ")}`}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} className="stroke-line" strokeWidth={1} />
        <polyline
          points={points.map((p, i) => `${x(i)},${y(p.y)}`).join(" ")}
          fill="none"
          className="stroke-accent"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((p, i) => (
          <g key={p.x}>
            {/* hit target wider than the mark */}
            <rect
              x={x(i) - (W / Math.max(points.length, 2)) / 2}
              y={0}
              width={W / Math.max(points.length, 2)}
              height={H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
            <circle cx={x(i)} cy={y(p.y)} r={hover === i ? 5 : 4} className="fill-accent stroke-surface" strokeWidth={2} pointerEvents="none" />
            <text x={x(i)} y={H - 4} textAnchor="middle" className="fill-muted font-mono text-[9.5px]" pointerEvents="none">
              {p.x}
            </text>
          </g>
        ))}
        {[0, points.length - 1].map((i) =>
          hover === null ? (
            <text
              key={i}
              x={x(i)}
              y={y(points[i].y) - 8}
              textAnchor={i === 0 ? "start" : "end"}
              className="fill-ink font-mono text-[10.5px] font-semibold"
            >
              {points[i].y}
              {unit}
            </text>
          ) : null
        )}
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={pad.t - 6} y2={y(0)} className="stroke-line" strokeDasharray="3 3" />
            <text
              x={Math.min(Math.max(x(hover), 40), W - 40)}
              y={10}
              textAnchor="middle"
              className="fill-ink font-mono text-[10.5px] font-semibold"
            >
              cycle {points[hover].x}: {points[hover].y}
              {unit}
            </text>
          </g>
        )}
      </svg>
    </figure>
  );
}
