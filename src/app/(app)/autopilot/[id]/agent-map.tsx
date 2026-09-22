"use client";

import { cn } from "@/lib/utils";
import type { CycleOutput } from "@/lib/agents/autopilot";

const SUB_AGENTS = ["story-analyzer", "clarify", "asset-resolver", "spec-author", "verifier", "reviewer"] as const;

const NODES = [
  { phase: "recall", name: "memory", role: "recall" },
  { phase: "plan", name: "sprint-planner", role: "plan" },
  { phase: "automate", name: "qe-pipeline", role: "automate" },
  { phase: "execute", name: "executor", role: "execute" },
  { phase: "heal", name: "qe-auto-heal", role: "heal" },
  { phase: "review", name: "requirements-reviewer", role: "review" },
  { phase: "report", name: "cycle-reporter", role: "report" },
  { phase: "learn", name: "learner", role: "learn" },
] as const;

const W = 1032;
const NODE_W = 112;
const NODE_H = 62;
const STEP = 128;
const TOP = 26;

function stat(phase: string, out: CycleOutput | null): string {
  const m = out?.metrics;
  if (!out || !m) return "";
  switch (phase) {
    case "recall":
      return `${m.lessonsApplied} lesson${m.lessonsApplied === 1 ? "" : "s"} in`;
    case "plan":
      return m.storiesCommitted ? `${m.storiesCommitted} committed` : "";
    case "automate":
      return out.stories.length ? `${m.storiesSpecced}/${m.storiesCommitted} specced` : "";
    case "execute":
      return m.testsRun ? `${m.testsRun} tests` : "";
    case "heal":
      return m.testsRun ? `${m.healed} healed` : "";
    case "review":
      return m.criteriaTotal ? `${m.criteriaMet}/${m.criteriaTotal} met` : "";
    case "report":
      if (!out.report) return "";
      {
        const n = out.bugs?.filter((b) => b.status === "proposed").length ?? 0;
        return `${n} bug${n === 1 ? "" : "s"} to file`;
      }
    case "learn":
      return out.learning ? `+${out.learning.created.length} new lesson${out.learning.created.length === 1 ? "" : "s"}` : "";
  }
  return "";
}

/**
 * The cycle as a map of agents: which one holds the work right now, what each has produced,
 * and the loop back from learner to memory that makes the next cycle different.
 */
export function AgentMap({
  stages,
  output,
  lastSource,
}: {
  stages: { agent: string; status: string }[];
  output: CycleOutput | null;
  /** Source of the newest log line — picks out the active pipeline sub-agent. */
  lastSource: string;
}) {
  const statusOf = (phase: string) => stages.find((s) => s.agent === phase)?.status ?? "pending";
  const learnDone = statusOf("learn") === "passed";
  const x = (i: number) => 8 + i * STEP;

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} 150`} className="min-w-[760px] w-full" role="img" aria-label="Agents in this cycle and which one is working">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 8 4 0 8z" className="fill-muted" />
          </marker>
        </defs>

        {/* hand-offs between phases */}
        {NODES.slice(1).map((_, i) => {
          const done = statusOf(NODES[i].phase) === "passed" || statusOf(NODES[i].phase) === "blocked";
          return (
            <line
              key={i}
              x1={x(i) + NODE_W}
              x2={x(i + 1) - 3}
              y1={TOP + NODE_H / 2}
              y2={TOP + NODE_H / 2}
              className={done ? "stroke-accent" : "stroke-line"}
              strokeWidth={1.6}
              markerEnd="url(#arrow)"
            />
          );
        })}

        {/* the loop: learner writes lessons that memory feeds into the next cycle */}
        <path
          d={`M${x(7) + NODE_W / 2} ${TOP + NODE_H} V${TOP + NODE_H + 30} H${x(0) + NODE_W / 2} V${TOP + NODE_H + 4}`}
          fill="none"
          className={cn(learnDone ? "stroke-pass" : "stroke-line", "transition-colors")}
          strokeWidth={1.6}
          strokeDasharray={learnDone ? undefined : "4 4"}
          markerEnd="url(#arrow)"
        />
        <text x={W / 2} y={TOP + NODE_H + 25} textAnchor="middle" className="fill-muted font-mono text-[10.5px]">
          lessons feed the next cycle
          {output?.learning ? ` · +${output.learning.created.length} new, ${output.learning.confirmed.length} confirmed` : ""}
        </text>

        {NODES.map((n, i) => {
          const st = statusOf(n.phase);
          const active = st === "running";
          const done = st === "passed";
          const blocked = st === "blocked" || st === "failed";
          const s = stat(n.phase, output);
          return (
            <g key={n.phase} className={cn("transition-opacity", st === "pending" && "opacity-50")}>
              {active && (
                <rect
                  x={x(i) - 4}
                  y={TOP - 4}
                  width={NODE_W + 8}
                  height={NODE_H + 8}
                  rx={12}
                  className="fill-live-soft animate-pulse"
                />
              )}
              <rect
                x={x(i)}
                y={TOP}
                width={NODE_W}
                height={NODE_H}
                rx={9}
                className={cn(
                  "fill-surface",
                  active ? "stroke-live" : done ? "stroke-pass" : blocked ? "stroke-heal" : "stroke-line"
                )}
                strokeWidth={active ? 2 : 1.3}
              />
              <text x={x(i) + 10} y={TOP - 8} className="fill-muted font-mono text-[9.5px] uppercase tracking-[0.1em]">
                {n.role}
              </text>
              <text x={x(i) + 10} y={TOP + 20} className="fill-ink font-mono text-[10.5px] font-semibold">
                {n.name.length > 15 ? `${n.name.slice(0, 14)}…` : n.name}
              </text>
              {n.phase === "automate" ? (
                <g>
                  {SUB_AGENTS.map((a, k) => {
                    const on = active && lastSource === a;
                    return (
                      <circle
                        key={a}
                        cx={x(i) + 14 + k * 15}
                        cy={TOP + 34}
                        r={on ? 5 : 4}
                        className={on ? "fill-live" : done ? "fill-pass" : "fill-surface-3 stroke-line"}
                        strokeWidth={1}
                      >
                        <title>{a}</title>
                      </circle>
                    );
                  })}
                  <text x={x(i) + 10} y={TOP + 54} className="fill-muted font-mono text-[9.5px]">
                    {active && SUB_AGENTS.includes(lastSource as (typeof SUB_AGENTS)[number]) ? lastSource : s}
                  </text>
                </g>
              ) : (
                <text x={x(i) + 10} y={TOP + 40} className={cn("font-mono text-[10px]", active ? "fill-live" : "fill-muted")}>
                  {active && !s ? "working…" : s}
                </text>
              )}
              {n.phase !== "automate" && (
                <text x={x(i) + 10} y={TOP + 54} className="fill-muted font-mono text-[9.5px]">
                  {n.phase === "heal" && st !== "pending" && output
                    ? `${output.metrics.appBugs} app bug${output.metrics.appBugs === 1 ? "" : "s"}`
                    : done
                      ? "✓ done"
                      : blocked
                        ? "needs attention"
                        : active
                          ? "● active"
                          : ""}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
