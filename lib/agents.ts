/**
 * The four autonomous actors, as a set of actions over the contract.
 *
 * seller  — seals a finding, asks the oracle to detonate its repro, lists it as a
 *           Dutch auction with a chosen base/contingent split, delivers, discloses.
 * buyer   — decides from the observed effects + outcome + price alone (never the
 *           contents), buys at the current auction price, verifies, may challenge.
 * oracle  — detonates the repro, signs the attestation, later records external
 *           confirmation that releases the contingent share.
 * arbiter — a separate party that rules on challenges by re-detonating harder.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Hex } from "viem";
import {
  CONTRACT_ABI,
  CONTRACT_ADDRESS,
  walletFor,
  publicClient,
  readListing,
  listingLogs,
  firstEvent,
  currentPrice,
  priceCap,
  minStake,
  challengeBondFor,
  sellerRep,
  waitFor,
  txUrl,
} from "./chain";
import { sealFinding, wrapKey, unwrapKey, openFinding, publicKeyOf, deriveKey } from "./crypto";
import { attest, adjudicate } from "./oracle";
import { run } from "./sandbox";
import { record } from "./store";
import { Status, effectList, type Finding, type LogLine, type SignedAttestation } from "./types";

const DEFAULT_DURATION = 3n * 60n; // decay over 3 minutes in the demo
const DEFAULT_EMBARGO = 2n * 60n; // MIN_EMBARGO
const DEFAULT_CONTINGENT_BPS = 5_000; // seller puts half the price on the outcome by default

export function loadFinding(name: string): Finding {
  return JSON.parse(readFileSync(resolve(process.cwd(), "fixtures/findings", name), "utf8")) as Finding;
}

export function listFindingFiles(): string[] {
  return ["evil-widget-1.2.0.json", "sneaky-utils-0.4.1.json"];
}
export function allFindingFiles(): string[] {
  return ["evil-widget-1.2.0.json", "sneaky-utils-0.4.1.json", "clean-lib-2.0.0.json", "overhyped-logger-1.0.3.json"];
}

function sellerSecret(): Hex {
  return process.env.SELLER_PRIVATE_KEY as Hex;
}
export function keyForFinding(finding: Finding): Hex {
  return deriveKey(sellerSecret(), finding);
}
// The fixture set never changes at runtime, so map targetLabel → finding once.
let _targetIndex: Map<string, Finding> | null = null;
function targetIndex(): Map<string, Finding> {
  if (_targetIndex) return _targetIndex;
  const m = new Map<string, Finding>();
  for (const file of allFindingFiles()) {
    const f = loadFinding(file);
    m.set(`npm:${f.target.name}@${f.target.version}`, f);
  }
  return (_targetIndex = m);
}
export function findingForTarget(targetLabel: string): Finding | null {
  return targetIndex().get(targetLabel) ?? null;
}

/** The simulated external advisory feed used to confirm the contingent share. */
export function groundTruth(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), "fixtures/ground-truth.json"), "utf8")).confirmed ?? {};
  } catch {
    return {};
  }
}

async function send(actor: LogLine["actor"], what: string, fn: () => Promise<Hex>): Promise<{ hash: Hex; lines: LogLine[] }> {
  const lines: LogLine[] = [];
  const hash = await fn();
  lines.push(record({ actor, level: "info", message: `${what} — tx sent`, txHash: hash }));
  const receipt = await waitFor(hash);
  lines.push(
    record({
      actor: "chain",
      level: receipt.status === "success" ? "ok" : "error",
      message: `${what} — ${receipt.status} in block ${receipt.blockNumber}`,
      txHash: hash,
      data: { explorer: txUrl(hash) },
    }),
  );
  return { hash, lines };
}

/** Base Sepolia is eventually consistent; poll for an event by listing id. */
async function waitForEvent(eventName: string, id: bigint, tries = 12): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const ev = await firstEvent(eventName as "Listed" | "Delivered" | "Disclosed", id);
    if (ev) return ev;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${eventName} event for #${id} not indexed after ${tries} tries`);
}

// -------------------------------------------------------- oracle: attestation

