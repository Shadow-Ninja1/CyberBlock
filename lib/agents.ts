/**
 * The three autonomous actors, as a set of actions over the contract.
 *
 * Each function performs one on-chain step, narrates it into the shared log, and
 * returns the log lines it produced. The CLI demo calls these in sequence; the web
 * API exposes them as endpoints. All signing uses the role keys from the env.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Hex } from "viem";
import {
  BAZAAR_ABI,
  BAZAAR_ADDRESS,
  walletFor,
  publicClient,
  readListing,
  listingLogs,
  DEPLOYED_AT_BLOCK,
  fairPrice,
  minStake,
  disputeBondFor,
  sellerRep,
  waitFor,
  txUrl,
} from "./chain";
import { sealFinding, wrapKey, unwrapKey, openFinding, publicKeyOf, deriveKey } from "./crypto";
import { attest, adjudicate } from "./oracle";
import { record } from "./store";
import { Status, type Finding, type LogLine, type SignedAttestation } from "./types";

const DEFAULT_EMBARGO = 2n * 60n; // MIN_EMBARGO

export function loadFinding(name: string): Finding {
  const path = resolve(process.cwd(), "fixtures/findings", name);
  return JSON.parse(readFileSync(path, "utf8")) as Finding;
}

export function listFindingFiles(): string[] {
  return ["evil-widget-1.2.0.json", "sneaky-utils-0.4.1.json"];
}

/** All findings the demo ships, valid and bad-faith alike. */
export function allFindingFiles(): string[] {
  return [
    "evil-widget-1.2.0.json",
    "sneaky-utils-0.4.1.json",
    "clean-lib-2.0.0.json",
    "overhyped-logger-1.0.3.json",
  ];
}

function sellerSecret(): Hex {
  return process.env.SELLER_PRIVATE_KEY as Hex;
}

/** The seller's reproducible per-finding key. Stateless across requests. */
export function keyForFinding(finding: Finding): Hex {
  return deriveKey(sellerSecret(), finding);
}

/** Maps a listing's on-chain target label back to its finding file. */
export function findingForTarget(targetLabel: string): Finding | null {
  for (const file of allFindingFiles()) {
    const f = loadFinding(file);
    if (`npm:${f.target.name}@${f.target.version}` === targetLabel) return f;
  }
  return null;
}

