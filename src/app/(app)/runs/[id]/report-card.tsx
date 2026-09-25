import { Card, CardHeader, CardBody, Pill, Sub } from "@/components/ui";
import type { StoryReport } from "@/lib/agents/report";

const PRIORITY_TONE = { P1: "fail", P2: "heal", P3: "idle" } as const;

/** The strategy and traceability for one story: what each criterion gets, and whether it is covered. */
export function ReportCard({ runId, report }: { runId: string; report: StoryReport }) {
  const covered = report.criteria.filter((c) => c.covered).length;
  return (
    <Card className="mb-4">
      <CardHeader title="Test strategy & report">
        <Pill tone={covered === report.criteria.length && report.criteria.length ? "pass" : "heal"} dot={false}>
          {covered} / {report.criteria.length} criteria covered
        </Pill>
        <a href={`/api/runs/${runId}/report`} className="text-[12px] font-semibold text-accent hover:underline">
          Download report (.md)
        </a>
      </CardHeader>
      <CardBody className="grid gap-3.5">
        {report.approach && <p className="text-[12.5px] leading-[1.6] text-ink-2">{report.approach}</p>}
        {report.levels.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {report.levels.map((l) => (
              <span key={l.level} title={l.why} className="rounded-md border border-line-soft bg-surface-2 px-2 py-1 font-mono text-[11px]">
                {l.level} {l.share}%
              </span>
            ))}
          </div>
        )}
        {report.scopeNotes.length > 0 && (
          <div className="rounded-lg border border-heal/30 bg-heal-soft px-3 py-2">
            <div className="text-[11.5px] font-semibold text-heal">Scope changed in comments</div>
            <ul className="mt-1 grid gap-1">
              {report.scopeNotes.map((n) => (
                <li key={n} className="text-[12px] leading-[1.5] text-heal">{n}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-left text-[12px]">
            <thead>
              <tr className="border-b border-line text-[11px] text-muted">
                <th className="py-1.5 pr-2 font-medium">Criterion</th>
                <th className="py-1.5 pr-2 font-medium">Priority</th>
                <th className="py-1.5 pr-2 font-medium">Level</th>
                <th className="py-1.5 pr-2 font-medium">Techniques</th>
                <th className="py-1.5 pr-2 font-medium">Tests</th>
                <th className="py-1.5 font-medium">Covered</th>
              </tr>
            </thead>
            <tbody>
              {report.criteria.map((c, i) => (
                <tr key={i} className="border-b border-line-soft align-top">
                  <td className="py-2 pr-2 leading-[1.5]" title={c.why}>
                    {c.criterion.length > 180 ? `${c.criterion.slice(0, 180)}…` : c.criterion}
                    {c.preconditions.length > 0 && <Sub> Preconditions: {c.preconditions.join("; ")}</Sub>}
                  </td>
                  <td className="py-2 pr-2">
                    {c.priority && <Pill tone={PRIORITY_TONE[c.priority as keyof typeof PRIORITY_TONE] ?? "idle"} dot={false}>{c.priority}</Pill>}
                  </td>
                  <td className="py-2 pr-2 font-mono text-[11px]">
                    {c.level}
                    {!c.automate && " · manual"}
                  </td>
                  <td className="py-2 pr-2 font-mono text-[11px] text-muted">{c.techniques.join(", ")}</td>
                  <td className="py-2 pr-2 font-mono text-[11px]">
                    {c.newTests.length} new{c.existingTests.length ? ` · ${c.existingTests.join(", ")}` : ""}
                  </td>
                  <td className="py-2">{c.covered ? <Pill tone="pass">yes</Pill> : <Pill tone="fail">no</Pill>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {report.risks.length > 0 && (
          <div>
            <div className="text-[11.5px] font-semibold text-muted">Risks</div>
            <ul className="mt-1 grid gap-1">
              {report.risks.map((r) => (
                <li key={r.risk} className="text-[12px] leading-[1.5]">
                  {r.risk} <span className="text-muted">— {r.mitigation}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {report.nextSteps.length > 0 && (
          <div>
            <div className="text-[11.5px] font-semibold text-muted">Next steps</div>
            <ul className="mt-1 grid gap-1">
              {report.nextSteps.map((s) => (
                <li key={s} className="text-[12px] leading-[1.5]">{s}</li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