export async function requestAttestation(findingFile: string) {
  const finding = loadFinding(findingFile);
  record({ actor: "seller", level: "info", message: `sealing "${finding.outcome}" and asking the oracle to detonate the repro` });

  const sealed = sealFinding(finding, keyForFinding(finding));
  const outcome = await attest({ finding, ciphertext: sealed.ciphertext, key: sealed.key });

  if (!outcome.ok) {
    record({ actor: "oracle", level: "warn", message: `REFUSED (${outcome.reason}): ${outcome.detail}`, data: outcome.facts });
    return { ok: false as const, refusal: outcome, finding };
  }

  const effects = effectList(outcome.att.effects).map((e) => e.label);
  record({
    actor: "oracle",
    level: "ok",
    message: `detonated ${outcome.meta.targetLabel}: observed ${effects.join(", ")}; trace ${outcome.att.traceHash.slice(0, 10)}; novel; signed`,
    data: { traceHash: outcome.att.traceHash, sandboxHash: outcome.att.sandboxHash, effects, judge: outcome.meta.judge, osvIds: outcome.meta.osvIds },
  });
  if (outcome.meta.judge) {
    const j = outcome.meta.judge;
    record({ actor: "oracle", level: j.achieved ? "ok" : "warn", message: `${j.by === "claude" ? "Claude" : "mechanical check"} verified the run granted the declared access: ${j.reason}` });
  }

  return { ok: true as const, finding, sealed, signed: { att: outcome.att, signature: outcome.signature, meta: outcome.meta } as SignedAttestation };
}

// ---------------------------------------------------------------- seller: list

export interface ListOpts {
  contingentBps?: number;
  duration?: bigint;
  embargo?: bigint;
}

export async function sellerList(findingFile: string, opts: ListOpts = {}) {
  const att = await requestAttestation(findingFile);
  if (!att.ok) return { listed: false as const, refusal: att.refusal };

  const wallet = walletFor("SELLER");
  const cap = await priceCap(wallet.account!.address);
  const startPrice = cap; // open the auction at the reputation cap
  const reservePrice = cap / 4n; // decay to a quarter of it
  const stake = await minStake(reservePrice);
  const contingentBps = opts.contingentBps ?? DEFAULT_CONTINGENT_BPS;
  const duration = opts.duration ?? DEFAULT_DURATION;
  const embargo = opts.embargo ?? DEFAULT_EMBARGO;

  const { hash } = await send(
    "seller",
    `list ${att.signed.meta.targetLabel} — Dutch auction ${fmt(startPrice)}→${fmt(reservePrice)} ETH, ${contingentBps / 100}% contingent`,
    () =>
      wallet.writeContract({
        address: CONTRACT_ADDRESS,
        abi: CONTRACT_ABI,
        functionName: "list",
        args: [att.signed.att, att.signed.signature, att.signed.meta.outcome, startPrice, reservePrice, duration, contingentBps, embargo, att.signed.meta.targetLabel, att.sealed.ciphertext],
        value: stake,
        account: wallet.account!,
        chain: wallet.chain,
      }),
  );

  // Base Sepolia is eventually consistent: a read right after the tx can hit a node
  // that has not indexed it yet. Poll until the duplicate-lock maps the artifact.
  let id = 0n;
  for (let i = 0; i < 8 && id === 0n; i++) {
    id = (await publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "listingByArtifact", args: [att.signed.att.artifactHash] })) as bigint;
    if (id === 0n) await new Promise((r) => setTimeout(r, 1500));
  }
  record({
    actor: "seller",
    level: "ok",
    message: `listing #${id} live — buyers see only the effects + one-sentence outcome; price is falling until someone buys`,
    data: { txHash: hash, startPrice: fmt(startPrice), reservePrice: fmt(reservePrice), contingentPct: contingentBps / 100, stake: fmt(stake), embargoMinutes: Number(embargo) / 60 },
  });
  return { listed: true as const, id, finding: att.finding, sealed: att.sealed };
}

// ------------------------------------------------------------------ buyer: buy

export interface BuyPolicy {
  budgetEth: number;
  requireEffects: number; // bitmask the finding must exhibit
  requireNovel: boolean;
  maxSellerSlashRate: number;
}

export const DEFAULT_POLICY: BuyPolicy = {
  budgetEth: 0.01,
  requireEffects: 0,
  requireNovel: true,
  maxSellerSlashRate: 0.34,
};

/**
 * The buyer decides from the attested metadata alone — effects, outcome, install
 * base, seller record and the CURRENT auction price. It never sees the finding.
 * Returns whether to buy and the max price (ceiling) it will pay.
 */