async function send(
  actor: LogLine["actor"],
  what: string,
  fn: () => Promise<Hex>,
): Promise<{ hash: Hex; lines: LogLine[] }> {
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

// -------------------------------------------------------- oracle: attestation

/**
 * The seller asks the oracle to grade a sealed finding. Returns either a signed
 * voucher (with the sealed blob to publish) or a public refusal.
 */
export async function requestAttestation(findingFile: string) {
  const finding = loadFinding(findingFile);
  record({ actor: "seller", level: "info", message: `sealing "${finding.title}" and requesting a grade` });

  // Seal with the reproducible per-finding key so deliver/disclose can recompute it.
  const sealed = sealFinding(finding, keyForFinding(finding));
  const outcome = await attest({ finding, ciphertext: sealed.ciphertext, key: sealed.key });

  if (!outcome.ok) {
    record({
      actor: "oracle",
      level: "warn",
      message: `REFUSED (${outcome.reason}): ${outcome.detail}`,
      data: outcome.facts,
    });
    return { ok: false as const, refusal: outcome, finding };
  }

  record({
    actor: "oracle",
    level: "ok",
    message: `attested ${outcome.meta.targetLabel}: severity ${outcome.att.severity}, ${outcome.meta.signalRules.length} rules, novel, signed`,
    data: {
      detectorHash: outcome.att.detectorHash,
      rules: outcome.meta.signalRules,
      osvIds: outcome.meta.osvIds,
    },
  });

  return {
    ok: true as const,
    finding,
    sealed,
    signed: { att: outcome.att, signature: outcome.signature, meta: outcome.meta } as SignedAttestation,
  };
}

// ---------------------------------------------------------------- seller: list

export async function sellerList(findingFile: string, embargo = DEFAULT_EMBARGO) {
  const att = await requestAttestation(findingFile);
  if (!att.ok) return { listed: false as const, refusal: att.refusal };

  const price = await fairPrice(att.signed.att, embargo);
  const stake = await minStake(price);
  const wallet = walletFor("SELLER");

  const { hash } = await send("seller", `list ${att.signed.meta.targetLabel} @ ${fmt(price)} ETH`, () =>
    wallet.writeContract({
      address: BAZAAR_ADDRESS,
      abi: BAZAAR_ABI,
      functionName: "list",
      args: [
        att.signed.att,
        att.signed.signature,
        price,
        embargo,
        att.signed.meta.targetLabel,
        att.sealed.ciphertext,
      ],
      value: stake,
      account: wallet.account!,
      chain: wallet.chain,
    }),
  );

  // The contract's duplicate lock maps this artifact hash to its listing id.
  const id = (await publicClient().readContract({
    address: BAZAAR_ADDRESS,
    abi: BAZAAR_ABI,
    functionName: "listingByArtifact",
    args: [att.signed.att.artifactHash],
  })) as bigint;
  record({
    actor: "seller",
    level: "ok",
    message: `listing #${id} live — sealed finding is in the event log; buyers see only the grade`,
    data: { txHash: hash, price: fmt(price), stake: fmt(stake), embargoMinutes: Number(embargo) / 60 },
  });
  return { listed: true as const, id, price, stake, finding: att.finding, sealed: att.sealed };
}

// ------------------------------------------------------------------ buyer: buy

export interface BuyPolicy {
  budgetEth: number;
  minSeverity: number;
  requireNovel: boolean;
  maxSellerSlashRate: number;
}

export const DEFAULT_POLICY: BuyPolicy = {
  budgetEth: 0.01,
  minSeverity: 40,
  requireNovel: true,
  maxSellerSlashRate: 0.34,
};

/**
 * The buyer agent decides whether a listing is worth buying from the attested
 * metadata alone — it never sees the finding first. If ANTHROPIC_API_KEY is set,
 * Claude makes the call and explains itself; otherwise a deterministic policy runs.
 */
export async function buyerEvaluate(id: bigint, policy = DEFAULT_POLICY) {
  const l = await readListing(id);
  const rep = await sellerRep(l.seller);
  const slashRate = rep.sold + rep.slashed === 0 ? 0 : rep.slashed / (rep.sold + rep.slashed);
  const priceEth = Number(l.price) / 1e18;

  const facts = {
    id: Number(id),
    severity: l.att.severity,
    vulnClass: l.att.vulnClass,
    novel: l.att.novel,
    installBase: l.att.installBase,
    priceEth,
    sellerRep: rep,
    slashRate,
  };

  const llm = await maybeAskClaude(facts, policy);
  if (llm) {
    record({ actor: "buyer", level: llm.buy ? "ok" : "warn", message: `Claude policy: ${llm.reason}`, data: facts });
    return { ...facts, buy: llm.buy, reason: llm.reason, decidedBy: "claude" as const };
  }

  const reasons: string[] = [];
  let buy = true;
  if (priceEth > policy.budgetEth) (buy = false), reasons.push(`price ${priceEth} > budget ${policy.budgetEth}`);
  if (l.att.severity < policy.minSeverity)
    (buy = false), reasons.push(`severity ${l.att.severity} < ${policy.minSeverity}`);
  if (policy.requireNovel && !l.att.novel) (buy = false), reasons.push("not novel");
  if (slashRate > policy.maxSellerSlashRate)
    (buy = false), reasons.push(`seller slash rate ${slashRate.toFixed(2)} too high`);

  const reason = buy
    ? `severity ${l.att.severity}, novel, ${fmt(l.price)} ETH within budget, seller ${rep.sold}/${rep.slashed} — buying`
    : `skipping: ${reasons.join("; ")}`;
  record({ actor: "buyer", level: buy ? "ok" : "warn", message: reason, data: facts });
  return { ...facts, buy, reason, decidedBy: "policy" as const };
}

async function maybeAskClaude(facts: Record<string, unknown>, policy: BuyPolicy) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: key });
    const msg = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 300,
      system:
        "You are an autonomous procurement agent for a security vendor buying supply-chain threat intel sight-unseen. You only see a signed grade, never the finding. Decide whether to buy. Respond as strict JSON {\"buy\": boolean, \"reason\": string}. Keep reason under 30 words.",
      messages: [
        {
          role: "user",
          content: `Policy: ${JSON.stringify(policy)}\nListing grade: ${JSON.stringify(facts)}\nBuy?`,
        },
      ],
    });
    const text = msg.content.find((c) => c.type === "text")?.text ?? "";
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    return { buy: Boolean(json.buy), reason: String(json.reason) };
  } catch (e) {
    record({ actor: "buyer", level: "warn", message: `Claude unavailable, using deterministic policy (${String(e).slice(0, 60)})` });
    return null;
  }
}

