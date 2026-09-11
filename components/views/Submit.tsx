"use client";

import { useEffect, useState } from "react";
import { Button, Card, Chip, Eyebrow, EffectTags, eth } from "../ui";
import { useWallet } from "../wallet";
import { SCENARIOS, scenario, scenarioFiles, suggestName, type ScenarioId } from "@/lib/templates";
import { Effect, EFFECT_LABEL, effectList, type Repro } from "@/lib/types";
import {
  buildFinding,
  gradeFinding,
  listFromWallet,
  rememberListingKey,
  priceCap,
  txUrl,
  type AttestResponse,
  type FindingInput,
} from "@/lib/browser";
import type { ViewProps } from "./types";

type Graded = { attest: AttestResponse; ciphertext: `0x${string}`; key: `0x${string}`; contentHash: `0x${string}`; finding: Awaited<ReturnType<typeof buildFinding>> };
type FileRow = { path: string; body: string };

const EFFECT_FLAGS: Effect[] = [
  Effect.RunsOnInstall,
  Effect.ReadsSensitive,
  Effect.ExfilCredentials,
  Effect.ExfilEnv,
  Effect.NetworkEgress,
  Effect.SpawnsProcess,
  Effect.WritesFiles,
];

function toRows(files: Record<string, string>): FileRow[] {
  return Object.entries(files).map(([path, body]) => ({ path, body }));
}
function toRecord(rows: FileRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.path.trim()) out[r.path.trim()] = r.body;
  return out;
}

