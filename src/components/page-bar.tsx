import { Pill } from "@/components/ui";

export function PageBar({
  crumb,
  title,
  live,
  children,
}: {
  crumb: string;
  title: string;
  live?: number;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
      <div className="min-w-0">
        <div className="truncate font-mono text-[12px] text-muted">{crumb}</div>
        <h2 className="text-[16px] tracking-[-0.025em]">{title}</h2>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {live ? <Pill tone="live">{live} {live === 1 ? "run" : "runs"} live</Pill> : null}
        {children}
      </div>
    </header>
  );
}

export function Pane({ children }: { children: React.ReactNode }) {
  return <div className="min-h-0 flex-1 overflow-auto p-5">{children}</div>;
}