export async function buyerBuy(id: bigint) {
  const l = await readListing(id);
  // The buyer's encryption identity is the same secp256k1 key it signs txs with.
  const buyerPub = publicKeyOf(process.env.BUYER_PRIVATE_KEY as Hex);
  const wallet = walletFor("BUYER");
  const { hash } = await send("buyer", `buy listing #${id} for ${fmt(l.price)} ETH`, () =>
    wallet.writeContract({
      address: BAZAAR_ADDRESS,
      abi: BAZAAR_ABI,
      functionName: "buy",
      args: [id, buyerPub],
      value: l.price,
      account: wallet.account!,
      chain: wallet.chain,
    }),
  );
  return { hash };
}

// --------------------------------------------------------------- seller: deliver

export async function sellerDeliver(id: bigint, key: Hex) {
  // Recover the buyer's public key from the Bought event, then wrap K to it.
  const bought = (
    await publicClient().getContractEvents({
      address: BAZAAR_ADDRESS,
      abi: BAZAAR_ABI,
      eventName: "Bought",
      args: { id },
      fromBlock: DEPLOYED_AT_BLOCK,
    })
  )[0] as any;
  const buyerPublicKey = bought.args.buyerPubKey as Hex;

  const wrapped = wrapKey(key, buyerPublicKey);
  const { hash } = await send("seller", `deliver key for #${id} (wrapped to buyer's pubkey)`, () => {
    const wallet = walletFor("SELLER");
    return wallet.writeContract({
      address: BAZAAR_ADDRESS,
      abi: BAZAAR_ABI,
      functionName: "deliver",
      args: [id, wrapped],
      account: wallet.account!,
      chain: wallet.chain,
    });
  });
  return { hash };
}

/** Buyer opens the delivered key and verifies it against the attested contentHash. */
export async function buyerReceive(id: bigint) {
  const l = await readListing(id);
  const logs = await listingLogs(id);
  const wrapped = logs.delivered.args.encryptedKey as Hex;
  const key = unwrapKey(wrapped, process.env.BUYER_PRIVATE_KEY as Hex);
  const ciphertext = logs.listed.args.ciphertext as Hex;
  const finding = openFinding(ciphertext, key, l.att.contentHash);
  record({
    actor: "buyer",
    level: "ok",
    message: `unwrapped and verified #${id}: keccak(plaintext) == attested contentHash. Finding: "${finding.title}"`,
    data: { contentHash: l.att.contentHash },
  });
  return { finding, key };
}

// -------------------------------------------------------------------- disputes

