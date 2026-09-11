/**
 * Regenerates lib/detector-fingerprint.json from the detector's own bytes.
 * Run after any change to lib/detector.ts. Committed output keeps the deployed
 * app able to serve the exact source behind every attestation it signs.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { keccak256, toHex } from "viem";

const SRC = resolve(process.cwd(), "lib/detector.ts");
const OUT = resolve(process.cwd(), "lib/detector-fingerprint.json");

const raw = readFileSync(SRC);
// Blank the generated import line's effect by hashing the source as-is: the file
// on disk is what a verifier will download from /api/detector, so they match.
const hash = keccak256(toHex(raw));

writeFileSync(
  OUT,
  JSON.stringify({ detectorHash: hash, bytes: raw.length, source: raw.toString("utf8") }, null, 2) + "\n",
);
console.log(`detectorHash ${hash}  (${raw.length} bytes)`);
