"use client";

import { useState } from "react";
import type { Address } from "viem";
import type { ListingView } from "@/lib/view";
import { statusCopy } from "../lifecycle";
import { Button, Chip, Eyebrow, EffectTags, TimeLeft, eth, effectTone, fmtInstalls, short, type Tone } from "../ui";
import type { ViewProps } from "./types";
import { useWallet } from "../wallet";
import { buyFromWallet, deliverFromWallet, discloseFromWallet, settleFromWallet, receiveDelivery, keyById, txUrl } from "@/lib/browser";
import type { Finding } from "@/lib/types";

export default function Market({ listings, now, busy, act, selected, setSelected, explorer }: ViewProps & { selected: number | null; setSelected: (id: number | null) => void }) {
  const sel = listings.find((l) => l.id === selected) ?? null;
  const pub = listings.filter((l) => l.status === 6).length;

  return (
    <div className="flex min-h-[calc(100vh-56px-44px)]">
      <div className="flex-1 min-w-0 px-10 lg:px-20 pt-11 pb-24">
        <div className="flex flex-col gap-2.5 max-w-[680px]">
          <Eyebrow>Sealed findings</Eyebrow>
          <h1 className="text-[34px] font-bold tracking-[-0.025em]">What a buyer sees. Nothing more.</h1>
          <p className="text-[15px] text-dim leading-relaxed">
            Every row is encrypted on-chain. The oracle detonated a repro and signed what it observed — no severity score, just the effects and a one-line outcome. Prices fall until someone buys. Select a row to inspect its history and commitments.
          </p>
        </div>

        <div className="mt-8 bg-surface border border-line rounded-lg overflow-hidden">
          <div className="mono grid grid-cols-[1fr_120px] md:grid-cols-[minmax(180px,1fr)_minmax(220px,1.2fr)_84px_110px_120px] gap-3 px-5 py-3 text-[10px] tracking-[0.14em] uppercase text-faint border-b border-line">
            <span>Package</span><span className="hidden md:block">Observed effects</span><span className="hidden md:block">Installs</span><span className="hidden md:block">Price</span><span>State</span>
          </div>
          {listings.length === 0 && (
            <div className="px-5 py-12 text-center text-[13px] text-dim">Nothing listed yet. Run a trade to put the first sealed finding on the market.</div>
          )}
          {listings.map((l) => {
            const c = statusCopy(l);
            const on = l.id === selected;
            const price = l.status === 1 ? l.currentPriceEth : l.clearingPriceEth;
            return (
              <button key={l.id} onClick={() => setSelected(on ? null : l.id)}
                className={`w-full text-left grid grid-cols-[1fr_120px] md:grid-cols-[minmax(180px,1fr)_minmax(220px,1.2fr)_84px_110px_120px] gap-3 items-center px-5 py-4 border-b border-line last:border-0 transition-colors ${on ? "bg-red/[0.06] shadow-[inset_3px_0_0_#FF3B4A]" : "hover:bg-white/[0.02]"}`}>
                <span className="min-w-0">
                  <span className="mono text-[14px] block truncate" style={{ color: effectTone(l.effects) }}>{l.targetLabel.replace("npm:", "")}</span>
                  <span className="text-[11px] text-faint block truncate md:hidden">{l.effectLabels[0]}</span>
                </span>
                <span className="hidden md:block"><EffectTags labels={l.effectLabels} max={2} /></span>
                <span className="hidden md:block mono text-[13px]">{fmtInstalls(l.installBase)}</span>
                <span className="hidden md:block mono text-[13px]">{eth(price)}{l.status === 1 && <span className="text-faint text-[10px]"> ↓</span>}</span>
                <span><Chip tone={c.tone as Tone}>{c.headline}</Chip></span>
              </button>
            );
          })}
        </div>
        <div className="mono text-[11px] text-faint mt-3">{listings.length} listed · {pub} public</div>
      </div>

      {sel && <Drawer l={sel} now={now} busy={busy} act={act} explorer={explorer} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Drawer({ l, now, busy, act, onClose }: { l: ListingView; now: number; busy: string | null; act: ViewProps["act"]; explorer?: string; onClose: () => void }) {
  const [verify, setVerify] = useState<any>(null);
  const [verifying, setVerifying] = useState(false);
  const history = buildHistory(l, now);
  const challengeOpen = l.status === 3 && l.challengeEndsAt != null && now < l.challengeEndsAt;
  const embargoOpen = l.status === 5 && l.embargoEndsAt != null && now < l.embargoEndsAt;
  const confirmOpen = l.status === 6 && l.contingentState === 1 && l.confirmationEndsAt != null && now < l.confirmationEndsAt;
  const confirmExpired = l.status === 6 && l.contingentState === 1 && l.confirmationEndsAt != null && now >= l.confirmationEndsAt;

  return (
    <aside className="w-full lg:w-[480px] shrink-0 bg-surface border-l border-line px-8 lg:px-10 py-9 flex flex-col gap-7 rise fixed lg:static inset-0 top-14 bottom-11 z-20 overflow-y-auto">
      <div className="flex items-center justify-between">
        <Eyebrow>Listing #{l.id}</Eyebrow>
        <button onClick={onClose} className="mono text-[12px] text-faint hover:text-txt">close ✕</button>
      </div>
      <div className="flex flex-col gap-2">
        <div className="mono text-[24px] font-bold break-all">{l.targetLabel.replace("npm:", "")}</div>
        <div className="text-[14px] text-dim">
          seller <span className="mono">{short(l.seller)}</span> · <span className="text-emerald-300">{l.sellerRep.sold} sold</span>
          {l.sellerRep.confirmed > 0 && <span className="text-emerald-300"> · {l.sellerRep.confirmed} confirmed</span>}
          {l.sellerRep.slashed > 0 && <span className="text-red-bright"> · {l.sellerRep.slashed} slashed</span>}
        </div>
      </div>

      <div className="flex flex-col gap-2.5 border border-red/25 bg-red/[0.03] rounded-md p-4">
        <Eyebrow>Outcome · shown before you pay</Eyebrow>
        <p className="text-[13.5px] text-txt leading-relaxed">{l.outcome}</p>
        <EffectTags labels={l.effectLabels} />
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        <Mini k="Installs / wk" v={fmtInstalls(l.installBase)} />
        <Mini k={l.status === 1 ? "Price now" : "Cleared at"} v={`${eth(l.status === 1 ? l.currentPriceEth : l.clearingPriceEth)} ETH`} />
        <Mini k="Contingent" v={`${l.contingentBps / 100}% · ${l.contingentStateLabel}`} />
        <Mini k="Seller's bond" v={`${eth(l.stakeEth)} ETH`} />
        {l.status >= 2 && <Mini k="Base → seller" v={`${eth(l.basePriceEth)} ETH`} />}
        {l.status >= 2 && <Mini k="Escrowed on outcome" v={`${eth(l.contingentPriceEth)} ETH`} />}
        <Mini k="Head start" v={`${l.embargoMinutes} min`} />
      </div>

      <div className="flex flex-col gap-3">
        <div className="mono text-[10px] tracking-[0.14em] uppercase text-faint">History</div>
        <div>
          {history.map((hh) => (
            <div key={hh.label} className={`grid grid-cols-[20px_1fr_auto] gap-3 items-center h-10 ${hh.state === "todo" ? "opacity-40" : ""}`}>
              <span className={`w-2 h-2 rounded-full ml-1.5 ${hh.state === "todo" ? "border border-faint" : hh.state === "now" ? "bg-red-bright shadow-[0_0_10px_#FF3B4A]" : "bg-red"}`} />
              <span className={`text-[13px] ${hh.state === "now" ? "text-txt" : ""}`}>{hh.label}</span>
              <span className={`mono text-[11px] ${hh.state === "now" ? "text-red-bright" : "text-faint"}`}>{hh.state === "now" && hh.until ? <TimeLeft to={hh.until} now={now} /> : hh.when}</span>
            </div>
          ))}
        </div>
      </div>

      {l.revealed && (
        <div className="flex flex-col gap-2.5 border border-red/30 bg-red/[0.04] rounded-md p-4">
          <Eyebrow>Now public · full writeup</Eyebrow>
          <div className="text-[12.5px] text-txt leading-relaxed"><span className="text-faint">Access obtained · </span>{l.revealed.expectedResult}</div>
          <p className="text-[12.5px] text-dim leading-relaxed">{l.revealed.writeup}</p>
          <div className="text-[12px] text-dim"><span className="text-faint">Fix · </span>{l.revealed.remediation}</div>
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        <div className="mono text-[10px] tracking-[0.14em] uppercase text-faint">On-chain commitments</div>
        <div className="bg-bg border border-line rounded-md px-4 py-2">
          <KV k="package file" v={short(l.artifactHash)} />
          <KV k="finding" v={short(l.contentHash)} />
          <KV k="sandbox trace" v={short(l.traceHash)} />
          <KV k="sandbox code" v={short(l.sandboxHash)} />
        </div>
        <div className="text-[12px] text-faint leading-relaxed">The trace hash was committed before anyone paid. Anyone can re-run the committed sandbox on the committed package and reproduce it.</div>
      </div>

      {verify && (
        <div className={`text-[13px] font-semibold ${verify.reproduced ? "text-emerald-300" : "text-red-bright"}`}>
          {verify.reproduced ? "✓ Independent re-detonation reproduced the attested trace and effects." : "✗ Re-detonation did not reproduce the attested grade."}
        </div>
      )}

      <WalletActions l={l} now={now} />

      <div className="mt-auto flex flex-col gap-2 pt-2">
        <div className="mono text-[10px] tracking-[0.14em] uppercase text-faint">Autonomous agents · demo</div>
        <div className="flex flex-wrap gap-2.5">
        {l.status === 1 && <Button size="sm" variant="secondary" onClick={() => act(`buy-${l.id}`, { action: "buy", id: l.id })} busy={busy === `buy-${l.id}`}>Buy as the vendor</Button>}
        {l.status === 2 && <Button size="sm" variant="secondary" onClick={() => act(`deliver-${l.id}`, { action: "deliver", id: l.id })} busy={busy === `deliver-${l.id}`}>Deliver key</Button>}
        {l.status === 3 && (
          <>
            <Button size="sm" disabled={challengeOpen} title={challengeOpen ? "Unlocks when the challenge window closes" : undefined} onClick={() => act(`settle-${l.id}`, { action: "settle", id: l.id })} busy={busy === `settle-${l.id}`}>Release base</Button>
            <Button size="sm" variant="danger" onClick={() => act(`challenge-${l.id}`, { action: "challenge", id: l.id })} busy={busy === `challenge-${l.id}`}>Challenge the trace</Button>
          </>
        )}
        {l.status === 4 && <Button size="sm" onClick={() => act(`resolve-${l.id}`, { action: "resolve", id: l.id })} busy={busy === `resolve-${l.id}`}>Arbiter re-detonates</Button>}
        {l.status === 5 && <Button size="sm" disabled={embargoOpen} title={embargoOpen ? "Unlocks when the embargo ends" : undefined} onClick={() => act(`disclose-${l.id}`, { action: "disclose", id: l.id })} busy={busy === `disclose-${l.id}`}>Publish to everyone</Button>}
        {confirmOpen && <Button size="sm" onClick={() => act(`confirm-${l.id}`, { action: "confirm", id: l.id })} busy={busy === `confirm-${l.id}`}>Record advisory</Button>}
        {confirmExpired && <Button size="sm" variant="secondary" onClick={() => act(`expire-${l.id}`, { action: "expire", id: l.id })} busy={busy === `expire-${l.id}`}>Return contingent</Button>}
        {l.status === 6 && (
          <Button size="sm" busy={verifying} onClick={async () => {
            setVerifying(true);
            const res = await fetch("/api/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: l.id }) });
            setVerify(await res.json());
            setVerifying(false);
          }}>Re-verify the oracle</Button>
        )}
        {l.listedTx && <a href={l.listedTx} target="_blank" rel="noreferrer"><Button size="sm" variant="secondary">Listing tx ↗</Button></a>}
        {l.disclosedTx && <a href={l.disclosedTx} target="_blank" rel="noreferrer"><Button size="sm" variant="secondary">Disclosure tx ↗</Button></a>}
        </div>
      </div>
    </aside>
  );
}

function Mini({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="mono text-[10px] tracking-[0.14em] uppercase text-faint">{k}</span>
      <span className="mono text-[14px] font-semibold">{v}</span>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 mono text-[11px] py-1.5">
      <span className="text-faint shrink-0">{k}</span>
      <span className="text-dim break-all text-right">{v}</span>
    </div>
  );
}

type H = { label: string; state: "done" | "now" | "todo"; when?: string; until?: number };

function buildHistory(l: ListingView, now: number): H[] {
  const t = (s: number) => (s ? new Date(s * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");
  const s = l.status;
  const rows: H[] = [{ label: "Repro detonated, signed", state: "done" }, { label: "Listed as a Dutch auction", state: "done" }];
  if (s === 8) return [...rows, { label: "Withdrawn", state: "done" }];
  if (s === 1) return [...rows, { label: "Price falling, awaiting a buyer", state: "now", when: "live" }, { label: "Bought", state: "todo" }, { label: "Delivered", state: "todo" }, { label: "Public", state: "todo" }];
  rows.push({ label: "Bought, escrow funded", state: "done", when: t(l.soldAt) });
  if (s === 2) return [...rows, { label: "Waiting for the key", state: "now", when: "now" }, { label: "Settled", state: "todo" }, { label: "Public", state: "todo" }];
  rows.push({ label: "Key delivered, hash verified", state: "done", when: t(l.deliveredAt) });
  if (s === 3) return [...rows, { label: "Challenge window", state: "now", until: l.challengeEndsAt ?? undefined, when: "closed" }, { label: "Settled", state: "todo" }, { label: "Public", state: "todo" }];
  if (s === 4) return [...rows, { label: "Challenged", state: "now", when: "now" }, { label: "Arbiter ruling", state: "todo" }];
  if (s === 7) return [...rows, { label: "Challenge upheld", state: "done" }, { label: "Refunded, seller slashed", state: "done" }];
  rows.push({ label: "Settled, base paid", state: "done" });
  if (s === 5) return [...rows, { label: "Embargo", state: "now", until: l.embargoEndsAt ?? undefined, when: "over" }, { label: "Public", state: "todo" }];
  rows.push({ label: "Disclosed to everyone", state: "done", when: t(l.disclosedAt) });
  if (l.contingentState === 1) return [...rows, { label: "Confirmation window", state: "now", until: l.confirmationEndsAt ?? undefined, when: "open" }];
  return [...rows, { label: l.contingentState === 2 ? "Confirmed · contingent to seller" : "Unconfirmed · contingent to buyer", state: "done" }];
}

/** The human path: act on this listing with your own connected wallet. Roles are
 *  derived from the connected address versus the listing's seller/buyer. */
function WalletActions({ l, now }: { l: ListingView; now: number }) {
  const w = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string; tx?: string } | null>(null);
  const [received, setReceived] = useState<Finding | null>(null);

  if (!w.address) {
    return (
      <div className="rounded-md border border-line bg-bg p-4 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[12.5px] text-dim">Connect a wallet to buy or act on this listing yourself.</span>
        <Button size="sm" onClick={w.connect} busy={w.connecting}>Connect wallet</Button>
      </div>
    );
  }
  if (w.wrongChain) {
    return (
      <div className="rounded-md border border-amber-400/40 bg-amber-400/5 p-4 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-[12.5px] text-amber-200">Wrong network.</span>
        <Button size="sm" variant="secondary" onClick={w.switchChain}>Switch to Base Sepolia</Button>
      </div>
    );
  }

  const me = w.address.toLowerCase();
  const isSeller = l.seller.toLowerCase() === me;
  const isBuyer = l.buyer && l.buyer.toLowerCase() === me;
  const haveKey = keyById(BigInt(l.id)) != null;
  const challengeClosed = l.challengeEndsAt != null && now >= l.challengeEndsAt;
  const embargoOver = l.embargoEndsAt != null && now >= l.embargoEndsAt;

  async function go(key: string, fn: () => Promise<`0x${string}` | void>, okText: string) {
    setBusy(key);
    setMsg(null);
    try {
      const hash = await fn();
      setMsg({ tone: "ok", text: okText, tx: typeof hash === "string" ? hash : undefined });
      w.refresh();
    } catch (e) {
      setMsg({ tone: "err", text: humanize(e) });
    } finally {
      setBusy(null);
    }
  }

  const actions: React.ReactNode[] = [];
  if (l.status === 1 && !isSeller)
    actions.push(<Button key="buy" size="sm" busy={busy === "buy"} onClick={() => go("buy", () => buyFromWallet(w.address!, BigInt(l.id)), `Bought #${l.id}. The seller now owes you the key.`)}>Buy for {eth(l.currentPriceEth)} ETH</Button>);
  if (l.status === 1 && isSeller)
    actions.push(<span key="own" className="text-[12.5px] text-dim">Your listing — the auction price is falling until someone buys.</span>);
  if (l.status === 2 && isSeller)
    actions.push(<Button key="deliver" size="sm" busy={busy === "deliver"} disabled={!haveKey} title={haveKey ? undefined : "List from this browser to deliver here"} onClick={() => go("deliver", () => deliverFromWallet(w.address!, BigInt(l.id)), `Delivered the key for #${l.id}.`)}>Deliver the key</Button>);
  if ((l.status === 3 || l.status >= 5) && isBuyer)
    actions.push(<Button key="recv" size="sm" variant="secondary" busy={busy === "recv"} onClick={() => go("recv", async () => { setReceived(await receiveDelivery(BigInt(l.id), l.contentHash)); }, "Decrypted your copy below.")}>Decrypt my copy</Button>);
  if (l.status === 3 && challengeClosed)
    actions.push(<Button key="settle" size="sm" variant="secondary" busy={busy === "settle"} onClick={() => go("settle", () => settleFromWallet(w.address!, BigInt(l.id)), `Released the base to the seller.`)}>Release base to seller</Button>);
  if (l.status === 5 && isSeller)
    actions.push(<Button key="disc" size="sm" busy={busy === "disc"} disabled={!embargoOver || !haveKey} title={!embargoOver ? "Unlocks when the embargo ends" : !haveKey ? "List from this browser to disclose here" : undefined} onClick={() => go("disc", () => discloseFromWallet(w.address!, BigInt(l.id)), `Published #${l.id} — the finding is now public.`)}>Publish to everyone</Button>);

  const role = isSeller ? "you are the seller" : isBuyer ? "you are the buyer" : "you are a visitor";

  return (
    <div className="rounded-md border border-red/25 bg-red/[0.03] p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="mono text-[10px] tracking-[0.14em] uppercase text-red-bright">Act with your wallet</div>
        <span className="mono text-[10px] text-faint">{role}</span>
      </div>
      {actions.length ? <div className="flex flex-wrap gap-2.5">{actions}</div> : <div className="text-[12.5px] text-dim">Nothing for you to do on this listing right now.</div>}
      {msg && (
        <div className={`text-[12.5px] ${msg.tone === "ok" ? "text-emerald-300" : "text-red-bright"}`}>
          {msg.text}
          {msg.tx && <a className="text-red-bright hover:text-txt ml-2" href={txUrl(msg.tx as `0x${string}`)} target="_blank" rel="noreferrer">tx ↗</a>}
        </div>
      )}
      {received && (
        <div className="flex flex-col gap-2 border border-line bg-bg rounded-md p-3">
          <div className="mono text-[10px] tracking-[0.14em] uppercase text-emerald-300">Your decrypted copy · hash verified</div>
          <div className="text-[12.5px] text-txt leading-relaxed">{received.writeup}</div>
          <div className="text-[12px] text-dim"><span className="text-faint">Access · </span>{received.expectedResult}</div>
          <div className="text-[12px] text-dim"><span className="text-faint">Fix · </span>{received.remediation}</div>
        </div>
      )}
    </div>
  );
}

function humanize(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/User rejected|denied|4001/i.test(m)) return "You rejected the transaction in your wallet.";
  if (/insufficient funds/i.test(m)) return "Insufficient funds for this action plus gas.";
  if (/contentHash mismatch/i.test(m)) return "Decryption produced content that does not match the on-chain commitment.";
  if (/not indexed yet/i.test(m)) return m;
  if (/TooEarly/i.test(m)) return "Too early — a time window has not closed yet.";
  return m;
}
