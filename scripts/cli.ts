/**
 * cyberblock — agent-native CLI. Lets any autonomous agent trade on CyberBlock
 * with ITS OWN key, no browser, no server-held keys. Every command prints one
 * JSON object on stdout so an agent can parse it; errors go to stderr, exit 1.
 *
 *   CYBERBLOCK_PRIVATE_KEY=0x…  # the agent's Base Sepolia key (needs a little ETH)
 *   CYBERBLOCK_API=https://…    # the oracle host (default http://localhost:3000)
 *
 *   npx tsx scripts/cli.ts whoami
 *   npx tsx scripts/cli.ts market                       # what is for sale (metadata only)
 *   npx tsx scripts/cli.ts show <id>
 *   npx tsx scripts/cli.ts sell <finding.json> [--contingent 50]
 *   npx tsx scripts/cli.ts buy <id> [--max 0.01]
 *   npx tsx scripts/cli.ts deliver <id>                 # seller: wrap key to buyer
 *   npx tsx scripts/cli.ts receive <id>                 # buyer: decrypt + verify hash
 *   npx tsx scripts/cli.ts settle <id>                  # release base after window
 *   npx tsx scripts/cli.ts challenge <id> [reason]      # buyer: re-detonate + dispute
 *   npx tsx scripts/cli.ts disclose <id>                # seller: publish key
 *   npx tsx scripts/cli.ts verify <id>                  # anyone: re-run the sandbox
 *
 * The seal key is derived from the agent's private key + the finding, so the
 * seller can deliver/disclose from any machine holding the key; it is also cached
 * in ~/.cyberblock/keys.json for convenience.
 */
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { createWalletClient, http, formatEther, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CONTRACT_ABI, CONTRACT_ADDRESS, chain, publicClient, readListing, listingLogs, firstEvent,
  currentPrice, priceCap, minStake, challengeBondFor, waitFor, txUrl,
} from "../lib/chain";
import { sealFinding, deriveKey, wrapKey, unwrapKey, openFinding, publicKeyOf } from "../lib/crypto";
import { run } from "../lib/sandbox";
import { effectList, STATUS_LABEL, type Finding } from "../lib/types";

const API = (process.env.CYBERBLOCK_API ?? "http://localhost:3000").replace(/\/$/, "");
const KEYS_FILE = resolve(homedir(), ".cyberblock", "keys.json");

// ------------------------------------------------------------------ helpers

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}
function out(obj: unknown) {
  console.log(JSON.stringify(obj, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function privateKey(): Hex {
  const k = process.env.CYBERBLOCK_PRIVATE_KEY;
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) fail("set CYBERBLOCK_PRIVATE_KEY to your agent's 0x… private key");
  return k as Hex;
}
function wallet() {
  const account = privateKeyToAccount(privateKey());
  return createWalletClient({ account, chain, transport: http() });
}
async function tx(functionName: string, args: unknown[], value?: bigint) {
  const w = wallet();
  const hash = await w.writeContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName, args, value, account: w.account, chain });
  const receipt = await waitFor(hash);
  if (receipt.status !== "success") fail(`${functionName} reverted: ${txUrl(hash)}`);
  return { hash, block: receipt.blockNumber, explorer: txUrl(hash) };
}
function loadKeys(): Record<string, Hex> {
  return existsSync(KEYS_FILE) ? JSON.parse(readFileSync(KEYS_FILE, "utf8")) : {};
}
function saveKey(id: bigint, key: Hex) {
  const keys = loadKeys();
  keys[id.toString()] = key;
  mkdirSync(dirname(KEYS_FILE), { recursive: true });
  writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}
