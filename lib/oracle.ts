/**
 * The oracle.
 *
 * It does exactly three things, all of them checkable:
 *   1. re-runs the committed detector against the real artifact bytes,
 *   2. confirms the seller's claimed indicators actually appear in what the
 *      detector found, so the plaintext matches the grade,
 *   3. asks OSV whether the world already knows.
 *
 * If all three pass it signs an EIP-712 voucher. Nothing can be listed without one,
 * so grading happens before a price exists, not after a buyer has been burned.
 *
 * It is deliberately not an LLM. Every grade has to be reproducible by a stranger
 * running `analyze()` over the attested artifact hash.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256, toHex, type Hex } from "viem";
import { analyze, sha256Hex } from "./detector";
import { canonicalize, openFinding, keyHashOf } from "./crypto";
import { checkNovelty, weeklyDownloads } from "./osv";
import { signAttestation } from "./chain";
import type {
  AttestationRefusal,
  Finding,
  SignedAttestation,
  DetectorResult,
  NoveltyResult,
} from "./types";

const VOUCHER_TTL_SECONDS = 30 * 60;

export interface AttestRequest {
  finding: Finding;
  /** The sealed blob the seller intends to publish on-chain. */
  ciphertext: Hex;
  /** The symmetric key, so the oracle can verify the seal before signing it. */
  key: Hex;
}

export type AttestOutcome =
  | (SignedAttestation & { ok: true; detector: DetectorResult; novelty: NoveltyResult })
  | AttestationRefusal;

/** Loads the artifact the finding points at. Local fixtures or an https tarball. */
async function loadArtifact(finding: Finding): Promise<Buffer | null> {
  const ref = finding.target.artifact;
  if (/^https?:\/\//.test(ref)) {
    const res = await fetch(ref, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  }
  const path = resolve(process.cwd(), ref);
  if (!path.startsWith(resolve(process.cwd(), "fixtures"))) return null; // no arbitrary reads
  return existsSync(path) ? readFileSync(path) : null;
}

/**
 * Are the seller's claimed indicators actually in the artifact? This is what stops
 * a seller from wrapping a real detector hit in a fabricated writeup, and what
 * makes the "not reproducible" refusal a real check rather than a rigged one.
 */
function claimsSupported(finding: Finding, detector: DetectorResult) {
  const haystack = detector.signals
    .map((s) => `${s.rule} ${s.file} ${s.evidence}`)
    .join("\n")
    .toLowerCase();

  const claimed = [
    ...finding.iocs.domains.map((d) => ({ kind: "domain", value: d })),
    ...finding.iocs.files.map((f) => ({ kind: "file", value: f })),
    ...finding.iocs.snippets.map((s) => ({ kind: "snippet", value: s })),
  ];

  const unsupported = claimed.filter((c) => !haystack.includes(c.value.toLowerCase()));
  return { claimed, unsupported };
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

  // 1. Re-run the detector against the real bytes.
  const tarball = await loadArtifact(finding);
  if (!tarball) {
    return {
      ok: false,
      reason: "artifact-unavailable",
      detail: `Could not fetch the artifact at ${finding.target.artifact}.`,
      facts: { artifact: finding.target.artifact },
    };
  }

  const detector = analyze(tarball);

  if (detector.severity === 0) {
    return {
      ok: false,
      reason: "not-reproducible",
      detail: "The detector found nothing in this artifact. There is no finding to sell.",
      facts: {
        artifactHash: detector.artifactHash,
        detectorHash: detector.detectorHash,
        signals: 0,
      },
    };
  }

  // 2. Do the seller's claims match what the detector actually saw?
  const { claimed, unsupported } = claimsSupported(finding, detector);
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: "claims-unsupported",
      detail: `${unsupported.length} of ${claimed.length} claimed indicators do not appear in the artifact.`,
      facts: {
        artifactHash: detector.artifactHash,
        detectorHash: detector.detectorHash,
        unsupported: unsupported.map((u) => `${u.kind}:${u.value}`),
        firedRules: detector.signals.map((s) => s.rule),
      },
    };
  }

  // 3. Does the world already know?
  const novelty = await checkNovelty({ name: finding.target.name, version: finding.target.version });
  if (!novelty.novel) {
    return {
      ok: false,
      reason: novelty.error ? "novelty-unknown" : "already-public",
      detail: novelty.error
        ? `OSV could not be reached, so novelty cannot be asserted: ${novelty.error}`
        : `OSV already lists this package version as ${novelty.osvIds.join(", ")}. It is not intel, it is news.`,
      facts: {
        osvIds: novelty.osvIds,
        checkedAt: novelty.checkedAt,
        artifactHash: detector.artifactHash,
        severity: detector.severity,
      },
    };
  }

  const installBase = await weeklyDownloads(finding.target.name);

  const att = {
    artifactHash: detector.artifactHash,
    contentHash,
    keyHash: keyHashOf(key),
    detectorHash: detector.detectorHash,
    severity: detector.severity,
    vulnClass: detector.vulnClass,
    novel: true,
    installBase,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + VOUCHER_TTL_SECONDS),
  };

  const signature = await signAttestation(att);

  return {
    ok: true,
    att,
    signature,
    detector,
    novelty,
    meta: {
      targetLabel: `npm:${finding.target.name}@${finding.target.version}`,
      detectorVersion: detector.detectorVersion,
      signalRules: detector.signals.map((s) => s.rule).filter((r, i, a) => a.indexOf(r) === i),
      osvIds: novelty.osvIds,
      checkedAt: novelty.checkedAt,
    },
  };
}

