/**
 * Regenerates lib/sandbox-fingerprint.json from the sandbox runtime's own bytes.
 * Run after any change to lib/sandbox.ts. Committed output keeps the deployed app
 * able to serve the exact source behind every attestation it signs, so a third
 * party can re-run it and reproduce the trace.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256, toHex } from "viem";

const SRC = resolve(process.cwd(), "lib/sandbox.ts");
const OUT = resolve(process.cwd(), "lib/sandbox-fingerprint.json");

const raw = readFileSync(SRC);
const hash = keccak256(toHex(raw));
writeFileSync(OUT, JSON.stringify({ sandboxHash: hash, bytes: raw.length, source: raw.toString("utf8") }, null, 2) + "\n");
console.log(`sandboxHash ${hash}  (${raw.length} bytes)`);
