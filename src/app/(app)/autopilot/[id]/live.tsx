"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Card, CardHeader, CardBody, Pill, Sub, Label, Button } from "@/components/ui";
import { PHASES } from "@/lib/agents/autopilot-phases";
import type { CycleOutput, TestResult } from "@/lib/agents/autopilot";
import type { LiveState as ServerLiveState } from "@/lib/agents/autopilot-live";
import { publish, stopAutopilot } from "../../actions";
import { AgentMap } from "./agent-map";

export type LiveState = Omit<ServerLiveState, "output"> & { output: CycleOutput | null };

const STAGE_TONE = { passed: "pass", running: "live", blocked: "heal", failed: "fail", skipped: "idle", pending: "idle" } as const;
const CRITERION_TONE = { met: "pass", "not-met": "fail", untested: "heal", blocked: "idle" } as const;
const VERDICT_TONE = { accept: "pass", "accept-with-risks": "heal", reject: "fail" } as const;
const PIPE_TONE = { needs_review: "pass", running: "live", blocked: "heal", failed: "fail" } as const;

const pct = (n: number) => `${Math.round(n * 100)}%`;
const SUB_AGENTS = new Set(["story-analyzer", "clarify", "asset-resolver", "spec-author", "verifier", "reviewer"]);

export function CycleLive({ runId, initial }: { runId: string; initial: LiveState }) {
  const [state, setState] = useState<LiveState>(initial);
  const [chase, setChase] = useState(true);
  const router = useRouter();
  const done = state.status !== "running" && state.status !== "queued";
  // A multi-cycle run keeps going after this cycle; keep polling until the next one exists.
  const campaignOpen =
    Boolean(state.campaign) && !state.campaign?.next && state.status === "succeeded" && !state.output?.stable && !state.stopRequested;

  // A server action (approve a bug, stop) re-renders the page; take its fresher state.
  useEffect(() => {
    setState((prev) => ({ ...initial, events: prev.events.length > initial.events.length ? prev.events : initial.events }));
  }, [initial]);

  // Follow a multi-cycle run onto its next cycle.
  useEffect(() => {
    const next = state.campaign?.next;
    if (!done || !next || !chase) return;
    const t = setTimeout(() => router.push(`/autopilot/${next}`), 2500);
    return () => clearTimeout(t);
  }, [done, chase, state.campaign?.next, router]);

  useEffect(() => {
    if (done && !campaignOpen) return;
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
  }, [runId, done, campaignOpen, state.events]);

  const out = state.output;
  const m = out?.metrics;
  // Between phases nothing is "running" for a moment; name the phase that is about to start.
  const active = (state.stages.find((s) => s.status === "running") ?? state.stages.find((s) => s.status === "pending"))?.agent;
  const lastSub = [...state.events].reverse().find((e) => SUB_AGENTS.has(e.source))?.source ?? "";
  const bugs = out?.bugs ?? [];

  return (
    <div className="grid gap-4">
      {state.error && (
        <div className="rounded-[10px] border border-fail/30 bg-fail-soft px-4 py-3 text-[12.5px] text-fail">{state.error}</div>
      )}

      {/* ---------------------------------------------------------- campaign -- */}
      {state.campaign && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-accent-line bg-accent-soft px-4 py-2.5">
          <b className="text-[12.5px] text-accent">Run until stable</b>
          <span className="text-[12px] text-ink-2">
            cycle {state.campaign.index} of at most {state.campaign.max}
          </span>
          <ol className="flex items-center gap-1">
            {state.campaign.cycles.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/autopilot/${c.id}`}
                  aria-current={c.id === runId ? "page" : undefined}
                  title={`cycle ${c.cycle}: ${c.status}${c.stable ? " · stable" : ""}`}
                  className={cn(
                    "grid h-[22px] min-w-[22px] place-items-center rounded-[6px] border px-1 font-mono text-[11px] font-semibold",
                    c.id === runId ? "border-accent bg-accent text-accent-ink" : "border-line bg-surface text-ink-2",
                    c.status === "running" && c.id !== runId && "border-live text-live"
                  )}
                >
                  {c.cycle}
                </Link>
              </li>
            ))}
          </ol>
          <span className="text-[12px] text-ink-2">
            {out?.stable
              ? "Stable — nothing new to learn, so no further cycle starts."
              : state.campaign.next
                ? chase
                  ? "Next cycle started — following it…"
                  : "Next cycle started."
                : state.stopRequested
                  ? "Stopping after this cycle."
                  : done && state.status === "succeeded"
                    ? "Deciding whether another cycle is worth running…"
                    : "Stops by itself once a cycle learns nothing new."}
          </span>
          <label className="ml-auto flex items-center gap-1.5 text-[11.5px] text-ink-2">
            <input type="checkbox" checked={chase} onChange={(e) => setChase(e.target.checked)} />
            follow to the next cycle
          </label>
          {!done && !state.stopRequested && (
            <form action={stopAutopilot.bind(null, runId)}>
              <Button size="sm">Stop after this cycle</Button>
            </form>
          )}
        </div>
      )}

      {/* --------------------------------------------------------- agent map -- */}
      <Card>
        <CardHeader title="Agents at work">
          <Sub>who holds the work right now, and what each one produced</Sub>
        </CardHeader>
        <CardBody className="blueprint py-3">
          <AgentMap stages={state.stages} output={out} lastSource={lastSub} />
        </CardBody>
      </Card>

      {/* ------------------------------------------------------------ phases -- */}
      <Card>
        <CardHeader title="Cycle">
          {done ? (
            <Pill tone={state.status === "succeeded" ? "pass" : "fail"}>{state.status}</Pill>
          ) : state.status === "queued" ? (
            <Pill tone="idle">queued — waiting for a worker</Pill>
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

      <div className="grid items-start gap-4">
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

      {/* -------------------------------------------------------------- bugs -- */}
      {bugs.length > 0 && (
        <Card>
          <CardHeader title="Application defects → Jira">
            <Sub>Each defect is proposed once. Nothing is filed until you approve it.</Sub>
          </CardHeader>
          <ul className="divide-y divide-line-soft">
            {bugs.map((b) => {
              const pub = state.publications[b.publicationId];
              const filed = pub?.status === "published" || b.status === "filed";
              const key = pub?.key || b.jiraKey;
              return (
                <li key={b.publicationId} className="grid gap-1.5 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <b className="font-mono text-[12px]">{b.storyKey}</b>
                      <span className="text-[12.5px]">{b.criterion}</span>
                    </div>
                    <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-[1.55] text-muted">{b.failure}</pre>
                    {pub?.error && <p className="mt-1 text-[12px] text-fail">{pub.error}</p>}
                  </div>
                  <div className="flex items-center gap-2 sm:justify-end">
                    {filed ? (
                      <Pill tone="pass">filed{key ? ` · ${key}` : ""}</Pill>
                    ) : b.status === "pending" ? (
                      <Pill tone="heal">proposed in an earlier cycle</Pill>
                    ) : (
                      <Pill tone="heal">proposed</Pill>
                    )}
                    {!filed && (
                      <form action={publish.bind(null, b.publicationId)}>
                        <Button size="sm" variant="primary">
                          File in Jira
                        </Button>
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
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
            <CardHeader title="What this cycle learned" />
            <CardBody className="grid gap-3">
              <p className="text-[12.5px] leading-[1.6]">{out.learning.summary}</p>
              <KeyList label="New lessons" tone="pass" keys={out.learning.created.filter((k) => !(out.learning?.proposed ?? []).includes(k))} />
              <KeyList label="Proposed — waiting for your approval before any agent uses them" tone="heal" keys={out.learning.proposed ?? []} />
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
