import type { Hex } from "viem";

/** Matches the on-chain `VulnClass` enum in CyberBlock.sol. */
export enum VulnClass {
  Unknown = 0,
  InstallHookExfil = 1,
  ObfuscatedEval = 2,
  CredentialTheft = 3,
  NetworkBackdoor = 4,
  DependencyConfusion = 5,
}

export const VULN_CLASS_LABEL: Record<number, string> = {
  0: "Unclassified",
  1: "Install-hook exfiltration",
  2: "Obfuscated eval chain",
  3: "Credential theft",
  4: "Network backdoor",
  5: "Dependency confusion",
};

/** Matches the on-chain `Status` enum. */
export enum Status {
  None = 0,
  Listed = 1,
  Sold = 2,
  Delivered = 3,
  Disputed = 4,
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
  4: "Disputed",
  5: "Settled",
  6: "Disclosed",
  7: "Refunded",
  8: "Cancelled",
};

/** A single mechanical observation the detector made about an artifact. */
export interface Signal {
  /** Stable rule id, e.g. "install-hook.remote-exec". */
  rule: string;
  /** Points this rule contributes to severity. */
  weight: number;
  /** Which VulnClass this rule votes for. */
  votes: VulnClass;
  /** File inside the tarball where it fired. */
  file: string;
  /** The matched text, truncated. Safe to show publicly only after disclosure. */
  evidence: string;
}

export interface DetectorResult {
  /** sha256 of the exact tarball bytes that were analysed. */
  artifactHash: Hex;
  signals: Signal[];
  severity: number; // 0..100
  vulnClass: VulnClass;
  /** keccak256 of the detector source, so a grade can be reproduced later. */
  detectorHash: Hex;
  detectorVersion: string;
}

/** Result of asking OSV whether an artifact is already publicly known. */
export interface NoveltyResult {
  novel: boolean;
  osvIds: string[];
  checkedAt: string;
  /** Set when OSV could not be reached; the oracle refuses to attest in that case. */
  error?: string;
}

/**
 * The plaintext a seller is actually selling. Its keccak256 is committed on-chain
 * as `contentHash`, so a buyer can prove they received exactly what was graded.
 */
export interface Finding {
  schema: "bbb.finding.v1";
  target: {
    ecosystem: "npm";
    name: string;
    version: string;
    /** Local fixture path or registry tarball URL the oracle re-fetched. */
    artifact: string;
  };
  title: string;
  summary: string;
  /** Indicators of compromise the seller claims are present in the artifact. */
  iocs: {
    domains: string[];
    files: string[];
    snippets: string[];
  };
  remediation: string;
  reporter: string;
}

export interface AttestationStruct {
  artifactHash: Hex;
  contentHash: Hex;
  keyHash: Hex;
  detectorHash: Hex;
  severity: number;
  vulnClass: number;
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
    detectorVersion: string;
    signalRules: string[];
    osvIds: string[];
    checkedAt: string;
  };
}

export interface AttestationRefusal {
  ok: false;
  reason: string;
  detail: string;
  /** Non-secret evidence the oracle can publish for a refusal. */
  facts: Record<string, unknown>;
}

/** One line in the shared agent console shown in the UI. */
export interface LogLine {
  at: number;
  actor: "oracle" | "seller" | "buyer" | "chain" | "system";
  level: "info" | "warn" | "error" | "ok";
  message: string;
  txHash?: Hex;
  data?: Record<string, unknown>;
}
