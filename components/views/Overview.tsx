"use client";

import { Button, Eyebrow, Icon, ROLE, effectCount } from "../ui";
import type { ViewProps } from "./types";

const FLOW = [
  { who: "oracle", t: "Detonate & grade", d: "Runs the seller's repro in an instrumented sandbox, records exactly what the package did, and signs the observed effects and trace. No severity score — just facts." },
  { who: "seller", t: "List as an auction", d: "Posts the sealed finding bonded by a stake, opening a Dutch auction and choosing how much of the price rides on the outcome being confirmed." },
  { who: "buyer", t: "Buy blind", d: "Reads only the observed effects, the one-line outcome, and the falling price, then pays. The contents stay encrypted." },
  { who: "seller", t: "Deliver", d: "Hands over the key. The buyer checks the hash matches what was graded, so a swap is impossible." },
  { who: "chain", t: "Disclose", d: "After the embargo the key is published on-chain. Free for everyone, forever." },
  { who: "oracle", t: "Confirm", d: "If an external advisory confirms the finding, the escrowed contingent share is released to the seller; if not, it returns to the buyer." },
] as const;

export default function Overview({ go, sandboxHash, listings }: ViewProps) {
  const topEffects = Math.max(0, ...listings.map((l) => effectCount(l.effects)));
  return (
    <div className="px-10 lg:px-20 pt-16 pb-24 max-w-[1300px]">
      <div className="grid lg:grid-cols-[1fr_420px] gap-12 items-center">
        <div className="flex flex-col gap-7">
          <Eyebrow>Sealed npm threat intel · detonated on-chain</Eyebrow>
          <h1 className="text-[52px] lg:text-[76px] leading-[0.98] font-bold tracking-[-0.035em]">
            Sell a zero-day<br />without <span className="text-red-bright">showing it.</span>
          </h1>
          <p className="text-[18px] leading-[1.55] text-dim max-w-[560px]" style={{ textWrap: "pretty" }}>
            A neutral oracle detonates each finding&apos;s repro in a sandbox and signs what the package actually did — before it can be listed. Buyers bid down a Dutch auction on the observed effects alone. Part of the price rides on the world later confirming the finding.
          </p>
          <div className="flex items-center gap-3.5 flex-wrap">
            <Button size="lg" onClick={() => go("trade")}>Run a trade <Icon.Arrow /></Button>
            <Button size="lg" variant="secondary" onClick={() => go("market")}>Browse the market</Button>
          </div>
        </div>
        <Emblem effects={topEffects} sandboxHash={sandboxHash} />
      </div>

      <section className="mt-24">
        <div className="flex items-end justify-between pb-6 border-b border-line">
          <div className="flex flex-col gap-2">
            <Eyebrow>How a trade works</Eyebrow>
            <h2 className="text-[30px] font-semibold tracking-[-0.02em]">Six steps. Every one on-chain.</h2>
          </div>
          <div className="mono text-[12px] text-faint hidden sm:block">colour = who is acting</div>
        </div>
        {FLOW.map((s, i) => {
          const role = ROLE[s.who];
          return (
            <div key={s.t} className={`grid grid-cols-[72px_1fr] sm:grid-cols-[110px_150px_1fr] items-center gap-6 py-7 ${i < FLOW.length - 1 ? "border-b border-line" : ""}`}>
              <div className="mono text-[40px] sm:text-[50px] font-bold text-line2 tracking-[-0.04em] leading-none">0{i + 1}</div>
              <div className="flex items-center gap-2 order-last sm:order-none col-span-2 sm:col-span-1">
                <span className="w-2 h-2 rounded-sm" style={{ background: role.color, boxShadow: `0 0 8px ${role.color}` }} />
                <span className="mono text-[11px] tracking-[0.14em] uppercase" style={{ color: role.color }}>{role.label}</span>
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="text-[20px] font-semibold">{s.t}</div>
                <div className="text-[14px] text-dim leading-relaxed">{s.d}</div>
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function Emblem({ effects, sandboxHash }: { effects: number; sandboxHash?: string }) {
  const circ = 2 * Math.PI * 150;
  const frac = effects / 7;
  return (
    <div className="hidden lg:block w-[420px] h-[420px] justify-self-end">
      <svg viewBox="0 0 440 440" className="w-full h-full" fill="none">
        <circle cx="220" cy="220" r="200" stroke="#1C1C22" strokeDasharray="2 6" />
        <circle cx="220" cy="220" r="150" stroke="#2A2A32" />
        <circle cx="220" cy="220" r="150" stroke="#FF3B4A" strokeWidth="2" strokeDasharray={`${circ * frac} ${circ}`} transform="rotate(-90 220 220)" style={{ filter: "drop-shadow(0 0 8px rgba(255,59,74,.7))" }} />
        <rect x="150" y="175" width="140" height="110" rx="6" stroke="#F2F2F4" strokeWidth="2" fill="#0B0B0E" />
        <path d="M150 185l70 55 70-55" stroke="#F2F2F4" strokeWidth="2" />
        <rect x="196" y="212" width="48" height="40" rx="4" fill="#050506" stroke="#FF3B4A" strokeWidth="2" />
        <path d="M204 212v-8a16 16 0 0 1 32 0v8" stroke="#FF3B4A" strokeWidth="2" />
        <circle cx="220" cy="232" r="4" fill="#FF3B4A" />
        <text x="220" y="330" textAnchor="middle" fill="#FF3B4A" fontFamily="JetBrains Mono, monospace" fontSize="30" fontWeight="700">{effects}/7</text>
        <text x="220" y="350" textAnchor="middle" fill="#63636E" fontFamily="JetBrains Mono, monospace" fontSize="10" letterSpacing="3">EFFECTS · OBSERVED</text>
        <text x="220" y="42" textAnchor="middle" fill="#63636E" fontFamily="JetBrains Mono, monospace" fontSize="10" letterSpacing="2">{sandboxHash?.slice(0, 10)} · sandbox</text>
        <text x="220" y="412" textAnchor="middle" fill="#63636E" fontFamily="JetBrains Mono, monospace" fontSize="10" letterSpacing="2">sealed · xchacha20</text>
      </svg>
    </div>
  );
}