// ------------------------------------------------------------------- disputes

export interface DisputeVerdict {
  sellerWins: boolean;
  reason: string;
  facts: Record<string, unknown>;
}

/**
 * A dispute can only ever be about the attestation being wrong. So resolving one
 * means re-running the same three checks against the same artifact hash and seeing
 * whether the signed grade still stands.
 */
export async function adjudicate(args: {
  finding: Finding;
  attestedArtifactHash: Hex;
  attestedSeverity: number;
  attestedDetectorHash: Hex;
}): Promise<DisputeVerdict> {
  const tarball = await loadArtifact(args.finding);
  if (!tarball) {
    return {
      sellerWins: false,
      reason: "Artifact could no longer be fetched, so the grade cannot be upheld.",
      facts: { artifact: args.finding.target.artifact },
    };
  }

  const observed = sha256Hex(tarball);
  if (observed.toLowerCase() !== args.attestedArtifactHash.toLowerCase()) {
    return {
      sellerWins: false,
      reason: "The artifact at the reported location no longer matches the attested hash.",
      facts: { attested: args.attestedArtifactHash, observed },
    };
  }

  const rerun = analyze(tarball);

  if (rerun.detectorHash.toLowerCase() !== args.attestedDetectorHash.toLowerCase()) {
    return {
      sellerWins: false,
      reason: "The detector has changed since attestation, so the grade is not reproducible.",
      facts: { attested: args.attestedDetectorHash, current: rerun.detectorHash },
    };
  }

  if (rerun.severity !== args.attestedSeverity) {
    return {
      sellerWins: false,
      reason: `Re-run graded this ${rerun.severity}, not the attested ${args.attestedSeverity}.`,
      facts: { attested: args.attestedSeverity, rerun: rerun.severity },
    };
  }

  const novelty = await checkNovelty({
    name: args.finding.target.name,
    version: args.finding.target.version,
  });
  if (!novelty.novel) {
    return {
      sellerWins: false,
      reason: `OSV now lists this as ${novelty.osvIds.join(", ")}, so it was not exclusive intel.`,
      facts: { osvIds: novelty.osvIds, checkedAt: novelty.checkedAt },
    };
  }

  const { unsupported } = claimsSupported(args.finding, rerun);
  if (unsupported.length > 0) {
    return {
      sellerWins: false,
      reason: "Claimed indicators are not present on re-run.",
      facts: { unsupported: unsupported.map((u) => u.value) },
    };
  }

  return {
    sellerWins: true,
    reason: `Detector ${rerun.detectorVersion} re-run on artifact ${observed.slice(0, 12)}… reproduces severity ${rerun.severity} and all claimed indicators; OSV still has no entry.`,
    facts: {
      artifactHash: observed,
      severity: rerun.severity,
      rules: rerun.signals.map((s) => s.rule).filter((r, i, a) => a.indexOf(r) === i),
      checkedAt: novelty.checkedAt,
    },
  };
}
