"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketView, ListingView } from "@/lib/view";
import type { LogLine } from "@/lib/types";
import {
  Button,
  Card,
  Chip,
  KV,
  Reveal,
  ROLE,
  SeverityRing,
  TimeLeft,
  WindowBar,
  eth,
  short,
  useTick,
} from "./ui";
import { STAGES, STAGE_INDEX, nextStep, statusCopy } from "./lifecycle";

export default function Dashboard({
  initial,
  initialError,
}: {
  initial: MarketView | null;
  initialError: string | null;
}) {
  const [view, setView] = useState<MarketView | null>(initial);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const sinceRef = useRef(0);
  const serverNow = view?.now ?? Math.floor(Date.now() / 1000);
  const now = useTick(serverNow);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/state?since=${sinceRef.current}`, { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) return setError(data.error);
      setError(null);
      setView(data);
      if (data.logs?.length) {
        sinceRef.current = data.logs[data.logs.length - 1].at;
        setLogs((p) => [...p, ...data.logs].slice(-150));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const act = useCallback(
    async (key: string, body: Record<string, unknown>) => {
      setBusy(key);
      setRefusal(null);
      try {
        const res = await fetch("/api/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        const refused = (data.logs ?? []).find((l: LogLine) => l.message?.startsWith("REFUSED"));
        if (refused) setRefusal(refused.message);
        else if (!data.ok) setError(data.error);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [refresh],
  );

  const c = view?.contract;
  const listings = view?.listings ?? [];
  const step = useMemo(() => nextStep(listings, now), [listings, now]);
  const deployed = c && c.address !== "0x0000000000000000000000000000000000000000";

  return (
    <main className="min-h-screen">
      <TopBar c={c} deployed={!!deployed} detectorHash={view?.detector.detectorHash} />

      <div className="max-w-[1280px] mx-auto px-5 pb-16">
        <Hero />

        {!deployed && (
          <Banner tone="bad">
            No contract address configured. Deploy the contract and restart the app.
          </Banner>
        )}
        {error && <Banner tone="bad">{error}</Banner>}
        {refusal && (
          <Banner tone="warn" onClose={() => setRefusal(null)}>
            <strong className="text-amber-200">The verifier refused to grade this. </strong>
            {refusal.replace(/^REFUSED \([a-z-]+\): /, "")}
            <div className="text-[11px] text-faint mt-1">
              No signature means no listing. This is the market rejecting bad intel before anyone can pay for it.
            </div>
          </Banner>
        )}

        <NextStepPanel step={step} busy={busy} act={act} now={now} />

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6 mt-8 items-start">
          <div>
            <SectionHead
              title="Listings"
              sub="Everything here is encrypted on-chain. You see the grade, not the goods."
            />
            {listings.length === 0 ? (
              <Card className="p-10 text-center">
                <div className="text-4xl mb-3">🔒</div>
                <div className="text-txt font-medium">No findings listed yet</div>
                <div className="text-dim text-sm mt-1 max-w-md mx-auto">
                  Use the panel above to have the researcher agent seal a real malicious package and get it graded.
                </div>
              </Card>
            ) : (
              <div className="space-y-4">
                {listings.map((l) => (
                  <ListingCard
                    key={l.id}
                    l={l}
                    now={now}
                    busy={busy}
                    act={act}
                    highlight={step.listingId === l.id}
                  />
                ))}
              </div>
            )}

            <TryBadIntel busy={busy} act={act} />
          </div>

          <div className="space-y-6 lg:sticky lg:top-4">
            <Actors />
            <Activity logs={logs} explorer={c?.explorer} />
          </div>
        </div>

        <Footer detectorHash={view?.detector.detectorHash} />
      </div>
    </main>
  );
}

/* ------------------------------------------------------------------ chrome */

function TopBar({
  c,
  deployed,
  detectorHash,
}: {
  c: MarketView["contract"] | undefined;
  deployed: boolean;
  detectorHash?: string;
}) {
  return (
    <div className="sticky top-0 z-20 backdrop-blur-xl bg-bg/80 border-b border-line">
      <div className="max-w-[1280px] mx-auto px-5 h-14 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-400 to-violet-500 grid place-items-center text-[#04222a] font-black text-sm">
            C
          </div>
          <span className="font-bold text-[15px] tracking-tight">CyberBlock</span>
          <span className="live-dot w-1.5 h-1.5 rounded-full bg-emerald-400" />
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <Chip tone={deployed ? "good" : "bad"}>
            {c?.chainId === 84532 ? "Base Sepolia" : c ? `local #${c.chainId}` : "no chain"}
          </Chip>
          {deployed && c && (
            <a href={c.addressUrl} target="_blank" rel="noreferrer">
              <Chip tone="brand">
                <span className="mono">{short(c.address)}</span> ↗
              </Chip>
            </a>
          )}
          <a href="/api/detector" target="_blank" rel="noreferrer" title="The exact detector source behind every grade">
            <Chip>
              detector <span className="mono">{detectorHash?.slice(0, 8)}</span> ↗
            </Chip>
          </a>
        </div>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <div className="pt-10 pb-8">
      <h1 className="text-[34px] sm:text-[42px] font-bold tracking-tight leading-[1.1] max-w-3xl">
        A market for security intel you{" "}
        <span className="bg-gradient-to-r from-cyan-300 to-violet-400 bg-clip-text text-transparent">
          can&apos;t read before you buy it
        </span>
        .
      </h1>
      <p className="text-dim text-[15px] mt-4 max-w-2xl leading-relaxed">
        Researchers find malware hiding in npm packages days before public feeds catch it. Selling that is
        normally impossible: show the buyer the bug and they no longer need to pay; pay first and the seller
        can send garbage. CyberBlock fixes both ends.
      </p>
      <div className="grid sm:grid-cols-3 gap-3 mt-6">
        <Pillar
          n="01"
          title="Graded before it's sold"
          body="An independent verifier re-runs a public detector on the real package and signs the result. No signature, no listing."
        />
        <Pillar
          n="02"
          title="Delivery is provable"
          body="The buyer checks the decrypted finding against a hash committed on-chain. Getting cheated on delivery is arithmetically impossible."
        />
        <Pillar
          n="03"
          title="Everyone gets it in the end"
          body="After a short embargo the key is published. The buyer paid for a head start, and the world gets a free disclosure."
        />
      </div>
    </div>
  );
}

