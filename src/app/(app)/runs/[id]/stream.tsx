"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type Ev = { id: string; ts: string | Date; level: string; source: string; message: string };

const LEVEL = {
  ok: "text-[#4fd494]",
  error: "text-[#ff9182]",
  warn: "text-[#f2b65e]",
  info: "text-[#c6d3e6]",
} as const;

function clock(ts: string | Date, start: number) {
  const t = new Date(ts).getTime() - start;
  const s = Math.max(0, Math.floor(t / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function RunStream({
  runId,
  initial,
  finished,
}: {
  runId: string;
  initial: Ev[];
  finished: boolean;
}) {
  const [events, setEvents] = useState<Ev[]>(initial);
  const [done, setDone] = useState(finished);
  const box = useRef<HTMLDivElement>(null);
  const start = initial.length ? new Date(initial[0].ts).getTime() : Date.now();

  useEffect(() => {
    if (done) return;
    let stop = false;
    const tick = async () => {
      try {
        const last = events[events.length - 1]?.id ?? "";
        const res = await fetch(`/api/runs/${runId}/events?after=${encodeURIComponent(last)}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { events: Ev[]; status: string };
        if (stop) return;
        if (data.events.length) setEvents((prev) => [...prev, ...data.events]);
        if (data.status !== "running") setDone(true);
      } catch {
        /* a dropped poll is not worth interrupting the page for */
      }
    };
    const t = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [runId, done, events]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [events.length]);

  return (
    <div className="term overflow-hidden rounded-[9px]">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3.5 py-2.5">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2 py-[2.5px] text-[11px] font-semibold",
            done
              ? "border-white/15 bg-white/5 text-[#9fb0c9]"
              : "border-[#5fc8ea]/30 bg-[#5fc8ea]/10 text-[#5fc8ea]"
          )}
        >
          <span className="size-[5px] rounded-full bg-current" />
          {done ? "finished" : "live"}
        </span>
        <span className="text-[10px] font-bold uppercase tracking-[0.13em] text-[#7e90ac]">
          agent stream
        </span>
        <span className="ml-auto font-mono text-[11px] text-[#7e90ac]">{events.length} lines</span>
      </div>

      <div ref={box} className="term-text h-[380px] overflow-auto px-3.5 py-3 font-mono text-[11.5px] leading-[1.75]">
        {events.length === 0 ? (
          <div className="text-[#7e90ac]">waiting for the first line…</div>
        ) : (
          events.map((e) => (
            <div key={e.id} className="flex gap-2.5 whitespace-pre-wrap break-words">
              <span className="shrink-0 text-[#54657f]">{clock(e.ts, start)}</span>
              <span className="shrink-0 font-medium text-[#8ca9ff]">{e.source}</span>
              <span className={LEVEL[e.level as keyof typeof LEVEL] ?? LEVEL.info}>{e.message}</span>
            </div>
          ))
        )}
        {!done && <span className="cursor inline-block h-3 w-[7px] -mb-0.5 bg-[#8ca9ff]" />}
      </div>
    </div>
  );
}
