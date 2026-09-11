/**
 * Sealing, delivery and reveal.
 *
 * The chain only ever holds commitments:
 *   contentHash = keccak256(canonical plaintext)
 *   keyHash     = keccak256(K)
 *
 * A buyer who receives K can check `keccak256(decrypt(ciphertext, K))` against the
 * attested `contentHash` without trusting anybody. That is why "did the seller
 * deliver what was graded?" is never a question for the oracle or a dispute.
 *
 * This module is isomorphic on purpose: a real seller seals in their browser and a
 * real buyer decrypts in theirs, with exactly the code the server agents use.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { PrivateKey, encrypt as eciesEncrypt, decrypt as eciesDecrypt } from "eciesjs";
import { keccak256, toHex, fromHex, encodePacked, type Hex } from "viem";
import type { Finding } from "./types";

const NONCE_BYTES = 24; // XChaCha20

const utf8 = (s: string) => new TextEncoder().encode(s);
const utf8Decode = (b: Uint8Array) => new TextDecoder().decode(b);
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}
function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/**
 * Deterministically derives the per-finding symmetric key from the seller's secret
 * and the finding's content hash. This lets a stateless server recompute K at
 * deliver/disclose time instead of storing it, without weakening secrecy: K is a
 * keccak of a 32-byte secret nobody else holds. The nonce is likewise derived so
 * the whole seal is reproducible. A wallet seller uses a secret derived from a
 * signature, so they can recompute K from any device that holds the wallet.
 */
export function deriveKey(sellerSecret: Hex, finding: Finding): Hex {
  return keccak256(encodePacked(["bytes32", "bytes32"], [sellerSecret, contentHashOf(finding)]));
}

function deriveNonce(key: Hex): Uint8Array {
  return fromHex(keccak256(encodePacked(["string", "bytes32"], ["nonce", key])), "bytes").subarray(0, NONCE_BYTES);
}

/** Deterministic JSON so both sides hash the same bytes. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function contentHashOf(finding: Finding): Hex {
  return keccak256(toHex(utf8(canonicalize(finding))));
}

export function keyHashOf(key: Hex): Hex {
  // Matches keccak256(abi.encodePacked(bytes32 key)) on-chain.
  return keccak256(key);
}

export interface Sealed {
  /** The symmetric key, as a bytes32 so it can be revealed on-chain verbatim. */
  key: Hex;
  /** nonce(24) || XChaCha20-Poly1305 ciphertext, ready for the `bytes` argument. */
  ciphertext: Hex;
  contentHash: Hex;
  keyHash: Hex;
}

export function sealFinding(finding: Finding, key?: Hex): Sealed {
  const k = key ?? (toHex(randomBytes(32)) as Hex);
  const keyBytes = fromHex(k, "bytes");
  if (keyBytes.length !== 32) throw new Error("key must be 32 bytes");

  // Derive the nonce from K when K was supplied, so the seal is reproducible.
  const nonce = key ? deriveNonce(k) : randomBytes(NONCE_BYTES);
  const plaintext = utf8(canonicalize(finding));
  const ct = xchacha20poly1305(keyBytes, nonce).encrypt(plaintext);

  return {
    key: k,
    ciphertext: toHex(concat(nonce, ct)),
    contentHash: keccak256(toHex(plaintext)),
    keyHash: keyHashOf(k),
  };
}

/** Opens a sealed finding and refuses anything that does not match the commitment. */
export function openFinding(ciphertext: Hex, key: Hex, expectedContentHash: Hex): Finding {
  const blob = fromHex(ciphertext, "bytes");
  const nonce = blob.subarray(0, NONCE_BYTES);
  const ct = blob.subarray(NONCE_BYTES);
  const plaintext = xchacha20poly1305(fromHex(key, "bytes"), nonce).decrypt(ct);

  const got = keccak256(toHex(plaintext));
  if (got.toLowerCase() !== expectedContentHash.toLowerCase()) {
    throw new Error(`contentHash mismatch: attested ${expectedContentHash}, received ${got}`);
  }
  return JSON.parse(utf8Decode(plaintext)) as Finding;
}

// ------------------------------------------------------- key wrapping (ECIES)

export function publicKeyOf(privateKey: Hex): Hex {
  return `0x${PrivateKey.fromHex(privateKey.replace(/^0x/, "")).publicKey.toHex(false)}`;
}

/** Wraps K to the buyer's secp256k1 public key, as posted by `deliver()`. */
export function wrapKey(key: Hex, buyerPublicKey: Hex): Hex {
  const wrapped = eciesEncrypt(buyerPublicKey.replace(/^0x/, ""), fromHex(key, "bytes"));
  return toHex(wrapped);
}

export function unwrapKey(wrapped: Hex, buyerPrivateKey: Hex): Hex {
  const key = eciesDecrypt(buyerPrivateKey.replace(/^0x/, ""), fromHex(wrapped, "bytes"));
  return toHex(key);
}
