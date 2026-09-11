/**
 * The oracle.
 *
 * A seller submits a finding that includes a `repro` — how to reproduce the
 * behaviour — and the effects they claim it produces. The oracle:
 *
 *   0. confirms the seal decrypts under K to the committed finding,
 *   1. DETONATES the repro in the instrumented sandbox and reads the trace,
 *   2. confirms every claimed effect actually appears in that trace (mechanical),
 *   3. optionally asks Claude to corroborate that the trace substantiates the
 *      public outcome sentence (a narrow yes/no; it never sets the on-chain grade),
 *   4. checks OSV for prior disclosure.
 *
 * If all pass it signs an EIP-712 attestation over the trace hash, the sandbox
 * hash, the observed effects, and the outcome hash. Nothing can be listed without
 * it. There is no severity score: buyers price the finding from the observed
 * effects and the one-sentence outcome themselves.
 *
 * The grade that gates money (the effects bitmask + trace hash) is produced
 * mechanically by re-runnable code, so a stranger can reproduce it after disclosure.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256, toHex, type Hex } from "viem";
import { run, sha256Hex } from "./sandbox";
import { canonicalize, openFinding, keyHashOf } from "./crypto";
import { checkNovelty, weeklyDownloads } from "./osv";
import { signAttestation } from "./chain";
import { effectList, type AttestationRefusal, type Finding, type SignedAttestation, type SandboxResult, type NoveltyResult } from "./types";

const VOUCHER_TTL_SECONDS = 30 * 60;

export interface AttestRequest {
  finding: Finding;
  ciphertext: Hex;
  key: Hex;
}

export type AttestOutcome =
  | (SignedAttestation & { ok: true; sandbox: SandboxResult; novelty: NoveltyResult })
  | AttestationRefusal;

/** Largest artifact a seller may embed inline in the sealed finding (base64 data URL). */
export const MAX_INLINE_ARTIFACT_BYTES = 256 * 1024;

