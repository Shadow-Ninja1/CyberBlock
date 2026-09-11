"use client";

import type { ListingView } from "@/lib/view";
import { STEPS, statusCopy } from "../lifecycle";
import { Button, Card, Chip, Eyebrow, EffectRing, EffectTags, Fact, Icon, ROLE, TimeLeft, WindowBar, eth, fmtInstalls, short, type Tone } from "../ui";
import type { ViewProps } from "./types";

export default function Trade({ listings, now, busy, act, step, go }: ViewProps) {
  const active = step.listingId != null ? listings.find((l) => l.id === step.listingId) : undefined;
  const last = active ?? listings[0];
  const waiting = step.waitUntil != null && now < step.waitUntil;
  const role = ROLE[step.actor];
  const idx = step.done ? 7 : step.step;

  return (
    <div className="px-5 sm:px-10 lg:px-20 pt-10 pb-24 max-w-[1300px]">
      <div className="grid grid-cols-6 gap-2.5">
        {STEPS.map((s, i) => {
          const n = i + 1;
          const state = n < idx ? "done" : n === idx ? "now" : "todo";
          return (
            <div key={s} className="flex flex-col gap-2.5 min-w-0">
              <div className={`h-[3px] rounded-full ${state === "done" ? "bg-red" : state === "now" ? "bg-red-bright shadow-[0_0_12px_rgba(255,59,74,.9)]" : "bg-line"}`} />
              <div className={`mono text-[9.5px] tracking-[0.1em] uppercase truncate ${state === "now" ? "text-red-bright" : state === "done" ? "text-dim" : "text-faint"}`}>0{n} <span className="hidden sm:inline">{s} {state === "done" && "✓"}</span></div>
            </div>
          );
        })}
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_480px] gap-12 mt-14 items-start">
        <div className="flex flex-col gap-7 max-w-[600px] min-w-0">
          <div className="flex items-center gap-3">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ background: role.color, boxShadow: `0 0 10px ${role.color}` }} />
            <span className="mono text-[11px] tracking-[0.16em] uppercase" style={{ color: role.color }}>
              {step.done ? "Complete · the full loop ran on-chain" : `Step ${step.step} of 6 · the ${role.label.toLowerCase()} ${step.actor === "chain" ? "acts" : "is acting"}`}
            </span>
          </div>
          <h1 className="text-[44px] lg:text-[52px] leading-[1.02] font-bold tracking-[-0.03em]">
            {step.title}<br /><span className="text-red-bright">{step.accent}</span>
          </h1>
          <p className="text-[17px] leading-[1.55] text-dim" style={{ textWrap: "pretty" }}>{step.body}</p>

          {active && (
            <div className="grid grid-cols-2 gap-3 max-w-[520px]">
              <Fact label="Blast radius" value={fmtInstalls(active.installBase)} unit="installs / wk" />
              <Fact label={active.status === 1 ? "Price now · falling" : "Cleared at"} value={eth(active.status === 1 ? active.currentPriceEth : active.clearingPriceEth)} unit="ETH" />
              <Fact label="Seller's split" value={`${active.contingentBps / 100}%`} unit="on the outcome" tone="#A855F7" />
              <Fact label="Seller record" value={`${active.sellerRep.sold} sold`} unit={`${active.sellerRep.confirmed} confirmed`} tone="#34D399" />
            </div>
          )}

          {waiting && (
            <div className="max-w-[520px] bg-surface border border-line rounded-md p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="mono text-[10px] tracking-[0.14em] uppercase text-faint">{step.waitLabel} · closes in</span>
                <TimeLeft to={step.waitUntil!} now={now} />
              </div>
              <div className="h-1 bg-white/[0.06] rounded-full scan" />
            </div>
          )}

          <div className="flex items-center gap-5 flex-wrap">
            {step.action && (
              <Button size="lg" variant={step.action.danger ? "danger" : "primary"} onClick={() => act(step.action!.key, step.action!.body)} busy={busy === step.action.key}>{step.action.label}</Button>
            )}
            {step.done && <Button size="lg" variant="secondary" onClick={() => go("verifier")}>Check the oracle&apos;s work <Icon.Arrow /></Button>}
            {!step.done && step.step === 2 && (
              <button onClick={() => go("verifier")} className="mono text-[12px] tracking-[0.04em] text-faint hover:text-txt transition-colors">Why can&apos;t it read the finding? →</button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4 min-w-0">
          {last ? <SealedObject l={last} now={now} onOpen={() => go("market", last.id)} /> : <EmptyObject />}
          <div className="grid grid-cols-4 gap-2">
            {(["seller", "buyer", "oracle", "arbiter"] as const).map((r) => {
              const on = step.actor === r;
              return (
                <div key={r} className={`bg-surface border rounded-md px-3 py-3 flex flex-col gap-1 ${on ? "" : "opacity-50 border-line"}`} style={on ? { borderColor: ROLE[r].color } : undefined}>
                  <span className="mono text-[9.5px] tracking-[0.1em] uppercase" style={{ color: ROLE[r].color }}>{ROLE[r].label}</span>
                  <span className={`text-[11px] ${on ? "text-txt" : "text-dim"}`}>{on ? "acting" : ROLE[r].blurb}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function SealedObject({ l, now, onOpen }: { l: ListingView; now: number; onOpen: () => void }) {
  const copy = statusCopy(l);
  const open = l.status === 6;
  const timer =
    l.status === 1 && l.auctionEndsAt ? { label: "Auction floor", end: l.auctionEndsAt }
    : l.status === 3 && l.challengeEndsAt ? { label: "Challenge window", end: l.challengeEndsAt }
    : l.status === 5 && l.embargoEndsAt ? { label: "Embargo", end: l.embargoEndsAt }
    : l.status === 6 && l.contingentState === 1 && l.confirmationEndsAt ? { label: "Confirmation window", end: l.confirmationEndsAt }
    : null;
  const escrow =
    l.status === 1 ? "empty · auction live"
    : l.status === 2 || l.status === 3 || l.status === 4 ? `${eth(l.clearingPriceEth)} ETH locked`
    : l.status === 5 ? `base paid · ${eth(l.contingentPriceEth)} on outcome`
    : l.status === 6 ? (l.contingentState === 2 ? "fully released to seller" : l.contingentState === 3 ? "contingent returned" : "awaiting confirmation")
    : l.status === 7 ? "refunded to buyer" : "—";

  return (
    <Card active className="p-7 flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <Eyebrow>Sealed finding #{l.id}</Eyebrow>
        <Chip tone={copy.tone as Tone}>{copy.headline}</Chip>
      </div>
      <div className="flex items-center gap-6">
        <EffectRing effects={l.effects} />
        <div className="flex flex-col gap-1.5 min-w-0">
          <div className="mono text-[20px] font-bold truncate">{l.targetLabel.replace("npm:", "")}</div>
          {l.novel && <Chip tone="good">Not in any public feed</Chip>}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="mono text-[10px] tracking-[0.14em] uppercase text-faint">Observed by the sandbox</span>
        <EffectTags labels={l.effectLabels} />
        <p className="text-[12.5px] text-dim leading-relaxed mt-1">{l.outcome}</p>
      </div>

      <div className="bg-bg border border-line rounded-md p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="mono text-[10px] tracking-[0.14em] uppercase text-faint">{open ? "Writeup · decrypted" : "Writeup · sealed"}</span>
          {open ? <Icon.Unlock className="w-3.5 h-3.5 text-emerald-300" /> : <Icon.Lock className="w-3.5 h-3.5 text-red-bright" />}
        </div>
        {open && l.revealed ? (
          <div className="text-[12px] text-dim leading-relaxed line-clamp-4">{l.revealed.writeup}</div>
        ) : (
          <div className="mono text-[11px] leading-[1.7] text-line2 break-all select-none">{l.contentHash.slice(2).repeat(4).slice(0, 220)}</div>
        )}
        <div className="mono text-[10px] text-faint">trace {short(l.traceHash)} · committed before anyone paid</div>
      </div>

      {timer && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="mono text-[10px] tracking-[0.14em] uppercase text-faint">{timer.label}</span>
            <TimeLeft to={timer.end} now={now} />
          </div>
          <WindowBar start={l.status === 1 ? l.auctionStartedAt : l.deliveredAt || l.disclosedAt} end={timer.end} now={now} />
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="mono text-[10px] tracking-[0.14em] uppercase text-faint">Escrow</span>
        <span className="mono text-[13px] text-dim">{escrow}</span>
      </div>
      <button onClick={onOpen} className="mono text-[11px] tracking-[0.08em] uppercase text-faint hover:text-txt text-left transition-colors">Full history and commitments →</button>
    </Card>
  );
}

function EmptyObject() {
  return (
    <Card className="p-7 flex flex-col gap-4 items-center text-center min-h-[320px] justify-center">
      <div className="w-12 h-12 rounded-md border border-line bg-bg grid place-items-center text-faint"><Icon.Lock className="w-5 h-5" /></div>
      <div className="text-[14px] font-medium">No finding on the market yet</div>
      <div className="text-[12.5px] text-dim max-w-[300px]">The sealed finding appears here once the oracle detonates its repro and the researcher lists it.</div>
    </Card>
  );
}
