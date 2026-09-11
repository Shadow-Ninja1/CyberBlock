/**
 * Off-chain self-test: the crypto round-trip and every oracle decision path.
 * Runs without a chain. `npx tsx scripts/selftest.ts`
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  sealFinding,
  openFinding,
  wrapKey,
  unwrapKey,
  publicKeyOf,
  contentHashOf,
} from "../lib/crypto";
import { analyzeFile } from "../lib/detector";
import { attest } from "../lib/oracle";
import type { Finding } from "../lib/types";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${detail ? `  — ${detail}` : ""}`);
  if (!cond) failures++;
}

function loadFinding(name: string): Finding {
  return JSON.parse(readFileSync(resolve("fixtures/findings", name), "utf8"));
}

async function main() {
  console.log("crypto round-trip");
  {
    const finding = loadFinding("evil-widget-1.2.0.json");
    const sealed = sealFinding(finding);
    check("contentHash is stable", sealed.contentHash === contentHashOf(finding));

    // buyer generates a keypair; seller wraps K to the buyer's public key.
    const buyerPriv = ("0x" + "22".repeat(32)) as `0x${string}`;
    const buyerPub = publicKeyOf(buyerPriv);
    const wrapped = wrapKey(sealed.key, buyerPub);
    const recoveredKey = unwrapKey(wrapped, buyerPriv);
    check("unwrapped key matches", recoveredKey.toLowerCase() === sealed.key.toLowerCase());

    const opened = openFinding(sealed.ciphertext, recoveredKey, sealed.contentHash);
    check("opened finding matches original", opened.title === finding.title);

    let rejected = false;
    try {
      openFinding(sealed.ciphertext, recoveredKey, ("0x" + "00".repeat(32)) as `0x${string}`);
    } catch {
      rejected = true;
    }
    check("open rejects a wrong contentHash", rejected);
  }

  console.log("\ndetector determinism");
  {
    const a = analyzeFile("fixtures/packages/evil-widget-1.2.0.tgz");
    const b = analyzeFile("fixtures/packages/evil-widget-1.2.0.tgz");
    check("same input → same artifactHash", a.artifactHash === b.artifactHash);
    check("same input → same severity", a.severity === b.severity, `sev=${a.severity}`);
    check("same input → same detectorHash", a.detectorHash === b.detectorHash);
  }

  console.log("\noracle: happy path (needs ORACLE_PRIVATE_KEY + network for OSV)");
  {
    const finding = loadFinding("evil-widget-1.2.0.json");
    const sealed = sealFinding(finding);
    const out = await attest({ finding, ciphertext: sealed.ciphertext, key: sealed.key });
    if (out.ok) {
      check("evil-widget attested", true, `severity ${out.att.severity}, class ${out.att.vulnClass}`);
      check("attestation carries a signature", /^0x[0-9a-f]{130}$/i.test(out.signature));
      check("keyHash binds the delivered key", out.att.keyHash === sealed.keyHash);
      check("novel", out.att.novel);
    } else {
      check("evil-widget attested", false, `${out.reason}: ${out.detail}`);
    }
  }

  console.log("\noracle: refusals");
  {
    const clean = loadFinding("clean-lib-2.0.0.json");
    const s1 = sealFinding(clean);
    const r1 = await attest({ finding: clean, ciphertext: s1.ciphertext, key: s1.key });
    check("clean-lib refused", !r1.ok, r1.ok ? "" : r1.reason);
    check("clean-lib reason is not-reproducible", !r1.ok && r1.reason === "not-reproducible");

    const hyped = loadFinding("overhyped-logger-1.0.3.json");
    const s2 = sealFinding(hyped);
    const r2 = await attest({ finding: hyped, ciphertext: s2.ciphertext, key: s2.key });
    check("overhyped-logger refused", !r2.ok, r2.ok ? "" : r2.reason);
    check("overhyped-logger reason is claims-unsupported", !r2.ok && r2.reason === "claims-unsupported");

    // seal-mismatch: hand the oracle a ciphertext that is not the finding.
    const other = sealFinding(loadFinding("sneaky-utils-0.4.1.json"));
    const r3 = await attest({ finding: clean, ciphertext: other.ciphertext, key: other.key });
    check("seal-mismatch refused", !r3.ok && r3.reason === "seal-mismatch");
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
