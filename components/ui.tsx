"use client";

import { useEffect, useState } from "react";

export function short(addr: string) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";
}

export function eth(n: number) {
  if (n === 0) return "0";
  return n < 0.001 ? n.toFixed(6) : n.toFixed(4);
}

export function fmtInstalls(n: number) {
  if (!n) return "—";
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export const ROLE = {
  seller: { label: "Researcher", color: "#FF3B4A", blurb: "Found the malware. Sells it sealed." },
  buyer: { label: "Vendor", color: "#D4D4DC", blurb: "Buys from the grade alone." },
  oracle: { label: "Oracle", color: "#F5B841", blurb: "Detonates the repro, signs the effects." },
  arbiter: { label: "Arbiter", color: "#A855F7", blurb: "Re-detonates to rule on a challenge." },
  chain: { label: "Chain", color: "#63636E", blurb: "Enforces the rules." },
  system: { label: "System", color: "#63636E", blurb: "" },
} as const;

export type Tone = "neutral" | "good" | "warn" | "bad" | "red" | "white";

export function Chip({ children, tone = "neutral" }: { children: React.ReactNode; tone?: Tone }) {
  const tones: Record<Tone, string> = {
    neutral: "text-dim border-line2",
    good: "text-emerald-300 border-emerald-400/35",
    warn: "text-amber-300 border-amber-400/35",
    bad: "text-red-bright border-red/50",
    red: "text-red-bright border-red/50",
    white: "text-txt border-white/30",
  };
  return (
    <span className={`inline-flex items-center gap-2 mono text-[10.5px] tracking-[0.08em] uppercase px-2.5 py-[4px] rounded border whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Eyebrow({ children, tone = "red" }: { children: React.ReactNode; tone?: "red" | "dim" }) {
  return (
    <div className={`mono text-[11px] uppercase tracking-[0.18em] ${tone === "red" ? "text-red-bright" : "text-faint"}`}>
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  busy,
  disabled,
  variant = "primary",
  size = "md",
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  title?: string;
}) {
  const variants: Record<string, string> = {
    primary: "bg-red text-white font-semibold hover:bg-red-bright shadow-[0_0_0_1px_rgba(255,59,74,.4),0_12px_40px_-12px_rgba(229,32,46,.8)]",
    secondary: "bg-transparent text-txt shadow-[inset_0_0_0_1px_#2A2A32] hover:shadow-[inset_0_0_0_1px_#4a4a55] hover:bg-white/[0.03]",
    ghost: "bg-transparent text-dim hover:bg-white/5 hover:text-txt",
    danger: "bg-transparent text-red-bright shadow-[inset_0_0_0_1px_rgba(229,32,46,.5)] hover:bg-red/10",
  };
  const sizes: Record<string, string> = {
    sm: "text-[13px] h-9 px-3.5 rounded-md",
    md: "text-[14px] h-11 px-5 rounded-md",
    lg: "text-[15px] h-12 px-6 rounded-md",
  };
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-2.5 transition-all disabled:opacity-35 disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]}`}
    >
      {busy && <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ children, className = "", active }: { children: React.ReactNode; className?: string; active?: boolean }) {
  return (
    <div className={`bg-surface border rounded-lg ${active ? "border-red/40 shadow-red reticle" : "border-line"} ${className}`}>
      {children}
    </div>
  );
}

/** Countdown that ticks locally from a server-provided timestamp. */
export function useTick(start: number) {
  const [n, setN] = useState(start);
  useEffect(() => setN(start), [start]);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return n;
}

export function TimeLeft({ to, now }: { to: number | null; now: number }) {
  if (!to) return null;
  const left = to - now;
  if (left <= 0) return <span className="text-emerald-300 font-medium mono">READY</span>;
  const m = Math.floor(left / 60);
  const s = left % 60;
  return (
    <span className="tabular-nums text-txt font-semibold mono">
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

export function WindowBar({ start, end, now }: { start: number; end: number; now: number }) {
  const pct = Math.max(0, Math.min(100, ((now - start) / Math.max(1, end - start)) * 100));
  return (
    <div className="h-1 bg-white/[0.06] rounded-full overflow-hidden">
      <div className="h-full bg-gradient-to-r from-red-deep to-red-bright transition-all duration-1000" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** How alarming an effects bitmask is, by which effects are present. */
export function effectTone(effects: number): string {
  if (effects & 3) return "#FF3B4A"; // credential / env exfiltration
  if (effects & (16 | 32)) return "#F5B841"; // spawn / write
  if (effects & 4) return "#F5B841"; // network egress
  return "#D4D4DC";
}

/** The number of distinct effects a finding exhibits, out of the seven possible. */
export function effectCount(effects: number): number {
  let c = 0;
  for (let b = 1; b <= 64; b <<= 1) if (effects & b) c++;
  return c;
}

/** A ring showing how many of the seven observable effects fired. */
export function EffectRing({ effects, size = 92 }: { effects: number; size?: number }) {
  const color = effectTone(effects);
  const count = effectCount(effects);
  const r = 40;
  const circ = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 92 92" className="w-full h-full -rotate-90">
        <circle cx="46" cy="46" r={r} fill="none" stroke="#1C1C22" strokeWidth="6" />
        <circle cx="46" cy="46" r={r} fill="none" stroke={color} strokeWidth="6" strokeDasharray={circ}
          strokeDashoffset={circ - (circ * count) / 7}
          style={{ transition: "stroke-dashoffset .6s ease", filter: `drop-shadow(0 0 6px ${color}99)` }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
        <span className="mono font-bold leading-none" style={{ color, fontSize: size * 0.3 }}>{count}</span>
        <span className="mono text-[8px] tracking-[0.18em] uppercase text-faint">effects</span>
      </div>
    </div>
  );
}

/** Labelled chips for each observed effect. */
export function EffectTags({ labels, max }: { labels: string[]; max?: number }) {
  const shown = max ? labels.slice(0, max) : labels;
  const extra = max && labels.length > max ? labels.length - max : 0;
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((l) => (
        <span key={l} className="mono text-[10px] tracking-[0.04em] px-2 py-[3px] rounded border border-red/40 text-red-bright whitespace-nowrap">{l}</span>
      ))}
      {extra > 0 && <span className="mono text-[10px] px-2 py-[3px] text-faint">+{extra}</span>}
    </div>
  );
}

/** A labelled fact with an explanation of what the number means. */
export function Fact({ label, value, unit, hint, tone }: { label: string; value: React.ReactNode; unit?: string; hint?: string; tone?: string }) {
  return (
    <div className="bg-surface border border-line rounded-md px-4 py-3.5 flex flex-col gap-1.5">
      <div className="mono text-[10px] tracking-[0.14em] uppercase text-faint">{label}</div>
      <div className="mono text-[20px] font-bold leading-none" style={{ color: tone }}>
        {value} {unit && <span className="text-[11px] font-normal text-faint">{unit}</span>}
      </div>
      {hint && <div className="text-[11px] text-faint leading-snug">{hint}</div>}
    </div>
  );
}

export function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 mono text-[11px] py-1.5">
      <span className="text-faint shrink-0">{k}</span>
      <span className="text-dim break-all text-right">{v}</span>
    </div>
  );
}

/* icons: stroke-based, 24 grid */
export const Icon = {
  Grid: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="8" height="8" rx="1" /><rect x="13" y="3" width="8" height="8" rx="1" /><rect x="3" y="13" width="8" height="8" rx="1" /><rect x="13" y="13" width="8" height="8" rx="1" /></svg>
  ),
  Play: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M5 4l14 8-14 8z" /></svg>,
  List: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 6h16M4 12h16M4 18h16" /></svg>,
  Shield: () => (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3 4 6.5v5c0 4.6 3.4 8.4 8 9.5 4.6-1.1 8-4.9 8-9.5v-5L12 3Z" /></svg>
  ),
  Terminal: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 17l6-5-6-5M12 19h8" /></svg>,
  Lock: ({ className = "" }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="11" width="14" height="10" rx="1.5" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
  ),
  Unlock: ({ className = "" }: { className?: string }) => (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="11" width="14" height="10" rx="1.5" /><path d="M8 11V7a4 4 0 0 1 7.5-2" /></svg>
  ),
  Arrow: () => <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>,
  Upload: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></svg>,
  Wallet: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 14h2"/></svg>,
};
