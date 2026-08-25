import { cn } from "@/lib/utils";

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...p}
      className={cn("rounded-[10px] border border-line bg-surface shadow-[var(--shadow)]", className)}
    />
  );
}

export function CardHeader({
  title,
  children,
  className,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2.5 border-b border-line-soft px-4 py-3", className)}>
      <h3 className="text-[13.5px]">{title}</h3>
      {children}
    </div>
  );
}

export function CardBody({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div {...p} className={cn("p-4", className)} />;
}

type Tone = "pass" | "fail" | "heal" | "live" | "idle" | "accent";

const TONES: Record<Tone, string> = {
  pass: "bg-pass-soft text-pass border-pass/25",
  fail: "bg-fail-soft text-fail border-fail/25",
  heal: "bg-heal-soft text-heal border-heal/25",
  live: "bg-live-soft text-live border-live/25",
  idle: "bg-surface-3 text-muted border-line",
  accent: "bg-accent-soft text-accent border-accent-line",
};

export function Pill({
  tone = "idle",
  dot = true,
  children,
  className,
}: {
  tone?: Tone;
  dot?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-[2.5px] text-[11px] font-semibold",
        TONES[tone],
        className
      )}
    >
      {dot && <span className="size-[5px] shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Label({ className, ...p }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...p}
      className={cn("text-[10px] font-bold uppercase tracking-[0.13em] text-muted", className)}
    />
  );
}

export function Sub({ className, ...p }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p {...p} className={cn("text-[12.5px] leading-[1.5] text-muted", className)} />;
}

export function Meter({ value, tone = "accent" }: { value: number; tone?: "accent" | "pass" | "live" | "heal" }) {
  const bg = { accent: "bg-accent", pass: "bg-pass", live: "bg-live", heal: "bg-heal" }[tone];
  return (
    <div className="h-[5px] overflow-hidden rounded-full bg-surface-3">
      <div
        className={cn("h-full rounded-full transition-[width] duration-500", bg)}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function Stat({
  value,
  label,
  detail,
  tone,
}: {
  value: React.ReactNode;
  label: string;
  detail?: React.ReactNode;
  tone?: "pass" | "fail" | "heal";
}) {
  const color = tone ? { pass: "text-pass", fail: "text-fail", heal: "text-heal" }[tone] : "";
  return (
    <div className="border-r border-line-soft px-4 py-3.5 last:border-r-0">
      <div className={cn("font-display text-[25px] font-bold leading-none tracking-[-0.03em] tnum", color)}>
        {value}
      </div>
      <div className="mt-1 text-[11px] text-muted">{label}</div>
      {detail != null && <div className="mt-1 font-mono text-[11px]">{detail}</div>}
    </div>
  );
}

export function StatRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-[10px] border border-line bg-surface md:grid-cols-4">
      {children}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center">
      <h3 className="text-[15px]">{title}</h3>
      {children && <div className="max-w-[46ch] text-[12.5px] leading-[1.6] text-muted">{children}</div>}
    </div>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost";
  size?: "sm" | "md";
};

const BTN_BASE =
  "inline-flex items-center justify-center gap-[7px] rounded-lg border font-semibold transition-[background,border-color,transform] active:translate-y-px disabled:pointer-events-none disabled:opacity-55";
const BTN_VARIANT = {
  default: "border-line bg-surface text-ink hover:bg-surface-3 hover:border-accent-line",
  primary: "border-accent bg-accent text-accent-ink hover:brightness-110",
  ghost: "border-transparent bg-transparent text-ink-2 hover:bg-surface-3 hover:text-ink",
};
const BTN_SIZE = { sm: "px-2.5 py-[5px] text-[11.5px] rounded-[7px]", md: "px-3.5 py-[7px] text-[12.5px]" };

export function Button({ variant = "default", size = "md", className, ...p }: BtnProps) {
  return <button {...p} className={cn(BTN_BASE, BTN_VARIANT[variant], BTN_SIZE[size], className)} />;
}

export function buttonClass(variant: keyof typeof BTN_VARIANT = "default", size: keyof typeof BTN_SIZE = "md") {
  return cn(BTN_BASE, BTN_VARIANT[variant], BTN_SIZE[size]);
}
