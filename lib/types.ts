import type { Hex } from "viem";

/**
 * What the sandbox observed a package do, as on-chain bit flags. These are FACTS
 * verified by execution, not a risk score. Mirrors the EFFECT_* constants in
 * CyberBlock.sol. The market shows buyers these effects plus a one-sentence
 * outcome and lets them price the finding themselves.
 */
export enum Effect {
  ExfilCredentials = 1, // a credential canary left the sandbox in an egress payload
  ExfilEnv = 2, // an environment-variable canary left the sandbox
  NetworkEgress = 4, // contacted a host outside normal package plumbing
  ReadsSensitive = 8, // read a credential file from the fake home directory
  SpawnsProcess = 16, // tried to spawn a child process
  WritesFiles = 32, // wrote outside its own package directory
  RunsOnInstall = 64, // the behaviour was triggered by an npm install hook
}

export const EFFECT_LABEL: Record<number, string> = {
  1: "Exfiltrates credentials",
  2: "Exfiltrates environment",
  4: "Beacons to an external host",
  8: "Reads credential files",
  16: "Spawns a process",
  32: "Writes outside its package",
  64: "Runs on install",
};

/** Decompose an effects bitmask into its individual labelled flags. */
export function effectList(effects: number): { flag: Effect; label: string }[] {
  return Object.values(Effect)
    .filter((v): v is Effect => typeof v === "number" && (effects & v) !== 0)
    .map((flag) => ({ flag, label: EFFECT_LABEL[flag] }));
}

/** Matches the on-chain `Status` enum in CyberBlock.sol. */
export enum Status {
  None = 0,
  Listed = 1,
  Sold = 2,
  Delivered = 3,
  Challenged = 4,
  Settled = 5,
  Disclosed = 6,
  Refunded = 7,
  Cancelled = 8,
}

export const STATUS_LABEL: Record<number, string> = {
  0: "None",
  1: "Listed",
  2: "Sold",
  3: "Delivered",
  4: "Challenged",
  5: "Settled",
  6: "Disclosed",
  7: "Refunded",
  8: "Cancelled",
};

/** Matches the on-chain `Contingent` enum. */
export enum Contingent {
  None = 0,
  Escrowed = 1,
  Released = 2,
  Returned = 3,
}

/** One entry in the sandbox execution trace: a single intercepted effect. */
export interface TraceEvent {
  /** Stable op id, e.g. "fs.read", "net.egress", "process.spawn". */
  op: string;
  /** The primary target: a path, a host, a command, an env key. */
  target: string;
  /** Extra detail the op recorded, e.g. which canaries appeared in an egress body. */
  detail?: string[];
}

/**
 * A concrete artifact the detonation produced — the actual access or output the
 * exploit obtained, not just a flag that it happened. This is what the LLM checks
 * the seller's declared `expectedResult` against.
 */
export interface Capture {
  kind: "exfiltration" | "process" | "code-exec" | "file-read";
  /** Short human/LLM-readable description of what was obtained. */
  summary: string;
  /** The destination host, for exfiltration. */
  host?: string;
  /** The concrete captured bytes: the exfiltrated payload (decoded), the spawned
   *  command, the dynamically-evaluated source, or the file contents read. Truncated. */
  data?: string;
  /** Which canary secrets actually left the sandbox in this capture. */
  secretsLeaked?: string[];
}

/** The full, deterministic result of detonating a repro in the sandbox. */
export interface SandboxResult {
  /** sha256 of the exact tarball bytes that were detonated. */
  artifactHash: Hex;
  /** Ordered events the instrumented runtime observed. Deterministic across runs. */
  trace: TraceEvent[];
  /** Concrete artifacts the run produced — the access/output actually obtained. */
  captures: Capture[];
  /** keccak256 of the canonical {trace, captures}, committed in the attestation. */
  traceHash: Hex;
  /** Effects bit flags derived mechanically from the trace. */
  effects: number;
  /** keccak256 of the sandbox runtime source, so a grade can be reproduced later. */
  sandboxHash: Hex;
  sandboxVersion: string;
  /** Set when the repro could not be detonated at all (bad spec, threw before any effect). */
  error?: string;
}

/** How a seller reproduces the finding. Deterministic: the sandbox re-runs it verbatim. */
export interface Repro {
  /**
   * What the sandbox should do to trigger the behaviour:
   *  - "install": execute the package's npm install hooks (preinstall/install/postinstall).
   *  - "require": require one file from the tarball, as a dependent would.
   */
  trigger: "install" | "require";
  /** For trigger "require": the tarball-relative file to require, e.g. "lib.js". */
  entry?: string;
}

/**
 * The plaintext a seller is actually selling. Its keccak256 is committed on-chain
 * as `contentHash`, so a buyer can prove they received exactly what was graded.
 */
export interface Finding {
  schema: "cyberblock.finding.v2";
  target: {
    ecosystem: "npm";
    name: string;
    version: string;
    /** Local fixture path or registry tarball URL the sandbox detonated. */
    artifact: string;
  };
  /** How to reproduce the behaviour deterministically. The oracle runs this. */
  repro: Repro;
  /**
   * The effects the seller claims the repro will exhibit (Effect bit flags). The
   * oracle refuses to sign unless every claimed effect actually appears in the trace.
   */
  claimedEffects: number;
  /**
   * The one-sentence result shown to buyers BEFORE they pay. Its keccak256 is the
   * attestation's `outcomeHash`, committed on-chain, so it cannot be swapped later.
   * This is the only thing a buyer sees; there is no severity score.
   */
  outcome: string;
  /**
   * The concrete result the exploit achieves — the new access or captured output
   * the seller claims running the repro grants (e.g. "captures the npm auth token
   * and cloud keys and exfiltrates them, giving the attacker publish rights"). The
   * oracle runs the repro and the LLM confirms the sandbox's captured artifacts
   * actually demonstrate this access before signing.
   */
  expectedResult: string;
  /** The full writeup, revealed to the buyer on delivery and to everyone on disclosure. */
  writeup: string;
  remediation: string;
  reporter: string;
}

export interface AttestationStruct {
  artifactHash: Hex;
  contentHash: Hex;
  keyHash: Hex;
  traceHash: Hex;
  sandboxHash: Hex;
  outcomeHash: Hex;
  effects: number;
  novel: boolean;
  installBase: number;
  expiresAt: bigint;
}

export interface SignedAttestation {
  att: AttestationStruct;
  signature: Hex;
  /** Not signed; carried alongside for the UI and for the seller's list() call. */
  meta: {
    targetLabel: string;
    outcome: string;
    sandboxVersion: string;
    effects: number;
    osvIds: string[];
    checkedAt: string;
    /** LLM verification that the captured artifacts demonstrate the declared access. */
    judge?: { achieved: boolean; reason: string; by: "claude" | "mechanical" };
    /** Concrete artifacts the detonation produced, for display. */
    captures?: Capture[];
  };
}

export interface AttestationRefusal {
  ok: false;
  reason: string;
  detail: string;
  /** Non-secret evidence the oracle can publish for a refusal. */
  facts: Record<string, unknown>;
}

/** Result of asking OSV whether an artifact is already publicly known. */
export interface NoveltyResult {
  novel: boolean;
  osvIds: string[];
  checkedAt: string;
  error?: string;
}

/** One line in the shared agent console shown in the UI. */
export interface LogLine {
  at: number;
  actor: "oracle" | "arbiter" | "seller" | "buyer" | "chain" | "system";
  level: "info" | "ok" | "warn" | "error";
  message: string;
  txHash?: Hex;
  data?: Record<string, unknown>;
}