export async function buyerEvaluate(id: bigint, policy = DEFAULT_POLICY) {
  const l = await readListing(id);
  const rep = await sellerRep(l.seller);
  const price = await currentPrice(id);
  const slashRate = rep.sold + rep.slashed === 0 ? 0 : rep.slashed / (rep.sold + rep.slashed);
  const priceEth = Number(price) / 1e18;
  const outcome = (await listingLogs(id)).listed?.args?.outcome as string;
  const effects = effectList(l.att.effects).map((e) => e.label);

  const facts = {
    id: Number(id),
    effects,
    outcome,
    novel: l.att.novel,
    installBase: l.att.installBase,
    currentPriceEth: priceEth,
    contingentPct: l.auction.contingentBps / 100,
    sellerRep: rep,
    slashRate,
  };

  const budgetCeiling = policy.budgetEth;
  const llm = await maybeAskClaude(facts, policy);
  if (llm) {
    record({ actor: "buyer", level: llm.buy ? "ok" : "warn", message: `Claude policy: ${llm.reason}`, data: facts });
    return { ...facts, buy: llm.buy, priceCeilingEth: Math.min(llm.maxPriceEth ?? budgetCeiling, budgetCeiling), reason: llm.reason, decidedBy: "claude" as const };
  }

  const reasons: string[] = [];
  let buy = true;
  if (priceEth > policy.budgetEth) (buy = false), reasons.push(`price ${priceEth} > budget ${policy.budgetEth}`);
  if (policy.requireEffects && (l.att.effects & policy.requireEffects) !== policy.requireEffects) (buy = false), reasons.push("required effects absent");
  if (policy.requireNovel && !l.att.novel) (buy = false), reasons.push("not novel");
  if (slashRate > policy.maxSellerSlashRate) (buy = false), reasons.push(`seller slash rate ${slashRate.toFixed(2)} too high`);

  const reason = buy
    ? `effects [${effects.join(", ")}], novel, ${fmt(price)} ETH within budget, seller ${rep.sold} sold / ${rep.confirmed} confirmed / ${rep.slashed} slashed — buying`
    : `skipping: ${reasons.join("; ")}`;
  record({ actor: "buyer", level: buy ? "ok" : "warn", message: reason, data: facts });
  return { ...facts, buy, priceCeilingEth: budgetCeiling, reason, decidedBy: "policy" as const };
}

async function maybeAskClaude(facts: Record<string, unknown>, policy: BuyPolicy) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: key });
    const msg = await client.messages.create({
      // cast: installed SDK types predate `thinking`, which the API accepts at runtime.
      model: "claude-opus-5",
      max_tokens: 400,
      thinking: { type: "adaptive" },
      system:
        "You are an autonomous procurement agent for a security vendor buying supply-chain threat intel sight-unseen. You see only a signed grade: the effects a sandbox OBSERVED the package perform, a one-sentence outcome, install base, the auction's current price, the contingent share (escrowed until an external advisory confirms the finding), and the seller's record (sold/confirmed/slashed). You never see the finding itself. Decide whether to buy now and your max price. Respond as strict JSON {\"buy\": boolean, \"maxPriceEth\": number, \"reason\": string}. reason under 30 words.",
      messages: [{ role: "user", content: `Policy budget ${policy.budgetEth} ETH.\nListing: ${JSON.stringify(facts)}\nBuy?` }],
    } as any);
    const text = msg.content.find((c) => c.type === "text")?.text ?? "";
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return { buy: Boolean(json.buy), maxPriceEth: Number(json.maxPriceEth), reason: String(json.reason) };
  } catch (e) {
    record({ actor: "buyer", level: "warn", message: `Claude unavailable, using deterministic policy (${String(e).slice(0, 60)})` });
    return null;
  }
}

export async function buyerBuy(id: bigint, priceCeilingEth = DEFAULT_POLICY.budgetEth) {
  const buyerPub = publicKeyOf(process.env.BUYER_PRIVATE_KEY as Hex);
  const wallet = walletFor("BUYER");
  const now = await currentPrice(id);
  // The auction price only decays, so the price read here is an upper bound at
  // execution time: send exactly it (contract refunds any decrease). Sending the
  // full budget ceiling would need the whole budget in-balance even though most is
  // refunded, which needlessly fails when the account is low.
  const ceiling = BigInt(Math.floor(priceCeilingEth * 1e18));
  const value = now > ceiling ? ceiling : now;
  const { hash } = await send("buyer", `buy listing #${id} (live price ${fmt(now)} ETH, ceiling ${fmt(ceiling)})`, () =>
    wallet.writeContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "buy", args: [id, buyerPub], value, account: wallet.account!, chain: wallet.chain }),
  );
  const l = await readListing(id);
  record({ actor: "buyer", level: "ok", message: `bought #${id} at ${fmt(l.price)} ETH — base ${fmt(l.basePart)} to seller, ${fmt(l.contingentPart)} escrowed on the outcome`, data: { txHash: hash } });
  return { hash };
}

