"use client";

import { useState } from "react";
import type { ListingView } from "@/lib/view";
import { Button, Card, Eyebrow, short } from "../ui";
import type { ViewProps } from "./types";

export default function Verifier({ listings, busy, act, sandboxHash }: ViewProps) {
  const disclosed = listings.filter((l) => l.status === 6);
  return (
    <div className="px-10 lg:px-20 pt-11 pb-24 max-w-[1300px] flex flex-col gap-14">
      <div className="flex flex-col gap-2.5 max-w-[720px]">
        <Eyebrow>The oracle & the arbiter</Eyebrow>
        <h1 className="text-[34px] font-bold tracking-[-0.025em]">Two parties you have to trust. Here is how you check them.</h1>
        <p className="text-[15px] text-dim leading-relaxed">
          One oracle detonates every repro and signs what it observed. A separate arbiter rules on challenges. Neither can quietly lie: the sandbox is public, deterministic code and the package is content-addressed, so every grade is reproducible after disclosure.
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-3">
        <TrustCard n="01" title="The sandbox is public code" body={<>Its hash <span className="mono text-txt">{sandboxHash?.slice(0, 12)}</span> is committed inside every grade. <a href="/api/sandbox" target="_blank" rel="noreferrer">Read the runtime ↗</a></>} />
        <TrustCard n="02" title="Grades are observed behaviour" body="The oracle runs the repro against canary credentials and a network sink. The trace hash is committed on-chain; anyone can re-detonate the committed package and reproduce it exactly." />
        <TrustCard n="03" title="Oracle and arbiter are split" body="The oracle signs; a different key rules on challenges by re-detonating harder. A dishonest grade needs two independent parties to survive a challenge." />
      </div>

      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Eyebrow tone="dim">Re-verify a disclosed finding</Eyebrow>
          <div className="text-[20px] font-semibold">Re-detonate the repro yourself</div>
          <p className="text-[13.5px] text-dim max-w-[640px]">The app re-downloads the committed package, runs the committed sandbox on it, and compares the resulting trace and effects to what the oracle signed.</p>
        </div>
        {disclosed.length === 0 ? (
          <Card className="p-8 text-[13px] text-dim">No finding has been disclosed yet. Complete a trade first, then come back here.</Card>
        ) : (
          <div className="flex flex-col gap-3">{disclosed.map((l) => <ReverifyRow key={l.id} l={l} />)}</div>
        )}
      </section>

      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-1.5">
          <Eyebrow tone="dim">Stress test</Eyebrow>
          <div className="text-[20px] font-semibold">Try to sell bad intel</div>
          <p className="text-[13.5px] text-dim max-w-[640px]">Ask the oracle to grade something worthless and watch it refuse. Without a signature the contract will not accept the listing. The refusal shows up in the ledger.</p>
        </div>
        <div className="flex gap-3 flex-wrap">
          <Button variant="secondary" busy={busy === "att-clean"} onClick={() => act("att-clean", { action: "attest-only", findingFile: "clean-lib-2.0.0.json" })}>Sell a bug that doesn&apos;t exist</Button>
          <Button variant="secondary" busy={busy === "att-hype"} onClick={() => act("att-hype", { action: "attest-only", findingFile: "overhyped-logger-1.0.3.json" })}>Inflate a real one</Button>
        </div>
      </section>

      <p className="text-[12px] text-faint leading-relaxed max-w-[760px]">
        Demo windows are compressed to minutes; production would use hours and days, and a real dynamic sandbox in a pinned container. Testnet only, no real funds. Packages are local fixtures, never published to the real npm registry. The honest next steps are several independent detonators whose stake is slashed when a re-run contradicts them, and running the sandbox inside a zkVM so the grade carries its own proof.
      </p>
    </div>
  );
}

function TrustCard({ n, title, body }: { n: string; title: string; body: React.ReactNode }) {
  return (
    <Card className="p-5 flex flex-col gap-3 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-8 h-[2px] bg-red" />
      <div className="mono text-[10px] text-red-bright">{n}</div>
      <div className="text-[15px] font-semibold">{title}</div>
      <div className="text-[13px] text-dim leading-relaxed">{body}</div>
    </Card>
  );
}

function ReverifyRow({ l }: { l: ListingView }) {
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card className="p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex flex-col gap-1">
          <div className="mono text-[16px] font-bold">{l.targetLabel.replace("npm:", "")}</div>
          <div className="mono text-[11px] text-faint">effects {l.effects} · trace {short(l.traceHash)} · sandbox {short(l.sandboxHash)}</div>
        </div>
        <Button busy={busy} onClick={async () => {
          setBusy(true);
          const r = await fetch("/api/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: l.id }) });
          setRes(await r.json());
          setBusy(false);
        }}>Re-detonate the repro</Button>
      </div>
      {res && (
        <div className="rise flex flex-col gap-2 border-t border-line pt-4">
          <div className={`text-[14px] font-semibold ${res.reproduced ? "text-emerald-300" : "text-red-bright"}`}>
            {res.reproduced ? "✓ Reproduced the attested trace and effects exactly." : "✗ Did not reproduce the attested grade."}
          </div>
          {res.matches && (
            <div className="flex gap-5 mono text-[11px] flex-wrap">
              {Object.entries(res.matches).map(([k, v]) => (
                <span key={k} className={v ? "text-emerald-300" : "text-red-bright"}>{v ? "✓" : "✗"} {k.replace("Hash", " hash")}</span>
              ))}
            </div>
          )}
          {res.expectedResult && (
            <div className="text-[12px] text-dim"><span className="text-faint">Declared access · </span>{res.expectedResult}</div>
          )}
          {res.rerun?.captures?.length > 0 && (
            <div className="flex flex-col gap-1.5 mt-1">
              <div className="mono text-[10px] tracking-[0.14em] uppercase text-faint">Concrete artifacts the run captured</div>
              {res.rerun.captures.map((c: any, i: number) => (
                <div key={i} className="mono text-[11px] bg-bg border border-line rounded px-3 py-2 flex flex-col gap-0.5">
                  <span className="text-red-bright">{c.kind} · {c.summary}{c.secretsLeaked?.length ? ` · leaked ${c.secretsLeaked.join(", ")}` : ""}</span>
                  {c.data && <span className="text-dim break-all">{c.data}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
