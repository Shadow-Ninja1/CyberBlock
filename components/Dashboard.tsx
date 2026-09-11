"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MarketView } from "@/lib/view";
import type { LogLine } from "@/lib/types";
import { Chip, Icon, short, useTick } from "./ui";
import { nextStep } from "./lifecycle";
import Overview from "./views/Overview";
import Trade from "./views/Trade";
import Market from "./views/Market";
import Verifier from "./views/Verifier";
import Submit from "./views/Submit";
import Ledger from "./views/Ledger";
import type { Act, View } from "./views/types";
import { WalletProvider, WalletButton } from "./wallet";

const VIEWS: { id: View; label: string; icon: () => React.ReactElement }[] = [
  { id: "overview", label: "Overview", icon: Icon.Grid },
  { id: "trade", label: "Run a trade", icon: Icon.Play },
  { id: "sell", label: "Sell a finding", icon: Icon.Upload },
  { id: "market", label: "Market", icon: Icon.List },
  { id: "verifier", label: "Verifier", icon: Icon.Shield },
];

function viewFromHash(): View {
  if (typeof window === "undefined") return "overview";
  const h = window.location.hash.replace("#", "") as View;
  return VIEWS.some((v) => v.id === h) ? h : "overview";
}

export default function Dashboard({ initial, initialError }: { initial: MarketView | null; initialError: string | null }) {
  const [view, setView] = useState<MarketView | null>(initial);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [current, setCurrent] = useState<View>("overview");
  const [selected, setSelected] = useState<number | null>(null);
  const sinceRef = useRef(0);
  const serverNow = view?.now ?? Math.floor(Date.now() / 1000);
  const now = useTick(serverNow);

  useEffect(() => {
    setCurrent(viewFromHash());
    const onHash = () => setCurrent(viewFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = useCallback((v: View, listingId?: number) => {
    if (listingId != null) setSelected(listingId);
    window.location.hash = v;
    setCurrent(v);
    window.scrollTo({ top: 0 });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/state?since=${sinceRef.current}`, { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) return setError(data.error);
      setError(null);
      setView(data);
      if (data.logs?.length) {
        sinceRef.current = data.logs[data.logs.length - 1].at;
        setLogs((p) => [...p, ...data.logs].slice(-200));
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

  const act: Act = useCallback(
    async (key, body) => {
      setBusy(key);
      setRefusal(null);
      try {
        const res = await fetch("/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
  const deployed = !!c && c.address !== "0x0000000000000000000000000000000000000000";
  const props = { listings, now, busy, act, step, go, explorer: c?.explorer, sandboxHash: view?.sandbox.sandboxHash };

  return (
    <WalletProvider>
    <div className="min-h-screen">
      {/* rail */}
      <nav className="hidden md:flex fixed left-0 top-0 bottom-0 w-[72px] border-r border-line bg-[#070709] flex-col items-center pt-5 gap-2 z-40">
        <button onClick={() => go("overview")} className="w-9 h-9 rounded-md bg-red grid place-items-center mb-4 shadow-[0_0_24px_-4px_rgba(229,32,46,.9)]" title="CyberBlock">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="square"><path d="M12 3 4 6.5v5c0 4.6 3.4 8.4 8 9.5 4.6-1.1 8-4.9 8-9.5v-5L12 3Z" /><path d="M9 12l2 2 4-4" /></svg>
        </button>
        {VIEWS.map((v) => {
          const on = current === v.id;
          return (
            <button
              key={v.id}
              onClick={() => go(v.id)}
              title={v.label}
              className={`w-11 h-11 rounded-md grid place-items-center transition-colors [&>svg]:w-5 [&>svg]:h-5 ${on ? "bg-red/15 text-red-bright shadow-[inset_0_0_0_1px_rgba(229,32,46,.45)]" : "text-faint hover:text-txt hover:bg-white/5"}`}
            >
              <v.icon />
            </button>
          );
        })}
      </nav>

      <div className="md:pl-[72px] pb-11">
        {/* top bar */}
        <header className="sticky top-0 z-30 h-14 border-b border-line bg-bg/85 backdrop-blur-xl flex items-center justify-between px-6 lg:px-10">
          <div className="flex items-center gap-3.5">
            <span className="font-bold text-[15px] tracking-tight">CyberBlock</span>
            <span className="mono text-[11px] uppercase tracking-[0.18em] text-faint hidden sm:inline">{VIEWS.find((v) => v.id === current)?.label}</span>
            <div className="md:hidden flex gap-1 ml-2">
              {VIEWS.map((v) => (
                <button key={v.id} onClick={() => go(v.id)} className={`w-8 h-8 rounded grid place-items-center [&>svg]:w-4 [&>svg]:h-4 ${current === v.id ? "text-red-bright bg-red/15" : "text-faint"}`}>
                  <v.icon />
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <WalletButton />
            <Chip tone={deployed ? "good" : "bad"}>
              <span className={`w-1.5 h-1.5 rounded-full ${deployed ? "bg-emerald-400 live-dot" : "bg-red-bright"}`} />
              {c?.chainId === 84532 ? "Base Sepolia" : c ? `local #${c.chainId}` : "no chain"}
            </Chip>
            {deployed && c && (
              <a href={c.addressUrl} target="_blank" rel="noreferrer" title="Contract on Basescan" className="hidden sm:block">
                <Chip>{short(c.address)} ↗</Chip>
              </a>
            )}
            <a href="/api/sandbox" target="_blank" rel="noreferrer" title="The exact sandbox runtime behind every grade" className="hidden lg:block">
              <Chip>sandbox {view?.sandbox.sandboxHash?.slice(2, 8)} ↗</Chip>
            </a>
          </div>
        </header>

        {(error || !deployed || refusal) && (
          <div className="px-6 lg:px-10 pt-4 flex flex-col gap-2">
            {!deployed && <Banner tone="bad">No contract address configured. Deploy the contract and restart the app.</Banner>}
            {error && <Banner tone="bad">{error}</Banner>}
            {refusal && (
              <Banner tone="warn" onClose={() => setRefusal(null)}>
                <strong className="text-amber-200">The verifier refused to sign. </strong>
                {refusal.replace(/^REFUSED \([a-z-]+\): /, "")}
                <span className="text-faint"> No signature means no listing.</span>
              </Banner>
            )}
          </div>
        )}

        <main key={current} className="rise">
          {current === "overview" && <Overview {...props} />}
          {current === "trade" && <Trade {...props} />}
          {current === "market" && <Market {...props} selected={selected} setSelected={setSelected} />}
          {current === "sell" && <Submit {...props} />}
          {current === "verifier" && <Verifier {...props} />}
        </main>
      </div>

      <Ledger logs={logs} explorer={c?.explorer} />
    </div>
    </WalletProvider>
  );
}

function Banner({ children, tone, onClose }: { children: React.ReactNode; tone: "bad" | "warn"; onClose?: () => void }) {
  const t = tone === "bad" ? "bg-red/10 border-red/40 text-red-100" : "bg-amber-500/10 border-amber-500/30 text-amber-100";
  return (
    <div className={`rounded-md border px-4 py-3 text-[13px] flex gap-3 rise ${t}`}>
      <div className="flex-1">{children}</div>
      {onClose && <button onClick={onClose} className="opacity-60 hover:opacity-100 shrink-0">✕</button>}
    </div>
  );
}