export async function loadArtifact(finding: Finding): Promise<Buffer | null> {
  const ref = finding.target.artifact;
  // A wallet seller may bring their own package as an inline data URL: the bytes
  // then travel inside the sealed finding, so the arbiter and any re-verifier get
  // exactly the tarball that was graded.
  const inline = /^data:[^;,]*;base64,(.*)$/s.exec(ref);
  if (inline) {
    const buf = Buffer.from(inline[1], "base64");
    return buf.length > 0 && buf.length <= MAX_INLINE_ARTIFACT_BYTES ? buf : null;
  }
  if (/^https?:\/\//.test(ref)) {
    const res = await fetch(ref, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
  const path = resolve(process.cwd(), ref);
  if (!path.startsWith(resolve(process.cwd(), "fixtures"))) return null; // no arbitrary reads
  return existsSync(path) ? readFileSync(path) : null;
}

/** The effects the seller claims that the sandbox did NOT observe. Empty = supported. */
function unsupportedEffects(finding: Finding, sandbox: SandboxResult): { flag: number; label: string }[] {
  return effectList(finding.claimedEffects).filter((e) => (sandbox.effects & e.flag) === 0);
}

export async function attest(req: AttestRequest): Promise<AttestOutcome> {
  const { finding, ciphertext, key } = req;

  // 0. The seal must actually contain the finding the oracle is about to grade.
  let contentHash: Hex;
  try {
    const plaintext = Buffer.from(canonicalize(finding), "utf8");
    contentHash = keccak256(toHex(plaintext));
    openFinding(ciphertext, key, contentHash);
  } catch (e) {
    return {
      ok: false,
      reason: "seal-mismatch",
      detail: "The ciphertext does not decrypt under the supplied key to the supplied finding.",
      facts: { error: e instanceof Error ? e.message : String(e) },
    };
  }

  // 1. Detonate the repro in the sandbox.
  const tarball = await loadArtifact(finding);
  if (!tarball) {
    return { ok: false, reason: "artifact-unavailable", detail: `Could not fetch the artifact at ${finding.target.artifact}.`, facts: { artifact: finding.target.artifact } };
  }
  const sandbox = run(tarball, finding.repro);

  if (sandbox.effects === 0) {
    return {
      ok: false,
      reason: "not-reproducible",
      detail: "Detonating the repro produced no observable effect. There is no finding to sell.",
      facts: { artifactHash: sandbox.artifactHash, sandboxHash: sandbox.sandboxHash, trace: sandbox.trace, error: sandbox.error },
    };
  }

  // 2. Does every claimed effect actually appear in the trace? (mechanical gate)
  const unsupported = unsupportedEffects(finding, sandbox);
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: "claims-unsupported",
      detail: `The repro did not reproduce ${unsupported.length} claimed effect(s): ${unsupported.map((u) => u.label).join(", ")}.`,
      facts: {
        artifactHash: sandbox.artifactHash,
        claimed: effectList(finding.claimedEffects).map((e) => e.label),
        observed: effectList(sandbox.effects).map((e) => e.label),
        trace: sandbox.trace,
      },
    };
  }

  // 3. Did the run actually grant the access the seller declared? The LLM checks the
  //    concrete captured artifacts against the seller's expectedResult. This is the
  //    "new access granted" test: it gates the listing when an API key is present.
  const judge = await judgeExploit(finding, sandbox);
  if (judge && !judge.achieved) {
    return {
      ok: false,
      reason: "access-not-demonstrated",
      detail: `The captured artifacts do not demonstrate the declared access: ${judge.reason}`,
      facts: { expectedResult: finding.expectedResult, captures: sandbox.captures, observed: effectList(sandbox.effects).map((e) => e.label) },
    };
  }

  // 4. Does the world already know?
  const novelty = await checkNovelty({ name: finding.target.name, version: finding.target.version });
  if (!novelty.novel) {
    return {
      ok: false,
      reason: novelty.error ? "novelty-unknown" : "already-public",
      detail: novelty.error
        ? `OSV could not be reached, so novelty cannot be asserted: ${novelty.error}`
        : `OSV already lists this package version as ${novelty.osvIds.join(", ")}. It is not intel, it is news.`,
      facts: { osvIds: novelty.osvIds, checkedAt: novelty.checkedAt, artifactHash: sandbox.artifactHash },
    };
  }

  const installBase = await weeklyDownloads(finding.target.name);

  const att = {
    artifactHash: sandbox.artifactHash,
    contentHash,
    keyHash: keyHashOf(key),
    traceHash: sandbox.traceHash,
    sandboxHash: sandbox.sandboxHash,
    outcomeHash: keccak256(toHex(Buffer.from(finding.outcome, "utf8"))),
    effects: sandbox.effects,
    novel: true,
    installBase,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + VOUCHER_TTL_SECONDS),
  };

  const signature = await signAttestation(att);

  return {
    ok: true,
    att,
    signature,
    sandbox,
    novelty,
    meta: {
      targetLabel: `npm:${finding.target.name}@${finding.target.version}`,
      outcome: finding.outcome,
      sandboxVersion: sandbox.sandboxVersion,
      effects: sandbox.effects,
      osvIds: novelty.osvIds,
      checkedAt: novelty.checkedAt,
      judge: judge ?? undefined,
      captures: sandbox.captures,
    },
  };
}

/**
 * The "new access granted" check. Given the seller's declared expectedResult and the
 * CONCRETE artifacts the detonation captured (the exfiltrated payload decoded, the
 * spawned command, the dynamically-evaluated second stage, the credential file read),
 * the LLM decides whether the run actually demonstrates that access. This gates the
 * attestation; the effects bitmask above stays the reproducible, money-gating part.
 * Falls back to a mechanical check (at least one concrete artifact was captured) when
 * no API key is set.
 */
async function judgeExploit(finding: Finding, sandbox: SandboxResult): Promise<{ achieved: boolean; reason: string; by: "claude" | "mechanical" } | null> {
  const captures = sandbox.captures;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const achieved = captures.length > 0;
    return { achieved, reason: achieved ? `${captures.length} concrete artifact(s) captured` : "no concrete artifact captured", by: "mechanical" };
  }
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: key });
    const msg = await client.messages.create({
      // cast: installed SDK types predate `thinking`, which the API accepts at runtime.
      model: "claude-opus-5",
      max_tokens: 400,
      thinking: { type: "adaptive" },
      system:
        "You verify supply-chain malware exploits. A package was detonated in an instrumented sandbox with canary credentials and a network sink. You are given the seller's declared EXPECTED_RESULT (the access or output the exploit should grant) and the CONCRETE ARTIFACTS the run actually captured — exfiltrated payloads (decoded), spawned commands, dynamically-evaluated code, credential files read. Decide only whether the captured artifacts genuinely demonstrate the declared access. A payload that carries the canary token to an attacker host demonstrates credential theft; a decoded stage that reaches an external host demonstrates code execution. Reply as strict JSON {\"achieved\": boolean, \"reason\": string}. reason under 35 words, citing specific captured artifacts.",
      messages: [
        {
          role: "user",
          content: `EXPECTED_RESULT: ${finding.expectedResult}\nCAPTURED ARTIFACTS: ${JSON.stringify(captures)}\nDo the captured artifacts demonstrate this access?`,
        },
      ],
    } as any);
    const text = msg.content.find((c) => c.type === "text")?.text ?? "";
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return { achieved: Boolean(json.achieved), reason: String(json.reason), by: "claude" };
  } catch {
    const achieved = captures.length > 0;
    return { achieved, reason: achieved ? `${captures.length} concrete artifact(s) captured` : "no concrete artifact captured", by: "mechanical" };
  }
}