export default function Submit({ go }: ViewProps) {
  const w = useWallet();
  const [name, setName] = useState("");
  const [version, setVersion] = useState("1.0.0");

  // the package, fully editable
  const [files, setFiles] = useState<FileRow[]>([]);
  const [trigger, setTrigger] = useState<Repro["trigger"]>("install");
  const [entry, setEntry] = useState<string>("");

  // the finding
  const [claimedEffects, setClaimedEffects] = useState<number>(0);
  const [outcome, setOutcome] = useState("");
  const [expectedResult, setExpectedResult] = useState("");
  const [writeup, setWriteup] = useState("");
  const [remediation, setRemediation] = useState("");

  // auction params
  const [startPriceEth, setStartPriceEth] = useState(0.002);
  const [reservePct, setReservePct] = useState(25);
  const [durationSec, setDurationSec] = useState(30);
  const [contingentPct, setContingentPct] = useState(50);
  const [embargoSec, setEmbargoSec] = useState(30);

  const [cap, setCap] = useState<number | null>(null);
  const [busy, setBusy] = useState<"grade" | "list" | null>(null);
  const [graded, setGraded] = useState<Graded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [listed, setListed] = useState<{ id: number; hash: string } | null>(null);

  // Seed the form once from the first template, so a first-time seller has a
  // working, editable starting point rather than a blank page.
  useEffect(() => {
    if (files.length === 0 && !name) {
      loadTemplate("install-exfil", suggestName(), "1.0.0", "telemetry-cdn.xyz");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (w.address) priceCap(w.address).then((c) => setCap(Number(c) / 1e18)).catch(() => setCap(null));
  }, [w.address]);

  /** Overwrite the whole editable form from a template. Everything stays editable after. */
  function loadTemplate(id: ScenarioId, nm = name || suggestName(), ver = version || "1.0.0", host = "telemetry-cdn.xyz") {
    const sc = scenario(id);
    setName(nm);
    setVersion(ver);
    setFiles(toRows(scenarioFiles(id, nm, ver, host)));
    setTrigger(sc.repro.trigger);
    setEntry(sc.repro.entry ?? "");
    setClaimedEffects(sc.claimedEffects);
    setOutcome(sc.outcome(host));
    setExpectedResult(sc.expectedResult(host));
    setWriteup(sc.writeup(host));
    setRemediation(sc.remediation(host));
    setGraded(null);
    setListed(null);
    setError(null);
  }

  function setFile(i: number, patch: Partial<FileRow>) {
    setFiles((f) => f.map((row, j) => (j === i ? { ...row, ...patch } : row)));
    setGraded(null);
  }
  function addFile() {
    setFiles((f) => [...f, { path: "", body: "" }]);
  }
  function removeFile(i: number) {
    setFiles((f) => f.filter((_, j) => j !== i));
    setGraded(null);
  }

  const targetLabel = `npm:${name}@${version}`;
  const effectiveStart = cap != null ? Math.min(startPriceEth, cap) : startPriceEth;
  const canAct = w.address && !w.wrongChain;
  const repro: Repro = trigger === "require" ? { trigger, entry: entry.trim() } : { trigger };

  const input: FindingInput = {
    name,
    version,
    repro,
    claimedEffects,
    outcome,
    expectedResult,
    writeup,
    remediation,
    reporter: w.address ?? "anonymous",
    files: toRecord(files),
  };

  function validate(): string | null {
    if (!name.trim() || !version.trim()) return "Give the package a name and version.";
    if (files.length === 0 || files.every((f) => !f.path.trim())) return "Add at least one package file.";
    if (trigger === "require" && !entry.trim()) return "For a require trigger, name the entry file to require (e.g. lib.js).";
    if (trigger === "require" && !files.some((f) => f.path.trim() === entry.trim())) return `The entry file "${entry.trim()}" is not among the package files.`;
    if (!outcome.trim()) return "Write the one-sentence outcome buyers will see.";
    if (claimedEffects === 0) return "Claim at least one effect the oracle should verify.";
    return null;
  }

  async function grade() {
    if (!w.address) return;
    const v = validate();
    if (v) return setError(v);
    setBusy("grade");
    setError(null);
    setListed(null);
    try {
      const finding = await buildFinding(input);
      const res = await gradeFinding(w.address, finding);
      setGraded({ ...res, finding });
      if (!res.attest.ok) setError(`Oracle refused (${res.attest.refusal?.reason}): ${res.attest.refusal?.detail}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function list() {
    if (!w.address || !graded?.attest.ok) return;
    setBusy("list");
    setError(null);
    try {
      const res = await listFromWallet(w.address, graded, {
        startPriceEth,
        reserveFraction: reservePct / 100,
        durationSeconds: Math.round(durationSec),
        contingentBps: Math.round(contingentPct * 100),
        embargoSeconds: Math.round(embargoSec),
      });
      rememberListingKey(res.id, graded.key);
      setListed({ id: Number(res.id), hash: res.hash });
      w.refresh();
    } catch (e) {
      setError(humanizeTxError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="px-5 sm:px-10 lg:px-20 pt-11 pb-24 max-w-[1000px] flex flex-col gap-8">
      <div className="flex flex-col gap-2.5 max-w-[720px]">
        <Eyebrow>Sell a finding · as yourself</Eyebrow>
        <h1 className="text-[34px] font-bold tracking-[-0.025em]">List a real finding from your wallet.</h1>
        <p className="text-[15px] text-dim leading-relaxed">
          Write the package and its finding below — every field is yours to edit. Your browser packs the package, the oracle detonates <span className="text-txt">exactly those bytes</span> and signs what it observed, then <span className="text-txt">you</span> sign the listing transaction. Nothing is listed without the oracle&apos;s signature, and only your wallet pays the stake.
        </p>
      </div>

      {!w.address && (
        <Card className="p-6 flex items-center justify-between gap-4 flex-wrap">
          <div className="text-[14px] text-dim">
            Connect a wallet on Base Sepolia to submit a finding.
            {w.error && <div className="text-[12.5px] text-red-bright mt-1">{w.error}</div>}
          </div>
          <Button onClick={w.connect} busy={w.connecting}>Connect wallet</Button>
        </Card>
      )}
      {w.wrongChain && (
        <Card className="p-6 flex items-center justify-between gap-4 flex-wrap">
          <div className="text-[14px] text-amber-200">Your wallet is on the wrong network.</div>
          <Button variant="secondary" onClick={w.switchChain}>Switch to Base Sepolia</Button>
        </Card>
      )}

      {/* the package */}
      <Section title="The package" step="01">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="mono text-[10px] tracking-[0.14em] uppercase text-faint mr-1">Start from a template</span>
          {SCENARIOS.map((s) => (
            <button key={s.id} onClick={() => loadTemplate(s.id)} title={s.blurb} className="mono text-[11px] px-2.5 py-1.5 rounded border border-line hover:border-red/50 hover:text-red-bright transition-colors">
              {s.label}
            </button>
          ))}
          <span className="mono text-[10px] text-faint">— then edit anything</span>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Package name" value={name} onChange={(v) => (setName(v), setGraded(null))} mono suffix={<button className="mono text-[10px] text-faint hover:text-txt" onClick={() => setName(suggestName())}>randomize</button>} />
          <Field label="Version" value={version} onChange={(v) => (setVersion(v), setGraded(null))} mono />
        </div>

        <div className="flex flex-col gap-2">
          <span className="mono text-[10px] tracking-[0.14em] uppercase text-faint">Package files — this is the code the oracle detonates</span>
          {files.map((f, i) => (
            <div key={i} className="bg-bg border border-line rounded-md overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line">
                <input value={f.path} onChange={(e) => setFile(i, { path: e.target.value })} placeholder="path/in/package.js" className="mono text-[11px] bg-transparent text-txt outline-none flex-1 placeholder:text-faint" />
                <button onClick={() => removeFile(i)} title="Remove file" className="mono text-[11px] text-faint hover:text-red-bright shrink-0">remove ✕</button>
              </div>
              <textarea
                value={f.body}
                onChange={(e) => setFile(i, { body: e.target.value })}
                spellCheck={false}
                rows={Math.min(16, Math.max(3, f.body.split("\n").length))}
                className="mono text-[11.5px] text-dim bg-transparent w-full p-3 outline-none resize-y leading-relaxed whitespace-pre"
              />
            </div>
          ))}
          <button onClick={addFile} className="mono text-[11px] text-faint hover:text-txt self-start border border-dashed border-line2 rounded px-3 py-1.5 hover:border-red/40">+ add file</button>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="mono text-[10px] tracking-[0.14em] uppercase text-faint">How the oracle triggers it (repro)</span>
            <select value={trigger} onChange={(e) => (setTrigger(e.target.value as Repro["trigger"]), setGraded(null))} className="bg-bg border border-line rounded-md px-3 py-2 text-[13px] text-txt outline-none focus:border-red/50 mono">
              <option value="install">Run the npm install hooks (preinstall/install/postinstall)</option>
              <option value="require">Require one file, as a dependent would</option>
            </select>
          </label>
          {trigger === "require" && (
            <Field label="Entry file to require" value={entry} onChange={(v) => (setEntry(v), setGraded(null))} mono />
          )}
        </div>
        <div className="text-[12px] text-faint">The sandbox runs against canary credentials and a network sink. It has no real filesystem or internet — reads return planted canary secrets, and egress is recorded, so behaviour is observed, not the real host harmed.</div>
      </Section>

      {/* the finding */}
      <Section title="The finding" step="02">
        <div className="flex flex-col gap-2">
          <span className="mono text-[10px] tracking-[0.14em] uppercase text-faint">Claimed effects — the oracle refuses to sign unless every one appears in the trace</span>
          <div className="flex flex-wrap gap-2">
            {EFFECT_FLAGS.map((flag) => {
              const on = (claimedEffects & flag) !== 0;
              return (
                <button
                  key={flag}
                  onClick={() => (setClaimedEffects((c) => c ^ flag), setGraded(null))}
                  className={`mono text-[11px] px-2.5 py-1.5 rounded border transition-colors ${on ? "border-red/50 text-red-bright bg-red/[0.06]" : "border-line text-faint hover:text-txt"}`}
                >
                  {on ? "✓ " : ""}{EFFECT_LABEL[flag]}
                </button>
              );
            })}
          </div>
        </div>
        <Field label="Outcome — the one sentence buyers see before paying" value={outcome} onChange={(v) => (setOutcome(v), setGraded(null))} area />
        <Field label="Expected access — what the oracle verifies the run grants" value={expectedResult} onChange={setExpectedResult} area />
        <Field label="Writeup — revealed to the buyer, then to everyone" value={writeup} onChange={setWriteup} area />
        <Field label="Remediation" value={remediation} onChange={setRemediation} area />
      </Section>

      {/* the auction */}
      <Section title="The auction" step="03">
        <div className="grid sm:grid-cols-3 gap-3">
          <NumField label="Start price (ETH)" value={startPriceEth} onChange={setStartPriceEth} step={0.0005} min={0} hint={cap != null ? `your cap ${eth(cap)} ETH` : undefined} />
          <NumField label="Reserve (% of start)" value={reservePct} onChange={setReservePct} step={5} min={1} max={100} />
          <NumField label="Auction length (sec)" value={durationSec} onChange={setDurationSec} step={5} min={30} />
          <NumField label="Contingent (% on outcome)" value={contingentPct} onChange={setContingentPct} step={5} min={0} max={90} />
          <NumField label="Embargo (sec)" value={embargoSec} onChange={setEmbargoSec} step={5} min={30} />
        </div>
        {cap != null && startPriceEth > cap && (
          <div className="text-[12px] text-amber-300">Your reputation cap is {eth(cap)} ETH — the auction will open there, not at {eth(startPriceEth)}.</div>
        )}
        <div className="text-[12px] text-faint">Opens at {eth(effectiveStart)} ETH, decays to {eth(effectiveStart * (reservePct / 100))} ETH over {durationSec} s. {contingentPct}% of the clearing price is escrowed until an advisory confirms the finding.</div>
      </Section>

      {error && <div className="rounded-md border border-red/40 bg-red/10 text-red-100 px-4 py-3 text-[13px]">{error}</div>}

      {graded?.attest.ok && !listed && (
        <Card active className="p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Eyebrow>Oracle signed the grade</Eyebrow>
            <Chip tone="good">signature ready</Chip>
          </div>
          <EffectTags labels={graded.attest.effectLabels ?? []} />
          {graded.attest.judge && <div className="text-[12.5px] text-dim"><span className="text-faint">Access check ({graded.attest.judge.by}) · </span>{graded.attest.judge.reason}</div>}
          <div className="mono text-[11px] text-faint">novel · {graded.attest.novel ? "not in OSV" : "known"} · install base {graded.attest.installBase}</div>
        </Card>
      )}

      {listed && (
        <Card className="p-5 flex flex-col gap-3 border-emerald-400/30">
          <div className="flex items-center gap-2 text-emerald-300 text-[15px] font-semibold">✓ Listing #{listed.id} is live on Base Sepolia.</div>
          <div className="text-[13px] text-dim">Your finding is on the market at the falling auction price. Watch it, deliver the key when it sells, and disclose it after the embargo — all from the Market tab.</div>
          <div className="flex gap-2.5 flex-wrap">
            <a href={txUrl(listed.hash as `0x${string}`)} target="_blank" rel="noreferrer"><Button size="sm" variant="secondary">Listing tx ↗</Button></a>
            <Button size="sm" onClick={() => go("market", listed.id)}>Open it in the market</Button>
          </div>
        </Card>
      )}

      <div className="flex items-center gap-4 flex-wrap sticky bottom-14 bg-bg/80 backdrop-blur py-3 -mx-2 px-2 rounded-md">
        {!graded?.attest.ok ? (
          <Button size="lg" onClick={grade} busy={busy === "grade"} disabled={!canAct}>Grade with the oracle</Button>
        ) : (
          <Button size="lg" onClick={list} busy={busy === "list"} disabled={!canAct || !!listed}>Sign &amp; list from my wallet</Button>
        )}
        {graded?.attest.ok && !listed && <button onClick={() => setGraded(null)} className="mono text-[12px] text-faint hover:text-txt">edit and re-grade</button>}
        <span className="mono text-[11px] text-faint">{targetLabel}</span>
      </div>
    </div>
  );
}

function Section({ title, step, children }: { title: string; step: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-3 border-b border-line pb-2">
        <span className="mono text-[11px] text-red-bright">{step}</span>
        <span className="text-[16px] font-semibold">{title}</span>
      </div>
      {children}
    </section>
  );
}

function Field({ label, value, onChange, area, mono, suffix }: { label: string; value: string; onChange: (v: string) => void; area?: boolean; mono?: boolean; suffix?: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="mono text-[10px] tracking-[0.14em] uppercase text-faint flex items-center justify-between">{label}{suffix}</span>
      {area ? (
        <textarea value={value} onChange={(e) => onChange(e.target.value)} rows={2} className="bg-bg border border-line rounded-md px-3 py-2 text-[13px] text-txt outline-none focus:border-red/50 resize-y leading-relaxed" />
      ) : (
        <input value={value} onChange={(e) => onChange(e.target.value)} className={`bg-bg border border-line rounded-md px-3 py-2 text-[13px] text-txt outline-none focus:border-red/50 ${mono ? "mono" : ""}`} />
      )}
    </label>
  );
}

function NumField({ label, value, onChange, step, min, max, hint }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="mono text-[10px] tracking-[0.14em] uppercase text-faint">{label}</span>
      <input type="number" value={value} step={step} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} className="bg-bg border border-line rounded-md px-3 py-2 text-[13px] text-txt outline-none focus:border-red/50 mono" />
      {hint && <span className="mono text-[10px] text-faint">{hint}</span>}
    </label>
  );
}

function humanizeTxError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/User rejected|denied|4001/i.test(msg)) return "You rejected the transaction in your wallet.";
  if (/insufficient funds/i.test(msg)) return "Insufficient funds for the stake plus gas. Fund this wallet from a Base Sepolia faucet.";
  if (/DuplicateArtifact/i.test(msg)) return "This exact package is already listed. Change the name, version, or a file to make a distinct artifact.";
  if (/PriceAboveRepCap/i.test(msg)) return "Start price is above your reputation cap. Lower it.";
  return msg;
}
