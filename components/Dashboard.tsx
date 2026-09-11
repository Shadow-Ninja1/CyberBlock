"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MarketView, ListingView } from "@/lib/view";
import type { LogLine } from "@/lib/types";

const SEVERITY_COLOR = (s: number) =>
  s >= 80 ? "#ff5c5c" : s >= 50 ? "#ffb020" : s >= 25 ? "#ffd666" : "#7a8699";

const STATUS_STYLE: Record<string, string> = {
  Listed: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  Sold: "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
  Delivered: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  Disputed: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  Settled: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  Disclosed: "bg-teal-500/15 text-teal-300 border-teal-500/30",
  Refunded: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  Cancelled: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

const ACTOR_STYLE: Record<string, string> = {
  oracle: "text-fuchsia-300",
  seller: "text-amber-300",
  buyer: "text-cyan-300",
  chain: "text-zinc-500",
  system: "text-emerald-300",
};

function short(addr: string) {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function Countdown({ to, now }: { to: number | null; now: number }) {
  const [n, setN] = useState(now);
  useEffect(() => {
    const t = setInterval(() => setN((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (!to) return null;
  const left = to - n;
  if (left <= 0) return <span className="text-emerald-400">ready</span>;
  const m = Math.floor(left / 60);
  const s = left % 60;
  return (
    <span className="text-zinc-400 tabular-nums">
      {m}:{String(s).padStart(2, "0")}
    </span>
  );
}

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
  const [clientNow, setClientNow] = useState(Math.floor(Date.now() / 1000));
  const sinceRef = useRef<number>(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/state?since=${sinceRef.current}`, { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setError(null);
      setView(data);
      setClientNow(data.now);
      if (data.logs?.length) {
        sinceRef.current = data.logs[data.logs.length - 1].at;
        setLogs((prev) => [...prev, ...data.logs].slice(-200));
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

  useEffect(() => {
    const t = setInterval(() => setClientNow((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const act = useCallback(
    async (label: string, body: Record<string, unknown>) => {
      setBusy(label);
      try {
        const res = await fetch("/api/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!data.ok) setError(data.error);
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
  const disclosed = listings.filter((l) => l.status === 6 && l.revealed);
  const configured = c && c.address !== "0x0000000000000000000000000000000000000000";

  return (
    <main className="min-h-screen max-w-[1400px] mx-auto px-5 py-6">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-edge pb-5">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100 tracking-tight">
            Black Box Bazaar
            <span className="ml-3 text-xs font-normal text-emerald-400 align-middle">
              <span className="live-dot inline-block w-2 h-2 rounded-full bg-emerald-400 mr-1" />
              live
            </span>
          </h1>
          <p className="text-sm text-zinc-400 mt-1 max-w-3xl leading-relaxed">
            A market for npm supply-chain threat intel you <em>cannot inspect before paying</em>. A neutral
            oracle grades each sealed finding and signs it before listing. Buyers purchase early access;
            after an embargo the key is published on-chain and the finding becomes a free, coordinated
            disclosure for every defender.
          </p>
        </div>
        <div className="text-xs text-right space-y-1">
          <div>
            <span className="text-zinc-500">contract </span>
            {configured ? (
              <a className="text-cyan-300 hover:underline" href={c!.addressUrl} target="_blank" rel="noreferrer">
                {short(c!.address)} ↗
              </a>
            ) : (
              <span className="text-rose-400">not deployed</span>
            )}
          </div>
          <div>
            <span className="text-zinc-500">chain </span>
            <span className="text-zinc-300">{c?.chainId === 84532 ? "Base Sepolia" : `#${c?.chainId}`}</span>
          </div>
          <div>
            <span className="text-zinc-500">oracle </span>
            <span className="text-zinc-300">{c ? short(c.oracle) : "—"}</span>
          </div>
          <div>
            <span className="text-zinc-500">detector </span>
            <a className="text-cyan-300 hover:underline" href="/api/detector" target="_blank" rel="noreferrer">
              {view?.detector.detectorHash.slice(0, 10)}… ↗
            </a>
          </div>
        </div>
      </header>

      <HowItWorks />

      {error && (
        <div className="mt-4 text-sm text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-2">
          {error}
        </div>
      )}

      {/* Seed controls */}
      <section className="mt-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-zinc-500 mr-1">seller lists:</span>
          <Btn onClick={() => act("list-evil", { action: "list", findingFile: "evil-widget-1.2.0.json" })} busy={busy === "list-evil"}>
            + evil-widget (sev 100)
          </Btn>
          <Btn onClick={() => act("list-sneaky", { action: "list", findingFile: "sneaky-utils-0.4.1.json" })} busy={busy === "list-sneaky"}>
            + sneaky-utils (sev 42)
          </Btn>
          <span className="text-xs text-zinc-500 mx-1">oracle refuses:</span>
          <Btn
            variant="ghost"
            onClick={() => act("att-clean", { action: "attest-only", findingFile: "clean-lib-2.0.0.json" })}
            busy={busy === "att-clean"}
          >
            try clean-lib (no finding)
          </Btn>
          <Btn
            variant="ghost"
            onClick={() => act("att-hype", { action: "attest-only", findingFile: "overhyped-logger-1.0.3.json" })}
            busy={busy === "att-hype"}
          >
            try fabricated writeup
          </Btn>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-5 mt-5">
        {/* Market */}
        <section>
          <SectionTitle>Market — sealed findings, graded before sale</SectionTitle>
          {listings.length === 0 ? (
            <Empty>No listings yet. Use the buttons above to have the seller agent list a finding.</Empty>
          ) : (
            <div className="space-y-3">
              {listings.map((l) => (
                <ListingCard
                  key={l.id}
                  l={l}
                  now={clientNow}
                  busy={busy}
                  act={act}
                  explorer={c!.explorer}
                />
              ))}
            </div>
          )}

          {disclosed.length > 0 && (
            <div className="mt-7">
              <SectionTitle>Public disclosure feed</SectionTitle>
              <div className="space-y-3">
                {disclosed.map((l) => (
                  <DisclosureCard key={l.id} l={l} />
                ))}
              </div>
            </div>
          )}
        </section>

        {/* Agent console */}
        <section>
          <SectionTitle>Agent console</SectionTitle>
          <div className="bg-black/40 border border-edge rounded-lg h-[560px] overflow-y-auto p-3 text-xs leading-relaxed">
            {logs.length === 0 && <div className="text-zinc-600">waiting for agent activity…</div>}
            {logs.map((line, i) => (
              <div key={i} className="mb-1">
                <span className="text-zinc-600 mr-2">
                  {new Date(line.at).toLocaleTimeString([], { hour12: false })}
                </span>
                <span className={`font-bold mr-2 ${ACTOR_STYLE[line.actor] ?? "text-zinc-300"}`}>
                  {line.actor}
                </span>
                <span className={line.level === "error" ? "text-rose-300" : line.level === "warn" ? "text-amber-300" : "text-zinc-300"}>
                  {line.message}
                </span>
                {line.txHash && c && (
                  <a
                    className="text-cyan-500 hover:underline ml-1"
                    href={`${c.explorer}/tx/${line.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    ↗
                  </a>
                )}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
          <p className="text-[11px] text-zinc-600 mt-2">
            Three autonomous actors: the <span className="text-amber-300">seller</span> seals and lists, the{" "}
            <span className="text-cyan-300">buyer</span> decides from the grade alone, the{" "}
            <span className="text-fuchsia-300">oracle</span> grades and adjudicates. All sign their own
            transactions.
          </p>
        </section>
      </div>

      <footer className="mt-10 pt-5 border-t border-edge text-[11px] text-zinc-600 leading-relaxed">
        Trust model: a single honest oracle grades findings, but every grade is falsifiable — the detector
        source is public ({view?.detector.detectorHash.slice(0, 10)}…) and its hash is committed in each
        attestation, so anyone can re-run it against the disclosed artifact. Demo windows are compressed to
        minutes; production would use hours and days. Testnet only.
      </footer>
    </main>
  );
}

function ListingCard({
  l,
  now,
  busy,
  act,
  explorer,
}: {
  l: ListingView;
  now: number;
  busy: string | null;
  act: (label: string, body: Record<string, unknown>) => void;
  explorer: string;
}) {
  const [verify, setVerify] = useState<any>(null);
  const slashRate =
    l.sellerRep.sold + l.sellerRep.slashed === 0
      ? 0
      : l.sellerRep.slashed / (l.sellerRep.sold + l.sellerRep.slashed);

  const challengeReady = l.challengeEndsAt !== null && now >= l.challengeEndsAt;
  const embargoReady = l.embargoEndsAt !== null && now >= l.embargoEndsAt;
  const withinChallenge = l.challengeEndsAt !== null && now < l.challengeEndsAt;

  return (
    <div className="bg-panel border border-edge rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500 text-xs">#{l.id}</span>
            <span className="font-bold text-zinc-100 truncate">{l.targetLabel}</span>
            <span className={`text-[10px] px-2 py-0.5 rounded border ${STATUS_STYLE[l.statusLabel] ?? ""}`}>
              {l.statusLabel}
            </span>
            {!l.novel && <span className="text-[10px] text-rose-400">not novel</span>}
          </div>
          <div className="text-[11px] text-zinc-500 mt-1">
            seller {short(l.seller)} · rep{" "}
            <span className="text-emerald-400">{l.sellerRep.sold}✓</span>/
            <span className="text-rose-400">{l.sellerRep.slashed}✗</span>
            {slashRate > 0 && <span> ({Math.round(slashRate * 100)}% slashed)</span>}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-lg font-bold" style={{ color: SEVERITY_COLOR(l.severity) }}>
            {l.severity}
            <span className="text-xs text-zinc-600">/100</span>
          </div>
          <div className="text-[10px] text-zinc-500">{l.vulnClassLabel}</div>
        </div>
      </div>

      {/* Attested metadata grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-[11px]">
        <Meta label="price" value={`${l.priceEth.toFixed(6)} ETH`} sub={`fair ${l.fairPriceEth.toFixed(6)}`} />
        <Meta label="stake / bond" value={`${l.stakeEth.toFixed(6)} ETH`} />
        <Meta label="install base" value={l.installBase.toLocaleString()} sub="weekly dl" />
        <Meta label="embargo" value={`${l.embargoMinutes} min`} />
      </div>

      <div className="mt-2 text-[10px] text-zinc-600 font-mono break-all">
        content {l.contentHash.slice(0, 18)}… · artifact {l.artifactHash.slice(0, 18)}… · detector{" "}
        {l.detectorHash.slice(0, 14)}…
      </div>

      {/* Lifecycle actions */}
      <div className="flex flex-wrap items-center gap-2 mt-3">
        {l.status === 1 && (
          <Btn onClick={() => act(`buy-${l.id}`, { action: "buy", id: l.id })} busy={busy === `buy-${l.id}`}>
            buyer evaluates &amp; buys
          </Btn>
        )}
        {l.status === 2 && (
          <Btn onClick={() => act(`deliver-${l.id}`, { action: "deliver", id: l.id })} busy={busy === `deliver-${l.id}`}>
            seller delivers key
          </Btn>
        )}
        {l.status === 3 && (
          <>
            <span className="text-[11px] text-zinc-500">
              challenge: <Countdown to={l.challengeEndsAt} now={now} />
            </span>
            {withinChallenge && (
              <Btn
                variant="warn"
                onClick={() => act(`dispute-${l.id}`, { action: "dispute", id: l.id, reason: "buyer challenges the attestation" })}
                busy={busy === `dispute-${l.id}`}
              >
                buyer disputes
              </Btn>
            )}
            <Btn
              onClick={() => act(`settle-${l.id}`, { action: "settle", id: l.id })}
              busy={busy === `settle-${l.id}`}
              disabled={!challengeReady}
            >
              settle
            </Btn>
          </>
        )}
        {l.status === 4 && (
          <Btn
            variant="oracle"
            onClick={() => act(`resolve-${l.id}`, { action: "resolve", id: l.id })}
            busy={busy === `resolve-${l.id}`}
          >
            oracle re-runs detector &amp; resolves
          </Btn>
        )}
        {l.status === 5 && (
          <>
            <span className="text-[11px] text-zinc-500">
              embargo: <Countdown to={l.embargoEndsAt} now={now} />
            </span>
            <Btn
              variant="teal"
              onClick={() => act(`disclose-${l.id}`, { action: "disclose", id: l.id })}
              busy={busy === `disclose-${l.id}`}
              disabled={!embargoReady}
            >
              publish key (disclose)
            </Btn>
          </>
        )}
        {l.status === 6 && (
          <>
            <button
              className="text-[11px] px-2 py-1 rounded border border-teal-500/40 text-teal-300 hover:bg-teal-500/10"
              onClick={async () => {
                const res = await fetch("/api/verify", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ id: l.id }),
                });
                setVerify(await res.json());
              }}
            >
              re-verify the oracle
            </button>
            {l.disclosedTx && (
              <a className="text-[11px] text-cyan-400 hover:underline" href={l.disclosedTx} target="_blank" rel="noreferrer">
                disclosure tx ↗
              </a>
            )}
          </>
        )}
        {l.listedTx && l.status !== 6 && (
          <a className="text-[11px] text-cyan-500 hover:underline ml-auto" href={l.listedTx} target="_blank" rel="noreferrer">
            listing tx ↗
          </a>
        )}
      </div>

      {verify && (
        <div className="mt-3 text-[11px] bg-black/40 border border-edge rounded p-2">
          <div className={verify.reproduced ? "text-emerald-300" : "text-rose-300"}>
            {verify.reproduced
              ? "✓ Re-ran the committed detector independently — grade reproduced exactly."
              : "✗ Re-run did NOT reproduce the attested grade."}
          </div>
          {verify.matches && (
            <div className="text-zinc-500 mt-1">
              artifactHash {verify.matches.artifactHash ? "✓" : "✗"} · detectorHash{" "}
              {verify.matches.detectorHash ? "✓" : "✗"} · severity {verify.matches.severity ? "✓" : "✗"} · class{" "}
              {verify.matches.vulnClass ? "✓" : "✗"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DisclosureCard({ l }: { l: ListingView }) {
  const f = l.revealed!;
  return (
    <div className="bg-teal-950/20 border border-teal-500/25 rounded-lg p-4">
      <div className="flex items-center gap-2">
        <span className="text-teal-300 text-xs font-bold">DISCLOSED</span>
        <span className="font-bold text-zinc-100">{f.title}</span>
      </div>
      <p className="text-sm text-zinc-300 mt-2 leading-relaxed">{f.summary}</p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-3 text-[11px]">
        <div>
          <div className="text-zinc-600">domains</div>
          <div className="text-rose-300">{f.iocs.domains.join(", ") || "—"}</div>
        </div>
        <div>
          <div className="text-zinc-600">files</div>
          <div className="text-amber-300">{f.iocs.files.join(", ") || "—"}</div>
        </div>
        <div>
          <div className="text-zinc-600">indicators</div>
          <div className="text-zinc-300">{f.iocs.snippets.join(", ") || "—"}</div>
        </div>
      </div>
      <div className="text-[11px] text-zinc-400 mt-2">
        <span className="text-zinc-600">remediation: </span>
        {f.remediation}
      </div>
      <div className="text-[10px] text-zinc-600 mt-2 break-all">revealed key {f.key}</div>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    ["grade", "Oracle re-runs a public detector on the real artifact, checks OSV for novelty, and signs a grade."],
    ["list", "Seller posts the signed grade + sealed finding on-chain, bonded by a stake."],
    ["buy", "Buyer pays into escrow from the grade alone — price is derived on-chain from severity."],
    ["deliver", "Seller hands over the key, wrapped to the buyer. Buyer checks it against the committed hash."],
    ["settle", "After a challenge window, escrow releases. A dispute only re-checks the grade."],
    ["disclose", "After the embargo, the key is published. The finding becomes free for everyone."],
  ];
  return (
    <div className="mt-4 grid grid-cols-2 md:grid-cols-6 gap-2">
      {steps.map(([k, v], i) => (
        <div key={k} className="bg-panel/60 border border-edge rounded p-2">
          <div className="text-[10px] text-cyan-400 font-bold">
            {i + 1}. {k}
          </div>
          <div className="text-[10px] text-zinc-500 mt-1 leading-snug">{v}</div>
        </div>
      ))}
    </div>
  );
}

function Meta({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-black/30 rounded px-2 py-1.5">
      <div className="text-zinc-600 text-[10px]">{label}</div>
      <div className="text-zinc-200">{value}</div>
      {sub && <div className="text-zinc-600 text-[10px]">{sub}</div>}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-bold text-zinc-300 mb-3 uppercase tracking-wide">{children}</h2>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-panel/50 border border-dashed border-edge rounded-lg p-6 text-center text-sm text-zinc-500">
      {children}
    </div>
  );
}

function Btn({
  children,
  onClick,
  busy,
  disabled,
  variant = "primary",
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  variant?: "primary" | "ghost" | "warn" | "oracle" | "teal";
}) {
  const styles: Record<string, string> = {
    primary: "border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/10",
    ghost: "border-zinc-600/40 text-zinc-400 hover:bg-zinc-500/10",
    warn: "border-amber-500/40 text-amber-200 hover:bg-amber-500/10",
    oracle: "border-fuchsia-500/40 text-fuchsia-200 hover:bg-fuchsia-500/10",
    teal: "border-teal-500/40 text-teal-200 hover:bg-teal-500/10",
  };
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      className={`text-[11px] px-2.5 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${styles[variant]}`}
    >
      {busy ? "…" : children}
    </button>
  );
}
