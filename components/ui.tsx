"use client";

import { useEffect, useState } from "react";

export function short(addr: string) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";
}

export function eth(n: number) {
  if (n === 0) return "0";
  return n < 0.001 ? n.toFixed(6) : n.toFixed(4);
}

export const ROLE = {
  seller: { label: "Researcher", color: "#F59E0B", blurb: "finds and sells the bug" },
  buyer: { label: "Security vendor", color: "#38BDF8", blurb: "buys intel sight-unseen" },
  oracle: { label: "Verifier", color: "#A78BFA", blurb: "grades it, settles disputes" },
  chain: { label: "Chain", color: "#5C6B85", blurb: "" },
  system: { label: "System", color: "#34D399", blurb: "" },
} as const;

export function Chip({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "good" | "warn" | "bad" | "info" | "brand";
}) {
  const tones: Record<string, string> = {
    neutral: "bg-white/5 text-dim border-line2",
    good: "bg-emerald-400/10 text-emerald-300 border-emerald-400/25",
    warn: "bg-amber-400/10 text-amber-300 border-amber-400/25",
    bad: "bg-rose-400/10 text-rose-300 border-rose-400/25",
    info: "bg-sky-400/10 text-sky-300 border-sky-400/25",
    brand: "bg-cyan-400/10 text-cyan-300 border-cyan-400/25",
  };
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  busy,
  disabled,
  variant = "primary",
  size = "md",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
}) {
  const variants: Record<string, string> = {
    primary:
      "bg-gradient-to-b from-cyan-400 to-cyan-500 text-[#04222a] font-semibold hover:from-cyan-300 hover:to-cyan-400 border-transparent shadow-lg shadow-cyan-500/20",
    secondary: "bg-white/[0.06] text-txt border-line2 hover:bg-white/[0.1]",
    ghost: "bg-transparent text-dim border-transparent hover:bg-white/5 hover:text-txt",
    danger: "bg-rose-500/10 text-rose-200 border-rose-500/30 hover:bg-rose-500/20",
  };
  const sizes: Record<string, string> = {
    sm: "text-[12px] px-2.5 py-1.5 rounded-lg",
    md: "text-[13px] px-3.5 py-2 rounded-lg",
    lg: "text-[14px] px-5 py-2.5 rounded-xl",
  };
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className={`inline-flex items-center justify-center gap-2 border transition-all disabled:opacity-40 disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]}`}
    >
      {busy && (
        <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />
      )}
      {children}
    </button>
  );
}

export function Card({
  children,
  className = "",
  glow,
}: {
  children: React.ReactNode;
  className?: string;
  glow?: boolean;
}) {
  return (
    <div
      className={`bg-surface border rounded-2xl ${
        glow ? "border-cyan-400/30 shadow-xl shadow-cyan-500/5" : "border-line"
      } ${className}`}
    >
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
  if (left <= 0) return <span className="text-emerald-300 font-medium">ready now</span>;
  const m = Math.floor(left / 60);
  const s = left % 60;
  return (
    <span className="tabular-nums text-txt font-medium">
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

/** Horizontal progress bar for a time window. */
export function WindowBar({ start, end, now }: { start: number; end: number; now: number }) {
  const pct = Math.max(0, Math.min(100, ((now - start) / Math.max(1, end - start)) * 100));
  return (
    <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
      <div
        className="h-full bg-gradient-to-r from-cyan-400/70 to-cyan-300 transition-all duration-1000"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Circular severity gauge. */
export function SeverityRing({ value }: { value: number }) {
  const color = value >= 80 ? "#FB7185" : value >= 50 ? "#FBBF24" : value >= 25 ? "#FCD34D" : "#64748B";
  const r = 26;
  const circ = 2 * Math.PI * r;
  return (
    <div className="relative w-[68px] h-[68px] shrink-0">
      <svg viewBox="0 0 64 64" className="w-full h-full -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,.07)" strokeWidth="6" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ - (circ * value) / 100}
          style={{ transition: "stroke-dashoffset .6s ease" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[18px] font-bold leading-none" style={{ color }}>
          {value}
        </span>
        <span className="text-[8px] text-faint uppercase tracking-wider mt-0.5">severity</span>
      </div>
    </div>
  );
}

/** Collapsible section for the cryptographic detail most people don't need up front. */
export function Reveal({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(!open)}
        className="text-[11px] text-faint hover:text-dim inline-flex items-center gap-1 transition-colors"
      >
        <span className={`transition-transform ${open ? "rotate-90" : ""}`}>▸</span>
        {label}
      </button>
      {open && <div className="mt-2 rise">{children}</div>}
    </div>
  );
}

export function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px] py-0.5">
      <span className="text-faint w-24 shrink-0">{k}</span>
      <span className={`text-dim break-all ${mono ? "mono" : ""}`}>{v}</span>
    </div>
  );
}
