import type { ReactNode } from "react";
import { cn } from "../utils/cn";

export function Panel({
  className,
  children,
  title,
  hint,
  action,
}: {
  className?: string;
  children: ReactNode;
  title?: string;
  hint?: string;
  action?: ReactNode;
}) {
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

export function Toggle({
  value,
  onChange,
  label,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  label?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={value}
      aria-label={label}
      onClick={() => onChange(!value)}
      className={cn(
        "relative h-[22px] w-[40px] rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#e5a93c]/50",
        value ? "bg-[#e5a93c]" : "bg-[#2a2620]",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] h-[18px] w-[18px] rounded-full shadow-[0_1px_3px_rgba(0,0,0,0.6)] transition-transform duration-200",
          value ? "translate-x-[20px] bg-[#0e0d0b]" : "translate-x-[2px] bg-[#9a9080]",
        )}
      />
    </button>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className={cn(
        "rounded-lg border border-[var(--color-line)] bg-[#14120f] px-2.5 py-1.5 text-[12px] font-500 text-[var(--color-ink-2)] outline-none transition-colors hover:border-[#3d362c] focus:border-[#e5a93c]",
        className,
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} className="bg-[#14120f] text-[var(--color-ink)]">
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
    "w-full rounded-lg border border-[var(--color-line)] bg-[#12100d] px-3 py-2 text-[12.5px] text-[var(--color-ink)] placeholder:text-[var(--color-faint)] outline-none transition-all focus:border-[#e5a93c] focus:shadow-[0_0_0_3px_rgba(229,169,60,0.15)]",
    mono && "font-mono text-[11.5px]",
    className,
  );
  if (multiline) {
    return (
      <textarea
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(cls, "resize-none")}
        rows={3}
      />
    );
  }
  return (
    <input
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      className={cls}
    />
  );
}

export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-[86px] rounded-lg border border-[var(--color-line)] bg-[#12100d] px-2 py-1.5 text-right font-mono text-[12px] tabular text-[var(--color-ink)] outline-none focus:border-[#e5a93c]"
      />
      {suffix && <span className="font-mono text-[11px] text-[var(--color-muted)]">{suffix}</span>}
    </div>
  );
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-[132px] cursor-pointer appearance-none rounded-full bg-[#2a2620] accent-[#e5a93c]"
      />
      <span className="w-9 text-right font-mono text-[11px] tabular text-[var(--color-muted)]">
        {value.toFixed(2)}
      </span>
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
    default:
      "bg-[#1e1b17] text-[var(--color-ink-2)] border-[var(--color-line)] hover:border-[#3d372e] hover:bg-[#25211c] shadow-[0_1px_2px_rgba(0,0,0,0.4)]",
    primary:
      "bg-[#e5a93c] text-[#0e0d0b] font-600 border-[#e5a93c] hover:bg-[#f2be5c] shadow-[0_4px_14px_-3px_rgba(229,169,60,0.45)]",
    danger:
      "bg-[#e11d48] text-white border-[#e11d48] hover:bg-[#f43f5e] shadow-[0_2px_10px_-2px_rgba(225,29,72,0.5)]",
    warn: "bg-[#d97706] text-[#0e0d0b] font-600 border-[#d97706] hover:bg-[#f59e0b]",
    outline: "bg-transparent text-[var(--color-ink-2)] border-[var(--color-line)] hover:border-[#e5a93c]/50 hover:bg-[#1a1814]",
    ghost:
      "bg-transparent text-[var(--color-muted)] border-transparent hover:bg-[#1e1b17] hover:text-[var(--color-ink)]",
  };
  const sizes = {
    xs: "px-2 py-1 text-[11px] rounded-md",
    sm: "px-2.5 py-1.5 text-[11.5px] rounded-lg",
    md: "px-3.5 py-2 text-[12.5px] rounded-lg",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 border font-500 transition-all duration-150 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#e5a93c]/40",
        sizes[size],
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

type Tone = "slate" | "green" | "amber" | "rose" | "pine" | "indigo" | "gold";

const TONES: Record<Tone, string> = {
  slate: "bg-[#1e1b17] text-[var(--color-muted)] ring-[#2e2922]",
  green: "bg-[rgba(45,212,191,0.12)] text-[#2dd4bf] ring-[rgba(45,212,191,0.28)]",
  pine: "bg-[rgba(229,169,60,0.14)] text-[#e5a93c] ring-[rgba(229,169,60,0.3)]",
  gold: "bg-[rgba(229,169,60,0.16)] text-[#f2be5c] ring-[rgba(229,169,60,0.34)]",
  amber: "bg-[rgba(245,158,11,0.14)] text-[#fbbf24] ring-[rgba(245,158,11,0.28)]",
  rose: "bg-[rgba(244,63,94,0.15)] text-[#fb7185] ring-[rgba(244,63,94,0.3)]",
  indigo: "bg-[rgba(129,140,248,0.14)] text-[#a5b4fc] ring-[rgba(129,140,248,0.28)]",
};

export function Badge({
  children,
  tone = "slate",
  className,
  dot,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  dot?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] font-mono text-[10px] font-500 uppercase tracking-[0.06em] ring-1",
        TONES[tone],
        className,
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-[5px] border border-[var(--color-line)] border-b-2 bg-[#1a1814] px-1.5 py-[1px] font-mono text-[10px] font-500 text-[#e5a93c]">
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
      <div
        className={cn(
          "mt-1 font-mono text-[13px] font-500",
          tone === "green"
            ? "text-[#2dd4bf]"
            : tone === "rose"
              ? "text-[#fb7185]"
              : tone === "amber"
                ? "text-[#fbbf24]"
                : tone === "pine" || tone === "gold"
                  ? "text-[#e5a93c]"
                  : "text-[var(--color-ink)]",
        )}
      >
        {value}
      </div>
    </div>
  );
}