function Pillar({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="bg-surface/70 border border-line rounded-xl p-4">
      <div className="mono text-[10px] text-cyan-400/70 mb-1.5">{n}</div>
      <div className="text-txt text-[13px] font-semibold">{title}</div>
      <div className="text-dim text-[12px] mt-1.5 leading-relaxed">{body}</div>
    </div>
  );
}

/* -------------------------------------------------------------- next step */

function NextStepPanel({
  step,
  busy,
  act,
  now,
}: {
  step: ReturnType<typeof nextStep>;
  busy: string | null;
  act: (k: string, b: Record<string, unknown>) => void;
  now: number;
}) {
  const waiting = step.waitUntil != null && now < step.waitUntil;
  return (
    <Card glow className="p-5 sm:p-6">
      <div className="flex items-start gap-4 flex-wrap sm:flex-nowrap">
        <div className="shrink-0">
          <div className="w-11 h-11 rounded-xl bg-cyan-400/10 border border-cyan-400/30 grid place-items-center">
            <span className="text-cyan-300 font-bold">{step.done ? "✓" : step.step}</span>
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-cyan-400/80 font-semibold">
              {step.done ? "Complete" : `Step ${step.step} of 5 — what happens next`}
            </span>
          </div>
          <h2 className="text-[19px] font-semibold mt-1.5">{step.title}</h2>
          <p className="text-dim text-[13.5px] mt-2 leading-relaxed max-w-2xl">{step.body}</p>

          {waiting && (
            <div className="mt-4 max-w-sm">
              <div className="flex items-center justify-between text-[12px] mb-1.5">
                <span className="text-faint">{step.waitLabel}</span>
                <TimeLeft to={step.waitUntil!} now={now} />
              </div>
              <div className="h-1.5 bg-white/5 rounded-full overflow-hidden sheen" />
            </div>
          )}

          {step.action && (
            <div className="mt-4 flex items-center gap-3 flex-wrap">
              <Button
                size="lg"
                onClick={() => act(step.action!.key, step.action!.body)}
                busy={busy === step.action.key}
              >
                {step.action.label}
              </Button>
              {waiting && step.action.key.startsWith("dispute") && (
                <span className="text-[11px] text-faint">optional — this triggers the dispute path</span>
              )}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ---------------------------------------------------------------- listing */

function ListingCard({
  l,
  now,
  busy,
  act,
  highlight,
}: {
  l: ListingView;
  now: number;
  busy: string | null;
  act: (k: string, b: Record<string, unknown>) => void;
  highlight: boolean;
}) {
  const [verify, setVerify] = useState<any>(null);
  const [verifying, setVerifying] = useState(false);
  const copy = statusCopy(l);
  const stage = STAGE_INDEX[l.status] ?? 0;
  const dead = l.status === 7 || l.status === 8;

  return (
    <Card glow={highlight} className="overflow-hidden">
      {/* header */}
      <div className="p-5 pb-4">
        <div className="flex items-start gap-4">
          <SeverityRing value={l.severity} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="mono text-[15px] font-semibold text-txt">{l.targetLabel.replace("npm:", "")}</span>
              <Chip tone={copy.tone as any}>{copy.headline}</Chip>
              {l.novel && l.status <= 6 && <Chip tone="good">not in any public feed</Chip>}
            </div>
            <p className="text-dim text-[12.5px] mt-2 leading-relaxed">{copy.detail}</p>
            <div className="text-[11px] text-faint mt-2">
              {l.vulnClassLabel} · seller{" "}
              <span className="mono">{short(l.seller)}</span> ·{" "}
              <span className="text-emerald-400">{l.sellerRep.sold} clean</span>
              {l.sellerRep.slashed > 0 && (
                <span className="text-rose-400"> · {l.sellerRep.slashed} slashed</span>
              )}
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[17px] font-semibold text-txt">{eth(l.priceEth)}</div>
            <div className="text-[10px] text-faint">ETH</div>
          </div>
        </div>
      </div>

      {/* pipeline */}
      {!dead && (
        <div className="px-5 pb-4">
          <div className="flex items-center gap-1">
            {STAGES.map((s, i) => (
              <div key={s} className="flex-1">
                <div
                  className={`h-1 rounded-full transition-colors ${
                    i < stage
                      ? "bg-cyan-500/60"
                      : i === stage
                        ? "bg-cyan-300"
                        : "bg-white/[0.07]"
                  }`}
                />
                <div
                  className={`text-[9.5px] mt-1.5 ${
                    i === stage ? "text-cyan-300 font-medium" : i < stage ? "text-faint" : "text-faint/50"
                  }`}
                >
                  {s}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* facts */}
      <div className="px-5 pb-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Fact label="Affected installs" value={l.installBase ? l.installBase.toLocaleString() : "—"} hint="per week" />
        <Fact label="Seller's bond" value={`${eth(l.stakeEth)} ETH`} hint="returned on disclosure" />
        <Fact label="Exclusivity" value={`${l.embargoMinutes} min`} hint="then public" />
        <Fact
          label="Fair price"
          value={`${eth(l.fairPriceEth)} ETH`}
          hint="set on-chain by severity"
        />
      </div>

      {/* timers */}
      {l.status === 3 && l.challengeEndsAt && (
        <Timer
          label="Challenge window"
          hint="buyer can dispute the grade until this closes"
          start={l.deliveredAt}
          end={l.challengeEndsAt}
          now={now}
        />
      )}
      {l.status === 5 && l.embargoEndsAt && (
        <Timer
          label="Embargo"
          hint="buyer has it exclusively until this expires"
          start={l.deliveredAt}
          end={l.embargoEndsAt}
          now={now}
        />
      )}

      {/* actions */}
      <div className="px-5 py-4 border-t border-line bg-black/20 flex items-center gap-2 flex-wrap">
        {l.status === 1 && (
          <Button size="sm" variant="secondary" onClick={() => act(`buy-${l.id}`, { action: "buy", id: l.id })} busy={busy === `buy-${l.id}`}>
            Buyer evaluates &amp; buys
          </Button>
        )}
        {l.status === 2 && (
          <Button size="sm" variant="secondary" onClick={() => act(`deliver-${l.id}`, { action: "deliver", id: l.id })} busy={busy === `deliver-${l.id}`}>
            Deliver key
          </Button>
        )}
        {l.status === 3 && (
          <>
            <Button
              size="sm"
              variant="secondary"
              disabled={!(l.challengeEndsAt && now >= l.challengeEndsAt)}
              onClick={() => act(`settle-${l.id}`, { action: "settle", id: l.id })}
              busy={busy === `settle-${l.id}`}
            >
              Release escrow
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => act(`dispute-${l.id}`, { action: "dispute", id: l.id, reason: "buyer challenges the attestation" })}
              busy={busy === `dispute-${l.id}`}
            >
              Challenge the grade
            </Button>
          </>
        )}
        {l.status === 4 && (
          <Button size="sm" onClick={() => act(`resolve-${l.id}`, { action: "resolve", id: l.id })} busy={busy === `resolve-${l.id}`}>
            Verifier re-runs detector
          </Button>
        )}
        {l.status === 5 && (
          <Button
            size="sm"
            variant="secondary"
            disabled={!(l.embargoEndsAt && now >= l.embargoEndsAt)}
            onClick={() => act(`disclose-${l.id}`, { action: "disclose", id: l.id })}
            busy={busy === `disclose-${l.id}`}
          >
            Publish to everyone
          </Button>
        )}
        {l.status === 6 && (
          <Button
            size="sm"
            variant="secondary"
            busy={verifying}
            onClick={async () => {
              setVerifying(true);
              const res = await fetch("/api/verify", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ id: l.id }),
              });
              setVerify(await res.json());
              setVerifying(false);
            }}
          >
            Re-verify the verifier
          </Button>
        )}
        <div className="ml-auto flex items-center gap-3 text-[11px]">
          {l.listedTx && (
            <a className="text-faint hover:text-cyan-300" href={l.listedTx} target="_blank" rel="noreferrer">
              listing tx ↗
            </a>
          )}
          {l.disclosedTx && (
            <a className="text-cyan-400 hover:text-cyan-300" href={l.disclosedTx} target="_blank" rel="noreferrer">
              disclosure tx ↗
            </a>
          )}
        </div>
      </div>

      {verify && (
        <div className="px-5 py-4 border-t border-line rise">
          <div className={`text-[13px] font-medium ${verify.reproduced ? "text-emerald-300" : "text-rose-300"}`}>
            {verify.reproduced
              ? "✓ Independently re-ran the detector — it reproduced the signed grade exactly."
              : "✗ Re-run did not reproduce the signed grade."}
          </div>
          <div className="text-[11px] text-faint mt-1.5">
            This is the check on the verifier. The package file, the detector source, and the grade are all
            hash-committed on-chain, so a dishonest grade would leave permanent proof.
          </div>
          {verify.matches && (
            <div className="flex gap-3 mt-2 text-[11px] text-dim flex-wrap">
              {Object.entries(verify.matches).map(([k, v]) => (
                <span key={k}>
                  {v ? "✓" : "✗"} {k.replace("Hash", " hash")}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* revealed finding */}
      {l.revealed && (
        <div className="px-5 py-4 border-t border-line bg-emerald-400/[0.03]">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[10px] uppercase tracking-widest text-emerald-400 font-semibold">
              Now public
            </span>
          </div>
          <div className="text-txt text-[14px] font-semibold">{l.revealed.title}</div>
          <p className="text-dim text-[12.5px] mt-1.5 leading-relaxed">{l.revealed.summary}</p>
          <div className="grid sm:grid-cols-3 gap-3 mt-3 text-[11px]">
            <IOC label="Malicious domains" items={l.revealed.iocs.domains} tone="text-rose-300" />
            <IOC label="Files" items={l.revealed.iocs.files} tone="text-amber-300" />
            <IOC label="Indicators" items={l.revealed.iocs.snippets} tone="text-dim" />
          </div>
          <div className="text-[11.5px] text-dim mt-3">
            <span className="text-faint">Fix: </span>
            {l.revealed.remediation}
          </div>
        </div>
      )}

      {/* proofs */}
      <div className="px-5 pb-4">
        <Reveal label="Cryptographic commitments">
          <div className="bg-black/30 rounded-lg p-3">
            <KV k="package file" v={l.artifactHash} mono />
            <KV k="finding hash" v={l.contentHash} mono />
            <KV k="detector" v={l.detectorHash} mono />
            <div className="text-[10.5px] text-faint mt-2 leading-relaxed">
              The finding hash was committed before anyone paid. The buyer checks their decrypted copy against
              it, so the seller cannot swap in something worthless.
            </div>
          </div>
        </Reveal>
      </div>
    </Card>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-white/[0.03] border border-line rounded-lg px-3 py-2">
      <div className="text-[10px] text-faint">{label}</div>
      <div className="text-[13px] text-txt font-medium mt-0.5">{value}</div>
      {hint && <div className="text-[9.5px] text-faint/80 mt-0.5">{hint}</div>}
    </div>
  );
}

function Timer({
  label,
  hint,
  start,
  end,
  now,
}: {
  label: string;
  hint: string;
  start: number;
  end: number;
  now: number;
}) {
  return (
    <div className="px-5 pb-4">
      <div className="flex items-baseline justify-between text-[11.5px] mb-1.5">
        <span className="text-dim">
          {label} <span className="text-faint">— {hint}</span>
        </span>
        <TimeLeft to={end} now={now} />
      </div>
      <WindowBar start={start} end={end} now={now} />
    </div>
  );
}

function IOC({ label, items, tone }: { label: string; items: string[]; tone: string }) {
  return (
    <div>
      <div className="text-faint mb-1">{label}</div>
      <div className={`mono ${tone}`}>{items.length ? items.join(", ") : "—"}</div>
    </div>
  );
}

/* ------------------------------------------------------------- side panels */

function Actors() {
  return (
    <Card className="p-4">
      <SectionHead title="Who's acting" sub="Three agents, each with its own wallet." small />
      <div className="space-y-2.5 mt-3">
        {(["seller", "buyer", "oracle"] as const).map((r) => (
          <div key={r} className="flex items-start gap-2.5">
            <span
              className="w-2 h-2 rounded-full mt-1.5 shrink-0"
              style={{ background: ROLE[r].color }}
            />
            <div>
              <div className="text-[12.5px] text-txt font-medium">{ROLE[r].label}</div>
              <div className="text-[11px] text-faint">{ROLE[r].blurb}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Activity({ logs, explorer }: { logs: LogLine[]; explorer?: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  // Scroll the log box itself, never the page — scrollIntoView here would yank the
  // whole window away from whatever the visitor is actually looking at.
  useEffect(() => {
    const box = boxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [logs]);
  return (
    <Card className="p-4">
      <SectionHead title="Live activity" sub="Every line is a real signed transaction." small />
      <div ref={boxRef} className="mt-3 h-[380px] overflow-y-auto space-y-2 pr-1">
        {logs.length === 0 && (
          <div className="text-faint text-[12px] py-6 text-center">Nothing yet — take the next step above.</div>
        )}
        {logs.map((l, i) => (
          <div key={i} className="flex gap-2 text-[11.5px] rise">
            <span
              className="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0"
              style={{ background: ROLE[l.actor]?.color ?? "#5C6B85" }}
            />
            <div className="min-w-0">
              <span className="text-faint">{ROLE[l.actor]?.label ?? l.actor}</span>{" "}
              <span
                className={
                  l.level === "error" ? "text-rose-300" : l.level === "warn" ? "text-amber-300" : "text-dim"
                }
              >
                {l.message}
              </span>
              {l.txHash && explorer && (
                <a
                  className="text-cyan-500 hover:text-cyan-300 ml-1"
                  href={`${explorer}/tx/${l.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  ↗
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function TryBadIntel({
  busy,
  act,
}: {
  busy: string | null;
  act: (k: string, b: Record<string, unknown>) => void;
}) {
  return (
    <Card className="mt-6 p-5">
      <div className="text-[13px] font-semibold text-txt">Try to sell bad intel</div>
      <p className="text-dim text-[12.5px] mt-1.5 leading-relaxed max-w-2xl">
        The verifier is what keeps this market honest. Try to get something worthless graded and watch it get
        turned away — no signature means the contract will not accept a listing at all.
      </p>
      <div className="flex gap-2 mt-3 flex-wrap">
        <Button
          size="sm"
          variant="secondary"
          busy={busy === "att-clean"}
          onClick={() => act("att-clean", { action: "attest-only", findingFile: "clean-lib-2.0.0.json" })}
        >
          Sell a bug that doesn&apos;t exist
        </Button>
        <Button
          size="sm"
          variant="secondary"
          busy={busy === "att-hype"}
          onClick={() => act("att-hype", { action: "attest-only", findingFile: "overhyped-logger-1.0.3.json" })}
        >
          Exaggerate a real one
        </Button>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ misc */

function SectionHead({ title, sub, small }: { title: string; sub?: string; small?: boolean }) {
  return (
    <div className={small ? "" : "mb-4"}>
      <h2 className={`font-semibold text-txt ${small ? "text-[13px]" : "text-[16px]"}`}>{title}</h2>
      {sub && <p className={`text-faint mt-0.5 ${small ? "text-[11px]" : "text-[12.5px]"}`}>{sub}</p>}
    </div>
  );
}

function Banner({
  children,
  tone,
  onClose,
}: {
  children: React.ReactNode;
  tone: "bad" | "warn";
  onClose?: () => void;
}) {
  const t =
    tone === "bad"
      ? "bg-rose-500/10 border-rose-500/30 text-rose-200"
      : "bg-amber-500/10 border-amber-500/30 text-amber-100";
  return (
    <div className={`rounded-xl border px-4 py-3 text-[12.5px] mb-4 flex gap-3 rise ${t}`}>
      <div className="flex-1">{children}</div>
      {onClose && (
        <button onClick={onClose} className="text-current/60 hover:text-current shrink-0">
          ✕
        </button>
      )}
    </div>
  );
}

function Footer({ detectorHash }: { detectorHash?: string }) {
  return (
    <div className="mt-12 pt-6 border-t border-line text-[11.5px] text-faint leading-relaxed max-w-3xl">
      <strong className="text-dim">What you have to trust.</strong> One verifier grades every finding and
      settles every dispute. But its detector is public code whose hash{" "}
      <span className="mono">{detectorHash?.slice(0, 10)}</span> is committed inside every grade, and package
      files are content-addressed — so after disclosure anyone can re-run it and catch a lie permanently. The
      honest next step is several independent verifiers who lose their stake when a re-run contradicts them.
      <div className="mt-2">
        Demo windows are compressed to minutes; production would use hours and days. Testnet only, no real
        funds. Packages here are local fixtures, never published to the real npm registry.
      </div>
    </div>
  );
}
