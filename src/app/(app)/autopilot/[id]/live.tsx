"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Card, CardHeader, CardBody, Pill, Sub, Label } from "@/components/ui";
import { PHASES } from "@/lib/agents/autopilot-phases";
import type { CycleOutput, TestResult } from "@/lib/agents/autopilot";

type Ev = { id: string; ts: string; level: string; source: string; message: string; runId: string };

export interface LiveState {
  status: string;
  error: string | null;
  stages: { agent: string; status: string; summary: string }[];
  output: CycleOutput | null;
  children: { id: string; agent: string; status: string; storyKey: string }[];
  events: Ev[];
}

const LEVEL = {
  ok: "text-[#4fd494]",
  error: "text-[#ff9182]",
  warn: "text-[#f2b65e]",
  info: "text-[#c6d3e6]",
} as const;

const STAGE_TONE = { passed: "pass", running: "live", blocked: "heal", failed: "fail", skipped: "idle", pending: "idle" } as const;
const CRITERION_TONE = { met: "pass", "not-met": "fail", untested: "heal", blocked: "idle" } as const;
const VERDICT_TONE = { accept: "pass", "accept-with-risks": "heal", reject: "fail" } as const;
const PIPE_TONE = { needs_review: "pass", running: "live", blocked: "heal", failed: "fail" } as const;

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function CycleLive({ runId, initial }: { runId: string; initial: LiveState }) {
  const [state, setState] = useState<LiveState>(initial);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  const done = state.status !== "running";

  useEffect(() => {
    if (done) return;
    let stop = false;
    const tick = async () => {
      try {
        const last = state.events[state.events.length - 1]?.ts ?? "";
        const res = await fetch(`/api/autopilot/${runId}?after=${encodeURIComponent(last)}`, { cache: "no-store" });
        if (!res.ok || stop) return;
        const data = (await res.json()) as LiveState;
        setState((prev) => {
          const seen = new Set(prev.events.map((e) => e.id));
          return { ...data, events: [...prev.events, ...data.events.filter((e) => !seen.has(e.id))] };
        });
      } catch {
        /* a dropped poll is not worth interrupting the page for */
      }
    };
    const t = setInterval(tick, 1000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [runId, done, state.events]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [state.events.length, follow]);

  const out = state.output;
  const m = out?.metrics;
  const start = state.events.length ? new Date(state.events[0].ts).getTime() : Date.now();
  const childAgent = useMemo(() => new Map(state.children.map((c) => [c.id, c])), [state.children]);
  // Between phases nothing is "running" for a moment; name the phase that is about to start.
  const active = (state.stages.find((s) => s.status === "running") ?? state.stages.find((s) => s.status === "pending"))?.agent;

  return (
    <div className="grid gap-4">
      {state.error && (
        <div className="rounded-[10px] border border-fail/30 bg-fail-soft px-4 py-3 text-[12.5px] text-fail">{state.error}</div>
      )}

      {/* ------------------------------------------------------------ phases -- */}
      <Card>
        <CardHeader title="Cycle">
          {done ? (
            <Pill tone={state.status === "succeeded" ? "pass" : "fail"}>{state.status}</Pill>
          ) : (
            <Pill tone="live">live · {PHASES.find((p) => p.id === active)?.label ?? "finishing"}</Pill>
          )}
          {out?.mode === "simulated" && <Pill tone="heal" dot={false}>simulated</Pill>}
        </CardHeader>
        <CardBody className="blueprint">
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
            {PHASES.map((p, i) => {
              const st = state.stages.find((s) => s.agent === p.id);
              const status = st?.status ?? "pending";
              const tone = STAGE_TONE[status as keyof typeof STAGE_TONE] ?? "idle";
              return (
                <li
                  key={p.id}
                  className={cn(
                    "flex min-h-[92px] flex-col gap-1 rounded-[9px] border bg-surface px-3 py-2.5 transition-colors",
                    status === "running" ? "border-live shadow-[0_0_0_3px_var(--live-soft)]" : "border-line",
                    status === "pending" && "opacity-60"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[10.5px] text-muted">{String(i + 1).padStart(2, "0")}</span>
                    <span className="text-[13px] font-semibold">{p.label}</span>
                    <Pill tone={tone} className="ml-auto !px-1.5">
                      {status === "running" ? "…" : status === "passed" ? "✓" : status === "pending" ? "" : status}
                    </Pill>
                  </div>
                  <p className="line-clamp-3 text-[11px] leading-[1.45] text-muted">{st?.summary || p.blurb}</p>
                </li>
              );
            })}
          </ol>
        </CardBody>
      </Card>

      {/* ----------------------------------------------------------- metrics -- */}
      {m && (
        <div className="grid grid-cols-2 overflow-hidden rounded-[10px] border border-line bg-surface sm:grid-cols-3 xl:grid-cols-6">
          <Metric label="lessons applied" value={m.lessonsApplied} />
          <Metric label="tests run" value={m.testsRun} />
          <Metric label="first-run pass" value={m.testsRun ? pct(m.firstRunPassRate) : "—"} />
          <Metric label="healed by agents" value={m.healed} tone={m.healed ? "heal" : undefined} />
          <Metric label="app defects" value={m.appBugs} tone={m.appBugs ? "fail" : undefined} />
          <Metric
            label="criteria met"
            value={m.criteriaTotal ? `${m.criteriaMet}/${m.criteriaTotal}` : "—"}
            tone={m.criteriaTotal ? (m.criteriaMet === m.criteriaTotal ? "pass" : "heal") : undefined}
          />
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[1.15fr_1fr]">
        {/* ------------------------------------------------------------- log -- */}
        <div className="term overflow-hidden rounded-[9px] xl:row-span-2">
          <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3.5 py-2.5">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2 py-[2.5px] text-[11px] font-semibold",
                done ? "border-white/15 bg-white/5 text-[#9fb0c9]" : "border-[#5fc8ea]/30 bg-[#5fc8ea]/10 text-[#5fc8ea]"
              )}
            >
              <span className="size-[5px] rounded-full bg-current" />
              {done ? "finished" : "live"}
            </span>
            <span className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#7e90ac]">every agent, one stream</span>
            <label className="ml-auto flex items-center gap-1.5 text-[11px] text-[#7e90ac]">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              follow
            </label>
            <span className="font-mono text-[11px] text-[#7e90ac]">{state.events.length}</span>
          </div>
          <div ref={box} className="term-text h-[560px] overflow-auto px-3.5 py-3 font-mono text-[11.5px] leading-[1.7]">
            {state.events.map((e) => {
              const child = childAgent.get(e.runId);
              return (
                <div key={e.id} className="flex gap-2.5 whitespace-pre-wrap break-words">
                  <span className="shrink-0 text-[#54657f]">{clock(e.ts, start)}</span>
                  <span className="w-[112px] shrink-0 truncate font-medium text-[#8ca9ff]" title={child ? `${child.agent} ${child.storyKey}` : e.source}>
                    {child?.storyKey ? `${child.storyKey}·` : ""}
                    {e.source}
                  </span>
                  <span className={LEVEL[e.level as keyof typeof LEVEL] ?? LEVEL.info}>{e.message}</span>
                </div>
              );
            })}
            {!done && <span className="cursor inline-block h-3 w-[7px] -mb-0.5 bg-[#8ca9ff]" />}
          </div>
        </div>

        {/* ----------------------------------------------------- lessons used -- */}
        <Card>
          <CardHeader title="Memory applied this cycle">
            <Pill tone="accent" dot={false}>{out?.applied.length ?? 0}</Pill>
          </CardHeader>
          <CardBody>
            {!out?.applied.length ? (
              <Sub>No lessons yet — this cycle is the baseline the next one learns from.</Sub>
            ) : (
              <ul className="grid gap-2">
                {out.applied.map((a) => (
                  <li key={`${a.scope}-${a.key}`} className="text-[12px] leading-[1.5]">
                    <span className="font-mono text-[11px] text-accent">{a.scope}</span>{" "}
                    <span className="font-mono text-[11px] text-muted">({a.confidence.toFixed(2)})</span> — {a.rule}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* ------------------------------------------------------ test board -- */}
        <Card>
          <CardHeader title="Stories & tests">
            <Sub>first run → after heal</Sub>
          </CardHeader>
          <CardBody className="grid gap-3">
            {!out?.stories.length && <Sub>Waiting for the pipelines…</Sub>}
            {out?.stories.map((s) => (
              <div key={s.key}>
                <div className="flex flex-wrap items-center gap-2">
                  <b className="font-mono text-[12px]">{s.key}</b>
                  <span className="min-w-0 truncate text-[12px] text-ink-2">{s.title}</span>
                  <Pill tone={PIPE_TONE[s.pipeline as keyof typeof PIPE_TONE] ?? "idle"} className="ml-auto">
                    {s.pipeline.replace("_", " ")}
                  </Pill>
                  <Link href={`/runs/${s.pipelineRunId}`} className="text-[11px] font-semibold text-accent hover:underline">
                    pipeline ↗
                  </Link>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {out.tests
                    .filter((t) => t.storyKey === s.key)
                    .map((t, i) => (
                      <TestChip key={`${t.name}-${i}`} t={t} />
                    ))}
                </div>
              </div>
            ))}
          </CardBody>
        </Card>
      </div>

      {/* ------------------------------------------------ requirements review -- */}
      {out?.review && (
        <Card>
          <CardHeader title="Review against requirements">
            <Pill tone={VERDICT_TONE[out.review.verdict]}>{out.review.verdict}</Pill>
            <Sub>{out.review.summary}</Sub>
          </CardHeader>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-[12px]">
              <thead>
                <tr className="border-b border-line-soft text-muted">
                  <th className="px-4 py-2 font-semibold">Story</th>
                  <th className="px-2 py-2 font-semibold">Acceptance criterion</th>
                  <th className="px-2 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">Evidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {out.review.criteria.map((c, i) => (
                  <tr key={i} className="align-top">
                    <td className="px-4 py-2 font-mono">{c.storyKey}</td>
                    <td className="px-2 py-2">{c.criterion}</td>
                    <td className="px-2 py-2">
                      <Pill tone={CRITERION_TONE[c.status]}>{c.status}</Pill>
                    </td>
                    <td className="px-4 py-2 text-ink-2">{c.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ------------------------------------------------------------ report -- */}
        {out?.report && (
          <Card>
            <CardHeader title="Report" />
            <CardBody className="grid gap-3">
              <p className="text-[14px] font-semibold leading-[1.45]">{out.report.headline}</p>
              <p className="text-[12.5px] leading-[1.6] text-ink-2">{out.report.summary}</p>
              <List label="Highlights" items={out.report.highlights} />
              <List label="Risks" items={out.report.risks} />
              <List label="Next actions" items={out.report.nextActions} />
            </CardBody>
          </Card>
        )}

        {/* ---------------------------------------------------------- learning -- */}
        {out?.learning && (
          <Card>
            <CardHeader title="What this cycle learned">
              <Link href="/autopilot" className="ml-auto text-[11.5px] font-semibold text-accent hover:underline">
                Memory →
              </Link>
            </CardHeader>
            <CardBody className="grid gap-3">
              <p className="text-[12.5px] leading-[1.6]">{out.learning.summary}</p>
              <KeyList label="New lessons" tone="pass" keys={out.learning.created} />
              <KeyList label="Confirmed — applied, and the problem stayed away" tone="pass" keys={out.learning.confirmed} />
              <KeyList label="Reinforced — seen again" tone="accent" keys={out.learning.reinforced} />
              <KeyList label="Contradicted — applied, but the problem came back" tone="heal" keys={out.learning.contradicted} />
              <KeyList label="Retired" tone="idle" keys={out.learning.retired} />
              <KeyList label="Resolved — the defect no longer reproduces" tone="pass" keys={out.learning.resolved ?? []} />
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

function clock(ts: string, start: number) {
  const s = Math.max(0, Math.floor((new Date(ts).getTime() - start) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone?: "pass" | "fail" | "heal" }) {
  const color = tone ? { pass: "text-pass", fail: "text-fail", heal: "text-heal" }[tone] : "";
  return (
    <div className="border-b border-r border-line-soft px-4 py-3">
      <div className={cn("font-display text-[22px] font-bold leading-none tracking-[-0.03em] tnum", color)}>{value}</div>
      <div className="mt-1 text-[11px] text-muted">{label}</div>
    </div>
  );
}

function TestChip({ t }: { t: TestResult }) {
  const [glyph, cls, what] =
    t.final === "passed"
      ? ["✓", "border-pass/30 bg-pass-soft text-pass", "passed first time"]
      : t.final === "healed"
        ? ["✚", "border-heal/30 bg-heal-soft text-heal", `failed (${t.heals.map((h) => h.category).join(", ")}), healed, now green`]
        : ["✗", "border-fail/30 bg-fail-soft text-fail", t.cause === "app-bug" ? "application defect — test kept as written" : "still failing"];
  return (
    <span
      title={`${t.name}\ncovers: ${t.criterion}\n${what}${t.final === "failed" && t.failure ? `\n\n${t.failure}` : ""}`}
      className={cn("inline-grid size-[22px] cursor-default place-items-center rounded-[5px] border font-mono text-[11px] font-bold", cls)}
    >
      {glyph}
    </span>
  );
}

function List({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <Label>{label}</Label>
      <ul className="mt-1 list-disc pl-4 text-[12px] leading-[1.6]">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function KeyList({ label, keys, tone }: { label: string; keys: string[]; tone: "pass" | "accent" | "heal" | "idle" }) {
  if (!keys.length) return null;
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {keys.map((k) => (
          <Pill key={k} tone={tone} dot={false}>
            <code className="font-mono">{k}</code>
          </Pill>
        ))}
      </div>
    </div>
  );
}