function keyFor(id: bigint): Hex {
  const k = loadKeys()[id.toString()];
  if (!k) fail(`no seal key cached for #${id} — run \`sell\` from this machine, or pass --key 0x…`);
  return k;
}
async function api(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}
/** Wait for an event on Base Sepolia, which indexes a few seconds behind. */
async function waitForEvent(name: "Listed" | "Delivered" | "Disclosed" | "Bought", id: bigint) {
  for (let i = 0; i < 12; i++) {
    const ev = await firstEvent(name as any, id);
    if (ev) return ev;
    await new Promise((r) => setTimeout(r, 1500));
  }
  fail(`${name} event for #${id} not indexed yet — retry in a moment`);
}
/** The bytes the oracle graded: inline data URL, or a local file we inline ourselves. */
function artifactBytes(finding: Finding): Buffer {
  const m = /^data:[^;,]*;base64,(.*)$/s.exec(finding.target.artifact);
  if (m) return Buffer.from(m[1], "base64");
  return readFileSync(resolve(process.cwd(), finding.target.artifact));
}
async function summary(id: bigint) {
  const l = await readListing(id);
  const { listed } = await listingLogs(id, l.status);
  const price = l.status === 1 ? await currentPrice(id) : l.price;
  return {
    id,
    status: STATUS_LABEL[l.status],
    target: listed?.args?.targetLabel,
    outcome: listed?.args?.outcome,
    effects: effectList(l.att.effects).map((e) => e.label),
    novel: l.att.novel,
    installBase: l.att.installBase,
    priceEth: Number(formatEther(price)),
    contingentPct: l.auction.contingentBps / 100,
    seller: l.seller,
    buyer: l.buyer,
    traceHash: l.att.traceHash,
    sandboxHash: l.att.sandboxHash,
  };
}

// ----------------------------------------------------------------- commands