// --------------------------------------------------------------- seller: deliver

export async function sellerDeliver(id: bigint, key: Hex) {
  const bought = await waitForEvent("Bought", id);
  const buyerPublicKey = bought.args.buyerPubKey as Hex;
  const wrapped = wrapKey(key, buyerPublicKey);
  const { hash } = await send("seller", `deliver key for #${id} (wrapped to buyer's pubkey)`, () => {
    const wallet = walletFor("SELLER");
    return wallet.writeContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "deliver", args: [id, wrapped], account: wallet.account!, chain: wallet.chain });
  });
  return { hash };
}

export async function buyerReceive(id: bigint) {
  const l = await readListing(id);
  const delivered = await waitForEvent("Delivered", id);
  const logs = await listingLogs(id);
  const wrapped = delivered.args.encryptedKey as Hex;
  const key = unwrapKey(wrapped, process.env.BUYER_PRIVATE_KEY as Hex);
  const ciphertext = logs.listed.args.ciphertext as Hex;
  const finding = openFinding(ciphertext, key, l.att.contentHash);
  record({ actor: "buyer", level: "ok", message: `unwrapped and verified #${id}: keccak(plaintext) == attested contentHash. Full writeup received.`, data: { contentHash: l.att.contentHash } });
  return { finding, key };
}

// -------------------------------------------------------------------- challenge

/** A challenger re-detonates the repro themselves and posts the trace hash they got. */
export async function buyerChallenge(id: bigint, reason: string) {
  const l = await readListing(id);
  const target = (await listingLogs(id)).listed.args.targetLabel as string;
  const finding = findingForTarget(target);
  const myRun = finding ? run(readFileSync(resolve(process.cwd(), finding.target.artifact)), finding.repro) : null;
  const claimedTraceHash = (myRun?.traceHash ?? "0x0000000000000000000000000000000000000000000000000000000000000000") as Hex;
  const bond = await challengeBondFor(l.price);
  const { hash } = await send("buyer", `challenge #${id}: ${reason}`, () => {
    const wallet = walletFor("BUYER");
    return wallet.writeContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "challenge", args: [id, claimedTraceHash, reason], value: bond, account: wallet.account!, chain: wallet.chain });
  });
  return { hash };
}

export async function arbiterResolve(id: bigint, finding: Finding) {
  // Wait until a node reports the listing Challenged, so resolveChallenge does not
  // simulate against a lagging node and revert BadStatus (Base Sepolia race).
  let l = await readListing(id);
  for (let i = 0; i < 10 && l.status !== Status.Challenged; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    l = await readListing(id);
  }
  record({ actor: "arbiter", level: "info", message: `re-detonating the repro for challenged #${id} (3× under the stricter procedure)` });
  const verdict = await adjudicate({
    finding,
    attestedArtifactHash: l.att.artifactHash,
    attestedTraceHash: l.att.traceHash,
    attestedSandboxHash: l.att.sandboxHash,
    attestedEffects: l.att.effects,
  });
  record({ actor: "arbiter", level: verdict.sellerWins ? "ok" : "warn", message: `verdict on #${id}: ${verdict.sellerWins ? "seller upheld" : "challenge upheld"} — ${verdict.reason}`, data: verdict.facts });
  const { hash } = await send("arbiter", `resolve #${id} (sellerWins=${verdict.sellerWins})`, () => {
    const wallet = walletFor("ARBITER");
    return wallet.writeContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "resolveChallenge", args: [id, verdict.sellerWins, verdict.rerunTraceHash, verdict.reason], account: wallet.account!, chain: wallet.chain });
  });
  return { hash, verdict };
}

// ---------------------------------------------------------- settle & disclose