export async function buyerDispute(id: bigint, reason: string) {
  const l = await readListing(id);
  const bond = await disputeBondFor(l.price);
  const { hash } = await send("buyer", `dispute #${id}: ${reason}`, () => {
    const wallet = walletFor("BUYER");
    return wallet.writeContract({
      address: BAZAAR_ADDRESS,
      abi: BAZAAR_ABI,
      functionName: "dispute",
      args: [id, reason],
      value: bond,
      account: wallet.account!,
      chain: wallet.chain,
    });
  });
  return { hash };
}

export async function oracleResolve(id: bigint, finding: Finding) {
  const l = await readListing(id);
  record({ actor: "oracle", level: "info", message: `re-running detector for disputed #${id}` });
  const verdict = await adjudicate({
    finding,
    attestedArtifactHash: l.att.artifactHash,
    attestedSeverity: l.att.severity,
    attestedDetectorHash: l.att.detectorHash,
  });
  record({
    actor: "oracle",
    level: verdict.sellerWins ? "ok" : "warn",
    message: `verdict on #${id}: ${verdict.sellerWins ? "seller upheld" : "buyer upheld"} — ${verdict.reason}`,
    data: verdict.facts,
  });
  const { hash } = await send("oracle", `resolve #${id} (sellerWins=${verdict.sellerWins})`, () => {
    const wallet = walletFor("ORACLE");
    return wallet.writeContract({
      address: BAZAAR_ADDRESS,
      abi: BAZAAR_ABI,
      functionName: "resolve",
      args: [id, verdict.sellerWins, verdict.reason],
      account: wallet.account!,
      chain: wallet.chain,
    });
  });
  return { hash, verdict };
}

// ---------------------------------------------------------- settle & disclose

export async function claimPayment(id: bigint) {
  const { hash } = await send("seller", `claim payment for #${id} (challenge window closed)`, () => {
    const wallet = walletFor("SELLER");
    return wallet.writeContract({
      address: BAZAAR_ADDRESS,
      abi: BAZAAR_ABI,
      functionName: "claimPayment",
      args: [id],
      account: wallet.account!,
      chain: wallet.chain,
    });
  });
  return { hash };
}

export async function sellerDisclose(id: bigint, key: Hex) {
  const { hash } = await send("seller", `disclose #${id} — publishing the key, embargo over`, () => {
    const wallet = walletFor("SELLER");
    return wallet.writeContract({
      address: BAZAAR_ADDRESS,
      abi: BAZAAR_ABI,
      functionName: "disclose",
      args: [id, key],
      account: wallet.account!,
      chain: wallet.chain,
    });
  });
  record({
    actor: "system",
    level: "ok",
    message: `#${id} is now public. Any defender can decrypt it free and re-run the detector to check the oracle.`,
  });
  return { hash };
}

// ------------------------------------- stateless wrappers (API drives by id)

function keyForListingTarget(targetLabel: string): Hex {
  const finding = findingForTarget(targetLabel);
  if (!finding) throw new Error(`no finding known for ${targetLabel}`);
  return keyForFinding(finding);
}

/** Buy if the policy says so; returns whether a purchase happened. */
export async function buyById(id: bigint) {
  const decision = await buyerEvaluate(id);
  if (!decision.buy) return { bought: false as const, decision };
  await buyerBuy(id);
  return { bought: true as const, decision };
}

export async function deliverById(id: bigint) {
  const l = await readListing(id);
  const target = (await listingLogs(id)).listed.args.targetLabel as string;
  const key = keyForListingTarget(target);
  await sellerDeliver(id, key);
  await buyerReceive(id);
  void l;
}

export async function discloseById(id: bigint) {
  const target = (await listingLogs(id)).listed.args.targetLabel as string;
  await sellerDisclose(id, keyForListingTarget(target));
}

export async function resolveById(id: bigint) {
  const target = (await listingLogs(id)).listed.args.targetLabel as string;
  const finding = findingForTarget(target);
  if (!finding) throw new Error(`no finding known for ${target}`);
  return oracleResolve(id, finding);
}

// ------------------------------------------------------------------- helpers

export function fmt(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0");
}

export { Status };
