/**
 * Off-chain self-test: the crypto round-trip, sandbox determinism, and every oracle
 * decision path. Runs without a chain. `npx tsx scripts/selftest.ts`
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sealFinding, openFinding, wrapKey, unwrapKey, publicKeyOf, contentHashOf } from "../lib/crypto";
import { runFileTarball } from "../lib/sandbox";
import { attest } from "../lib/oracle";
import { effectList, type Finding } from "../lib/types";

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
    const buyerPriv = ("0x" + "22".repeat(32)) as `0x${string}`;
    const wrapped = wrapKey(sealed.key, publicKeyOf(buyerPriv));
    const recoveredKey = unwrapKey(wrapped, buyerPriv);
    check("unwrapped key matches", recoveredKey.toLowerCase() === sealed.key.toLowerCase());
    const opened = openFinding(sealed.ciphertext, recoveredKey, sealed.contentHash);
    check("opened finding matches original", opened.outcome === finding.outcome);
    let rejected = false;
    try { openFinding(sealed.ciphertext, recoveredKey, ("0x" + "00".repeat(32)) as `0x${string}`); } catch { rejected = true; }
    check("open rejects a wrong contentHash", rejected);
  }

  console.log("\nsandbox determinism + effects");
  {
    const a = runFileTarball("fixtures/packages/evil-widget-1.2.0.tgz", { trigger: "install" });
    const b = runFileTarball("fixtures/packages/evil-widget-1.2.0.tgz", { trigger: "install" });
    check("same input → same traceHash", a.traceHash === b.traceHash);
    check("same input → same effects", a.effects === b.effects, `effects=${a.effects} [${effectList(a.effects).map(e=>e.label).join(", ")}]`);
    check("same input → same sandboxHash", a.sandboxHash === b.sandboxHash);
    const s = runFileTarball("fixtures/packages/sneaky-utils-0.4.1.tgz", { trigger: "require", entry: "lib.js" });
    check("sneaky-utils beacons out", (s.effects & 4) !== 0, `effects=${s.effects}`);
    const exfil = a.captures.find((c) => c.kind === "exfiltration");
    check("evil-widget captures the exfiltrated payload", !!exfil && (exfil.secretsLeaked?.length ?? 0) >= 2, exfil ? `leaked ${exfil.secretsLeaked?.join(",")}` : "no exfil capture");
    const code = s.captures.find((c) => c.kind === "code-exec");
    check("sneaky-utils captures the decoded second stage", !!code && /pkg-analytics\.top/.test(code.data ?? ""), code?.data ?? "none");
    check("captures are covered by traceHash (determinism)", a.traceHash === runFileTarball("fixtures/packages/evil-widget-1.2.0.tgz", { trigger: "install" }).traceHash);
  }

  console.log("\noracle: happy path (needs ORACLE_PRIVATE_KEY + network for OSV)");
  {
    const finding = loadFinding("evil-widget-1.2.0.json");
    const sealed = sealFinding(finding);
    const out = await attest({ finding, ciphertext: sealed.ciphertext, key: sealed.key });
    if (out.ok) {
      check("evil-widget attested", true, `effects ${out.att.effects} [${effectList(out.att.effects).map(e=>e.label).join(", ")}]`);
      check("attestation carries a signature", /^0x[0-9a-f]{130}$/i.test(out.signature));
      check("keyHash binds the delivered key", out.att.keyHash === sealed.keyHash);
      check("traceHash committed", /^0x[0-9a-f]{64}$/i.test(out.att.traceHash));
      check("outcomeHash is committed", /^0x[0-9a-f]{64}$/i.test(out.att.outcomeHash));
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

    const other = sealFinding(loadFinding("sneaky-utils-0.4.1.json"));
    const r3 = await attest({ finding: clean, ciphertext: other.ciphertext, key: other.key });
    check("seal-mismatch refused", !r3.ok && r3.reason === "seal-mismatch");
  }

  console.log(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
