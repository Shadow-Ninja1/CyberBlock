/**
 * End-to-end demo. Drives the full lifecycle on whatever chain lib/contract.json
 * points at: a local Hardhat node or Base Sepolia.
 *
 *   npx tsx scripts/demo.ts
 *
 * On a local node (chainId 31337) it first funds the three role accounts from a
 * Hardhat default account so the demo is one command. On Base Sepolia the role
 * accounts must already hold a little test ETH.
 *
 * It walks five scenes:
 *   1. oracle refuses a non-novel package (real OSV lookup)
 *   2. oracle refuses a fabricated writeup (claims not in the artifact)
 *   3. happy path: list -> buy -> deliver -> verify -> settle -> disclose
 *   4. a second listing, bought by the autonomous buyer policy
 *   5. dispute path: buyer challenges, oracle re-runs the detector, seller upheld
 */
import "dotenv/config";
import { createWalletClient, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  chain,
  publicClient,
  CHAIN_ID,
  BAZAAR_ADDRESS,
  accountFor,
  txUrl,
  readListing,
} from "../lib/chain";
import {
  requestAttestation,
  sellerList,
  buyerEvaluate,
  buyerBuy,
  sellerDeliver,
  buyerReceive,
  buyerDispute,
  oracleResolve,
  claimPayment,
  sellerDisclose,
  loadFinding,
  fmt,
} from "../lib/agents";
import { attest } from "../lib/oracle";
import { sealFinding } from "../lib/crypto";
import { checkNovelty } from "../lib/osv";
import { STATUS_LABEL } from "../lib/types";

const HARDHAT_ACCT0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

function h(title: string) {
  console.log(`\n\x1b[1m\x1b[36m━━ ${title} ━━\x1b[0m`);
}
function ok(s: string) {
  console.log(`\x1b[32m✓\x1b[0m ${s}`);
}
function note(s: string) {
  console.log(`  ${s}`);
}

async function fundLocal() {
  if (CHAIN_ID !== 31337) return;
  const funder = createWalletClient({
    account: privateKeyToAccount(HARDHAT_ACCT0),
    chain,
    transport: http(),
  });
  for (const role of ["ORACLE", "SELLER", "BUYER"] as const) {
    const to = accountFor(role).address;
    const hash = await funder.sendTransaction({ to, value: parseEther("100"), account: funder.account, chain });
    await publicClient().waitForTransactionReceipt({ hash });
  }
  ok("funded oracle / seller / buyer on local node");
}

async function waitSeconds(s: number, why: string) {
  if (CHAIN_ID === 31337) {
    // Fast-forward the local node instead of sleeping.
    await publicClient().request({ method: "evm_increaseTime" as any, params: [s] as any });
    await publicClient().request({ method: "evm_mine" as any, params: [] as any });
    note(`(local) fast-forwarded ${s}s — ${why}`);
  } else {
    note(`waiting ${s}s — ${why}`);
    await new Promise((r) => setTimeout(r, s * 1000 + 3000));
  }
}

async function status(id: bigint) {
  const l = await readListing(id);
  note(`listing #${id} status = ${STATUS_LABEL[l.status]}`);
}

async function main() {
  console.log(`\nBlack Box Bazaar demo`);
  console.log(`chain     ${CHAIN_ID}`);
  console.log(`contract  ${BAZAAR_ADDRESS}`);
  if (CHAIN_ID === 84532) console.log(`explorer  https://sepolia.basescan.org/address/${BAZAAR_ADDRESS}`);

  await fundLocal();

  // ---- Scene 1: already-public refusal (real OSV) ------------------------
  h("Scene 1 — oracle refuses a known-public package (event-stream@3.3.6)");
  {
    const pub = await checkNovelty({ name: "event-stream", version: "3.3.6" });
    if (pub.novel) {
      note("OSV unexpectedly had no record; skipping (network/feed drift).");
    } else {
      ok(`OSV lists event-stream@3.3.6 as ${pub.osvIds.slice(0, 3).join(", ")}…`);
      note("A seller trying to resell this as fresh intel would be refused at attestation.");
    }
  }

  // ---- Scene 2: fabricated-writeup refusal -------------------------------
  h("Scene 2 — oracle refuses a fabricated writeup (claims not in the artifact)");
  {
    const finding = loadFinding("overhyped-logger-1.0.3.json");
    const sealed = sealFinding(finding);
    const out = await attest({ finding, ciphertext: sealed.ciphertext, key: sealed.key });
    if (!out.ok) ok(`REFUSED — ${out.reason}: ${out.detail}`);
    else note("unexpectedly attested");
  }

  // ---- Scene 3: happy path ----------------------------------------------
  h("Scene 3 — happy path: evil-widget@1.2.0");
  const listed = await sellerList("evil-widget-1.2.0.json");
  if (!listed.listed) throw new Error("listing failed unexpectedly");
  const id = listed.id;
  await status(id);

  const decision = await buyerEvaluate(id);
  if (!decision.buy) throw new Error("buyer declined the happy-path listing");
  await buyerBuy(id);
  await status(id);

  await sellerDeliver(id, listed.sealed.key);
  await buyerReceive(id);
  await status(id);

  await waitSeconds(60 + 5, "challenge window closes");
  await claimPayment(id);
  await status(id);

  await waitSeconds(120 + 5, "embargo expires");
  const disc = await sellerDisclose(id, listed.sealed.key);
  await status(id);
  note(`disclosure tx: ${txUrl(disc.hash)}`);

  // ---- Scene 4: second listing, autonomous buy ---------------------------
  h("Scene 4 — second listing: sneaky-utils@0.4.1, bought by the buyer policy");
  const listed2 = await sellerList("sneaky-utils-0.4.1.json");
  if (listed2.listed) {
    const d2 = await buyerEvaluate(listed2.id);
    if (d2.buy) {
      await buyerBuy(listed2.id);
      await sellerDeliver(listed2.id, listed2.sealed.key);
      await buyerReceive(listed2.id);
      await status(listed2.id);
      note("left inside its challenge window to show a live, mid-lifecycle listing.");
    }
  }

  // ---- Scene 5: dispute path --------------------------------------------
  h("Scene 5 — dispute: buyer challenges, oracle re-runs the detector");
  if (listed2.listed) {
    const l = await readListing(listed2.id);
    if (l.status === 3 /* Delivered */) {
      await buyerDispute(listed2.id, "buyer claims the finding is not reproducible");
      await oracleResolve(listed2.id, loadFinding("sneaky-utils-0.4.1.json"));
      await status(listed2.id);
      note("oracle re-ran the committed detector against the attested artifact hash and upheld the seller.");
    } else {
      note(`listing #${listed2.id} not in Delivered state; skipping dispute.`);
    }
  }

  h("Demo complete");
  ok("every transaction above is on-chain and linkable on the explorer.");
}

main().catch((e) => {
  console.error("\n\x1b[31mdemo failed:\x1b[0m", e);
  process.exit(1);
});