// ------------------------------------------------------------------- challenge

export interface ChallengeVerdict {
  sellerWins: boolean;
  reason: string;
  rerunTraceHash: Hex;
  facts: Record<string, unknown>;
}

/**
 * The arbiter's stricter procedure. A challenge is NOT a single re-run of the
 * oracle (that would always agree with itself). The arbiter re-detonates the repro
 * MULTIPLE times and upholds the seller only if every run reproduces the exact
 * attested trace hash and the attested effects, the artifact still hashes to the
 * attested bytes, the sandbox has not changed, and OSV still has no entry. Any
 * divergence — a flaky repro, a swapped artifact, a changed sandbox, effects that
 * no longer appear — overturns the grade.
 */
export async function adjudicate(args: {
  finding: Finding;
  attestedArtifactHash: Hex;
  attestedTraceHash: Hex;
  attestedSandboxHash: Hex;
  attestedEffects: number;
}): Promise<ChallengeVerdict> {
  const tarball = await loadArtifact(args.finding);
  if (!tarball) {
    return { sellerWins: false, reason: "Artifact could no longer be fetched, so the grade cannot be upheld.", rerunTraceHash: "0x", facts: { artifact: args.finding.target.artifact } };
  }

  const observedArtifact = sha256Hex(tarball);
  if (observedArtifact.toLowerCase() !== args.attestedArtifactHash.toLowerCase()) {
    return { sellerWins: false, reason: "The artifact no longer matches the attested hash.", rerunTraceHash: "0x", facts: { attested: args.attestedArtifactHash, observed: observedArtifact } };
  }

  // Re-detonate several times; the repro must be perfectly reproducible.
  const runs = [run(tarball, args.finding.repro), run(tarball, args.finding.repro), run(tarball, args.finding.repro)];
  const hashes = new Set(runs.map((r) => r.traceHash.toLowerCase()));
  const rerun = runs[0];

  if (hashes.size !== 1) {
    return { sellerWins: false, reason: "The repro is not deterministic: repeated runs produced different traces.", rerunTraceHash: rerun.traceHash, facts: { traceHashes: [...hashes] } };
  }
  if (rerun.sandboxHash.toLowerCase() !== args.attestedSandboxHash.toLowerCase()) {
    return { sellerWins: false, reason: "The sandbox runtime has changed since attestation, so the grade is not reproducible.", rerunTraceHash: rerun.traceHash, facts: { attested: args.attestedSandboxHash, current: rerun.sandboxHash } };
  }
  if (rerun.traceHash.toLowerCase() !== args.attestedTraceHash.toLowerCase()) {
    return { sellerWins: false, reason: "Re-detonation produced a different trace than the one attested.", rerunTraceHash: rerun.traceHash, facts: { attested: args.attestedTraceHash, rerun: rerun.traceHash, trace: rerun.trace } };
  }
  if (rerun.effects !== args.attestedEffects) {
    return { sellerWins: false, reason: `Re-run observed effects ${rerun.effects}, not the attested ${args.attestedEffects}.`, rerunTraceHash: rerun.traceHash, facts: { attested: args.attestedEffects, rerun: rerun.effects } };
  }

  const novelty = await checkNovelty({ name: args.finding.target.name, version: args.finding.target.version });
  if (!novelty.novel) {
    return { sellerWins: false, reason: `OSV now lists this as ${novelty.osvIds.join(", ")}, so it was not exclusive intel.`, rerunTraceHash: rerun.traceHash, facts: { osvIds: novelty.osvIds } };
  }

  return {
    sellerWins: true,
    reason: `Sandbox ${rerun.sandboxVersion} re-detonated the repro 3× on artifact ${observedArtifact.slice(0, 12)}…, each time reproducing the attested trace and effects (${effectList(rerun.effects).map((e) => e.label).join(", ")}); OSV still has no entry.`,
    rerunTraceHash: rerun.traceHash,
    facts: { artifactHash: observedArtifact, effects: rerun.effects, trace: rerun.trace, checkedAt: novelty.checkedAt },
  };
}