export async function claimPayment(id: bigint) {
  const { hash } = await send("seller", `claim base payment for #${id} (challenge window closed)`, () => {
    const wallet = walletFor("SELLER");
    return wallet.writeContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "claimPayment", args: [id], account: wallet.account!, chain: wallet.chain });
  });
  return { hash };
}
/** Buyer reclaims price + stake when a paid seller never delivered the key. This is
 *  the escape hatch that keeps a Sold listing from stranding the buyer's escrow. */
export async function buyerClaimTimeout(id: bigint) {
  const { hash } = await send("buyer", `reclaim escrow for #${id} — the seller missed the delivery deadline`, () => {
    const wallet = walletFor("BUYER");
    return wallet.writeContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "claimTimeout", args: [id], account: wallet.account!, chain: wallet.chain });
  });
  record({ actor: "system", level: "ok", message: `#${id}: buyer refunded the price plus the seller's whole stake; the seller was slashed.` });
  return { hash };
}

export async function sellerDisclose(id: bigint, key: Hex) {
  const { hash } = await send("seller", `disclose #${id} — publishing the key, embargo over`, () => {
    const wallet = walletFor("SELLER");
    return wallet.writeContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "disclose", args: [id, key], account: wallet.account!, chain: wallet.chain });
  });
  record({ actor: "system", level: "ok", message: `#${id} is now public. Any defender can decrypt it free and re-detonate the repro to check the oracle. Confirmation window for the contingent share is open.` });
  return { hash };
}

// --------------------------------------------------------- ground truth

/** The oracle records an external advisory (if one exists) to release the contingent. */
export async function oracleConfirm(id: bigint) {
  // Wait until a node reports the listing Disclosed, so the confirm tx does not
  // simulate against a lagging node and revert BadStatus (Base Sepolia race).
  for (let i = 0; i < 10; i++) {
    if ((await readListing(id)).status === Status.Disclosed) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const target = (await listingLogs(id)).listed.args.targetLabel as string;
  const advisory = groundTruth()[target];
  if (!advisory) {
    record({ actor: "oracle", level: "warn", message: `#${id}: no external advisory found for ${target} yet. The contingent stays escrowed; if none arrives, the buyer reclaims most of it.` });
    return { confirmed: false as const };
  }
  const { hash } = await send("oracle", `confirm #${id}: external advisory found`, () => {
    const wallet = walletFor("ORACLE");
    return wallet.writeContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "confirmOutcome", args: [id, advisory], account: wallet.account!, chain: wallet.chain });
  });
  record({ actor: "system", level: "ok", message: `#${id} confirmed by ground truth (${advisory}). Contingent share released to the seller; their confirmed-count went up.` });
  return { confirmed: true as const, hash };
}

export async function expireContingent(id: bigint) {
  const { hash } = await send("buyer", `expire contingent for #${id} (no advisory arrived in the window)`, () => {
    const wallet = walletFor("BUYER");
    return wallet.writeContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "expireContingent", args: [id], account: wallet.account!, chain: wallet.chain });
  });
  record({ actor: "system", level: "ok", message: `#${id}: contingent window closed with no advisory. Most of the escrow returned to the buyer; a slice went to the disclosure pool.` });
  return { hash };
}

// ------------------------------------- stateless wrappers (API drives by id)

function keyForListingTarget(targetLabel: string): Hex {
  const finding = findingForTarget(targetLabel);
  if (!finding) throw new Error(`no finding known for ${targetLabel}`);
  return keyForFinding(finding);
}

export async function buyById(id: bigint) {
  const decision = await buyerEvaluate(id);
  if (!decision.buy) return { bought: false as const, decision };
  await buyerBuy(id, decision.priceCeilingEth);
  return { bought: true as const, decision };
}

export async function deliverById(id: bigint) {
  const target = (await listingLogs(id)).listed.args.targetLabel as string;
  await sellerDeliver(id, keyForListingTarget(target));
  await buyerReceive(id);
}

export async function discloseById(id: bigint) {
  const target = (await listingLogs(id)).listed.args.targetLabel as string;
  await sellerDisclose(id, keyForListingTarget(target));
}

export async function resolveById(id: bigint) {
  const target = (await listingLogs(id)).listed.args.targetLabel as string;
  const finding = findingForTarget(target);
  if (!finding) throw new Error(`no finding known for ${target}`);
  return arbiterResolve(id, finding);
}

// ------------------------------------------------------------------- helpers

export function fmt(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0");
}

export { Status };
