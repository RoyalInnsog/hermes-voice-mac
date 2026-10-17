import type { ReactNode } from "react";
import { cn } from "../utils/cn";

export function Panel({ className, children, title, hint, action }: { className?: string; children: ReactNode; title?: string; hint?: string; action?: ReactNode }) {
  return (
    <section className={cn("panel reveal flex min-h-0 flex-col", className)}>
      {title && (
        <header className="flex items-center gap-3 border-b border-[var(--color-line-soft)] px-4 py-2.5">
          <h2 className="font-display text-[13px] font-700 tracking-tight text-[var(--color-ink)]">{title}</h2>
          {hint && <span className="label-xs truncate">{hint}</span>}
          {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="mb-2.5 flex items-baseline justify-between gap-3">
      <h3 className="font-display text-[12.5px] font-700 tracking-tight text-[var(--color-ink)]">{children}</h3>
      {hint && <span className="label-xs">{hint}</span>}
    </div>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-5 border-b border-[var(--color-line-soft)] py-2.5 last:border-0">
      <div className="min-w-0">
        <div className="text-[13px] font-500 text-[var(--color-ink-2)]">{label}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-[var(--color-muted)]">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={() => onChange(!value)}
      className={cn(
        "relative h-[22px] w-[40px] rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-pine-bright)]/50",
        value ? "bg-[var(--color-pine)]" : "bg-[#cfd6e0]",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow-[0_1px_3px_rgba(15,19,25,0.3)] transition-transform duration-200",
          value ? "translate-x-[20px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

export function Select<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(
        "rounded-lg border border-[var(--color-line)] bg-white px-2.5 py-1.5 text-[12px] font-500 text-[var(--color-ink-2)] outline-none transition-colors hover:border-[#c6ceda] focus:border-[var(--color-pine-bright)]",
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
  mono,
  className,
  onKeyDown,
  multiline,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  multiline?: boolean;
}) {
  const cls = cn(
    "w-full rounded-lg border border-[var(--color-line)] bg-white px-3 py-2 text-[12.5px] text-[var(--color-ink)] placeholder:text-[var(--color-faint)] outline-none transition-all focus:border-[var(--color-pine-bright)] focus:shadow-[0_0_0_3px_rgba(15,156,138,0.12)]",
    mono && "font-mono text-[11.5px]",
    className,
  );
  if (multiline) return <textarea value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={cn(cls, "resize-none")} rows={3} />;
  return <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} className={cls} />;
}

export function NumberField({ value, onChange, min, max, step = 1, suffix }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-[86px] rounded-lg border border-[var(--color-line)] bg-white px-2 py-1.5 text-right font-mono text-[12px] tabular text-[var(--color-ink)] outline-none focus:border-[var(--color-pine-bright)]"
      />
      {suffix && <span className="font-mono text-[11px] text-[var(--color-muted)]">{suffix}</span>}
    </div>
  );
}

export function Slider({ value, onChange, min, max, step }: { value: number; onChange: (v: number) => void; min: number; max: number; step: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-[132px] cursor-pointer appearance-none rounded-full bg-[#dfe4ec] accent-[var(--color-pine)]"
      />
      <span className="w-9 text-right font-mono text-[11px] tabular text-[var(--color-muted)]">{value.toFixed(2)}</span>
    </div>
  );
}

type Variant = "default" | "primary" | "danger" | "ghost" | "warn" | "outline";

export function Button({
  children,
  onClick,
  variant = "default",
  size = "md",
  disabled,
  className,
  title,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: Variant;
  size?: "xs" | "sm" | "md";
  disabled?: boolean;
  className?: string;
  title?: string;
  type?: "button" | "submit";
}) {
  const variants: Record<Variant, string> = {
    default: "bg-white text-[var(--color-ink-2)] border-[var(--color-line)] hover:border-[#c2cad6] hover:bg-[var(--color-sunken)] shadow-[0_1px_2px_rgba(15,19,25,0.05)]",
    primary: "bg-[var(--color-pine)] text-white border-[var(--color-pine)] hover:bg-[#0a5d53] shadow-[0_2px_8px_-2px_rgba(11,107,96,0.55)]",
    danger: "bg-[var(--color-rose)] text-white border-[var(--color-rose)] hover:bg-[#96203a] shadow-[0_2px_8px_-2px_rgba(172,35,64,0.5)]",
    warn: "bg-[var(--color-amber)] text-white border-[var(--color-amber)] hover:bg-[#93570a]",
    outline: "bg-transparent text-[var(--color-ink-2)] border-[var(--color-line)] hover:bg-white",
    ghost: "bg-transparent text-[var(--color-muted)] border-transparent hover:bg-[rgba(15,19,25,0.05)] hover:text-[var(--color-ink)]",
  };
  const sizes = { xs: "px-2 py-1 text-[11px] rounded-md", sm: "px-2.5 py-1.5 text-[11.5px] rounded-lg", md: "px-3.5 py-2 text-[12.5px] rounded-lg" };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 border font-500 transition-all duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-pine-bright)]/40",
        sizes[size],
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

type Tone = "slate" | "green" | "amber" | "rose" | "pine" | "indigo";

const TONES: Record<Tone, string> = {
  slate: "bg-[rgba(15,19,25,0.05)] text-[var(--color-muted)] ring-[rgba(15,19,25,0.08)]",
  green: "bg-[var(--color-pine-wash)] text-[var(--color-pine)] ring-[rgba(11,107,96,0.18)]",
  pine: "bg-[var(--color-pine-wash)] text-[var(--color-pine)] ring-[rgba(11,107,96,0.18)]",
  amber: "bg-[var(--color-amber-wash)] text-[var(--color-amber)] ring-[rgba(169,101,10,0.2)]",
  rose: "bg-[var(--color-rose-wash)] text-[var(--color-rose)] ring-[rgba(172,35,64,0.18)]",
  indigo: "bg-[#e7ebfd] text-[var(--color-indigo-ink)] ring-[rgba(47,75,216,0.18)]",
};

export function Badge({ children, tone = "slate", className, dot }: { children: ReactNode; tone?: Tone; className?: string; dot?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] font-mono text-[10px] font-500 uppercase tracking-[0.06em] ring-1", TONES[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[5px] border border-[var(--color-line)] border-b-2 bg-white px-1.5 py-[1px] font-mono text-[10px] font-500 text-[var(--color-ink-2)]">
      {children}
    </kbd>
  );
}

export function Dot({ className, pulse }: { className?: string; pulse?: boolean }) {
  return (
    <span className="relative flex h-2 w-2">
      {pulse && <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-70", className)} />}
      <span className={cn("relative inline-flex h-2 w-2 rounded-full", className)} />
    </span>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <p className="font-display text-[14px] font-700 text-[var(--color-ink-2)]">{title}</p>
      {body && <p className="max-w-sm text-[12px] leading-relaxed text-[var(--color-muted)]">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, tone = "slate" }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <div className="panel-flat px-3 py-2">
      <div className="label-xs">{label}</div>
      <div className={cn("mt-1 font-mono text-[13px] font-500", tone === "green" ? "text-[var(--color-pine)]" : tone === "rose" ? "text-[var(--color-rose)]" : tone === "amber" ? "text-[var(--color-amber)]" : "text-[var(--color-ink)]")}>
        {value}
      </div>
    </div>
  );
}