const commands: Record<string, (args: string[]) => Promise<unknown>> = {
  async whoami() {
    const address = privateKeyToAccount(privateKey()).address;
    const balance = await publicClient().getBalance({ address });
    return { address, balanceEth: Number(formatEther(balance)), chainId: chain.id, contract: CONTRACT_ADDRESS, api: API };
  },

  async market() {
    const next = (await publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "nextListingId" })) as bigint;
    const ids = Array.from({ length: Number(next) - 1 }, (_, i) => BigInt(i + 1));
    return { listings: await Promise.all(ids.map(summary)) };
  },

  async show([id]) {
    if (!id) fail("usage: show <id>");
    return summary(BigInt(id));
  },

  /** Seal → oracle detonates and signs → list() from the agent's wallet. */
  async sell([file, ...rest]) {
    if (!file) fail("usage: sell <finding.json> [--contingent 50]");
    const finding = JSON.parse(readFileSync(resolve(process.cwd(), file), "utf8")) as Finding;
    // The oracle only reads fixtures/ from disk, so a bring-your-own package is
    // shipped inline: the graded bytes then travel inside the sealed finding.
    if (!/^(data:|https?:\/\/|fixtures\/)/.test(finding.target.artifact)) {
      finding.target.artifact = `data:application/gzip;base64,${readFileSync(resolve(process.cwd(), finding.target.artifact)).toString("base64")}`;
    }
    const sealed = sealFinding(finding, deriveKey(privateKey(), finding));

    const graded = await api("/api/oracle/attest", { finding, ciphertext: sealed.ciphertext, key: sealed.key });
    if (!graded.ok) return { listed: false, refusal: graded.refusal };
    const att = { ...graded.att, expiresAt: BigInt(graded.att.expiresAt) };

    const me = wallet().account.address;
    const cap = await priceCap(me);
    const startPrice = cap;
    const reservePrice = cap / 4n;
    const stake = await minStake(reservePrice);
    const contingentBps = Math.round(Number(flag(rest, "contingent") ?? 50) * 100);
    const duration = 3n * 60n;
    const embargo = 2n * 60n;

    const sent = await tx("list", [att, graded.signature, graded.outcome, startPrice, reservePrice, duration, contingentBps, embargo, graded.targetLabel, sealed.ciphertext], stake);

    let id = 0n;
    for (let i = 0; i < 8 && id === 0n; i++) {
      id = (await publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "listingByArtifact", args: [att.artifactHash] })) as bigint;
      if (id === 0n) await new Promise((r) => setTimeout(r, 1500));
    }
    saveKey(id, sealed.key);
    return {
      listed: true, id, tx: sent, key: sealed.key,
      effects: graded.effectLabels, judge: graded.judge,
      startPriceEth: Number(formatEther(startPrice)), reservePriceEth: Number(formatEther(reservePrice)), stakeEth: Number(formatEther(stake)), contingentPct: contingentBps / 100,
    };
  },

  /** Pays the current auction price (capped by --max); the contract refunds any decay. */
  async buy([id, ...rest]) {
    if (!id) fail("usage: buy <id> [--max 0.01]");
    const now = await currentPrice(BigInt(id));
    const max = flag(rest, "max") ? parseEther(flag(rest, "max")!) : now;
    if (now > max) fail(`current price ${formatEther(now)} ETH exceeds --max ${formatEther(max)}`);
    const sent = await tx("buy", [BigInt(id), publicKeyOf(privateKey())], now);
    const l = await readListing(BigInt(id));
    return { bought: true, id, paidEth: Number(formatEther(l.price)), baseEth: Number(formatEther(l.basePart)), contingentEth: Number(formatEther(l.contingentPart)), tx: sent };
  },

  async deliver([id, ...rest]) {
    if (!id) fail("usage: deliver <id> [--key 0x…]");
    const key = (flag(rest, "key") as Hex) ?? keyFor(BigInt(id));
    const bought = await waitForEvent("Bought", BigInt(id));
    const sent = await tx("deliver", [BigInt(id), wrapKey(key, bought.args.buyerPubKey as Hex)]);
    return { delivered: true, id, tx: sent };
  },

  /** Unwraps the key and refuses anything that does not hash to the on-chain commitment. */
  async receive([id]) {
    if (!id) fail("usage: receive <id>");
    const l = await readListing(BigInt(id));
    const delivered = await waitForEvent("Delivered", BigInt(id));
    const { listed } = await listingLogs(BigInt(id));
    const key = unwrapKey(delivered.args.encryptedKey as Hex, privateKey());
    const finding = openFinding(listed.args.ciphertext as Hex, key, l.att.contentHash);
    saveKey(BigInt(id), key);
    return { id, verified: true, contentHash: l.att.contentHash, finding };
  },

  async settle([id]) {
    if (!id) fail("usage: settle <id>");
    return { settled: true, id, tx: await tx("claimPayment", [BigInt(id)]) };
  },

  /** Re-detonate locally (if we hold the finding) and post the trace hash we got. */
  async challenge([id, ...reasonParts]) {
    if (!id) fail("usage: challenge <id> [reason]");
    const reason = reasonParts.join(" ") || "buyer disputes the attested trace";
    const l = await readListing(BigInt(id));
    let claimedTraceHash: Hex = `0x${"0".repeat(64)}`;
    const key = loadKeys()[id];
    if (key) {
      const { listed } = await listingLogs(BigInt(id));
      const finding = openFinding(listed.args.ciphertext as Hex, key, l.att.contentHash);
      try { claimedTraceHash = run(artifactBytes(finding), finding.repro).traceHash; } catch { /* artifact not local; post zero hash */ }
    }
    const bond = await challengeBondFor(l.price);
    const sent = await tx("challenge", [BigInt(id), claimedTraceHash, reason], bond);
    return { challenged: true, id, myTraceHash: claimedTraceHash, attestedTraceHash: l.att.traceHash, bondEth: Number(formatEther(bond)), tx: sent };
  },

  async disclose([id, ...rest]) {
    if (!id) fail("usage: disclose <id> [--key 0x…]");
    const key = (flag(rest, "key") as Hex) ?? keyFor(BigInt(id));
    return { disclosed: true, id, tx: await tx("disclose", [BigInt(id), key]) };
  },

  async verify([id]) {
    if (!id) fail("usage: verify <id>");
    const r = await api("/api/verify", { id: Number(id) });
    if (!r.ok) fail(r.error);
    return { id, reproduced: r.reproduced, matches: r.matches, attested: r.attested, rerunEffects: r.rerun.effectLabels };
  },
};

const [cmd, ...args] = process.argv.slice(2);
const handler = commands[cmd ?? ""];
if (!handler) {
  console.error(`usage: cyberblock <${Object.keys(commands).join("|")}> …\n\nsee the header of scripts/cli.ts for each command`);
  process.exit(1);
}
handler(args).then(out).catch((e) => fail(e instanceof Error ? e.message.split("\n")[0] : String(e)));
