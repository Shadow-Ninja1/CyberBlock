/**
 * The browser side of the market.
 *
 * Everything here runs in the visitor's tab with THEIR wallet. A real seller
 * seals a finding and signs `list()`; a real buyer signs `buy()`; the seller
 * delivers and discloses; the buyer decrypts what was delivered — all with the
 * same crypto and the same contract the autonomous agents use, just signed by an
 * injected wallet (EIP-1193) instead of a server-held key.
 *
 * The oracle still grades: only its key can sign the attestation the contract
 * demands, so submission POSTs the sealed finding to /api/oracle/attest and gets
 * back a signature. Nothing else touches the server.
 */
"use client";

import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type EIP1193Provider,
  type PublicClient,
} from "viem";
import { baseSepolia, hardhat } from "viem/chains";
import contract from "./contract.json";
import { deriveKey, sealFinding, wrapKey, unwrapKey, openFinding, contentHashOf } from "./crypto";
import { PrivateKey } from "eciesjs";
import type { AttestationStruct, Finding, Repro } from "./types";

export const CONTRACT_ABI = contract.abi;
export const CONTRACT_ADDRESS = getAddress(contract.address) as Address;
export const CHAIN_ID = contract.chainId as number;
export const DEPLOYED_AT_BLOCK = BigInt(contract.deployedAtBlock ?? 0);
export const CHAIN = CHAIN_ID === 84532 ? baseSepolia : hardhat;
export const CHAIN_ID_HEX = `0x${CHAIN_ID.toString(16)}`;
export const EXPLORER = CHAIN_ID === 84532 ? "https://sepolia.basescan.org" : "http://localhost:8545";

function rpcUrl(): string {
  return process.env.NEXT_PUBLIC_RPC_URL ?? (CHAIN_ID === 84532 ? "https://sepolia.base.org" : "http://127.0.0.1:8545");
}

/** eth_getLogs goes to a provider that allows wide block ranges (keyed free tiers
 *  such as Alchemy cap it at 10 blocks). See logsRpcUrl() in chain.ts. */
function logsRpcUrl(): string {
  if (CHAIN_ID !== 84532) return rpcUrl();
  return process.env.NEXT_PUBLIC_LOGS_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com";
}

let _pub: PublicClient | null = null;
export function publicClient(): PublicClient {
  if (!_pub) _pub = createPublicClient({ chain: CHAIN, transport: http(rpcUrl(), { batch: true }) }) as PublicClient;
  return _pub;
}

let _logs: PublicClient | null = null;
function logsClient(): PublicClient {
  if (!_logs) _logs = createPublicClient({ chain: CHAIN, transport: http(logsRpcUrl()) }) as PublicClient;
  return _logs;
}

// ------------------------------------------------------------------ wallet

/** The injected provider, if any. Wallets that only speak EIP-6963 (and some
 *  that inject `window.ethereum` late) are picked up by `discoverProvider()`. */
let _provider: EIP1193Provider | null = null;
export function getProvider(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return _provider ?? (window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null;
}
export function hasWallet(): boolean {
  return !!getProvider();
}

/** Listen for wallets that announce themselves (EIP-6963) or inject after the
 *  page has mounted. `onFound` fires once a provider is available. Returns a
 *  cleanup. */
export function discoverProvider(onFound: (p: EIP1193Provider) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const found = (p: EIP1193Provider) => {
    if (!_provider) _provider = p;
    onFound(getProvider()!);
  };
  const onAnnounce = (e: Event) => {
    const detail = (e as CustomEvent<{ provider?: EIP1193Provider }>).detail;
    if (detail?.provider) found(detail.provider);
  };
  const onInit = () => {
    const p = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
    if (p) found(p);
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.addEventListener("ethereum#initialized", onInit);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  onInit();
  return () => {
    window.removeEventListener("eip6963:announceProvider", onAnnounce);
    window.removeEventListener("ethereum#initialized", onInit);
  };
}

function wallet() {
  const provider = getProvider();
  if (!provider) throw new Error("No wallet found. Install a browser wallet (e.g. MetaMask, Rabby, Coinbase Wallet).");
  return createWalletClient({ chain: CHAIN, transport: custom(provider) });
}

/** Turn wallet RPC errors into something a person can act on. */
export function walletErrorMessage(e: unknown): string {
  const err = e as { code?: number; message?: string; shortMessage?: string; cause?: { code?: number } };
  const code = err?.code ?? err?.cause?.code;
  if (code === 4001) return "Request rejected in your wallet.";
  if (code === -32002) return "Your wallet already has a pending request — open it and finish that first.";
  const msg = err?.shortMessage ?? err?.message ?? String(e);
  return msg.split("\n")[0];
}

/** Ask the wallet for an account. Chain switching is deliberately NOT part of
 *  connecting: a rejected/unsupported network switch must not leave the user
 *  looking unconnected. The UI shows a "switch network" control instead. */
export async function connect(): Promise<Address> {
  const provider = getProvider();
  if (!provider) throw new Error("No wallet found. Install a browser wallet (e.g. MetaMask, Rabby, Coinbase Wallet).");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.[0]) throw new Error("No account authorized.");
  return getAddress(accounts[0]);
}

export async function currentChainId(): Promise<number | null> {
  const provider = getProvider();
  if (!provider) return null;
  try {
    const id = (await provider.request({ method: "eth_chainId" })) as string;
    return parseInt(id, 16);
  } catch {
    return null;
  }
}

/** Push the wallet onto Base Sepolia, adding it if the wallet does not know it. */
export async function ensureChain(): Promise<void> {
  const provider = getProvider();
  if (!provider) return;
  if ((await currentChainId()) === CHAIN_ID) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 4902 && CHAIN_ID === 84532) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: CHAIN_ID_HEX,
            chainName: "Base Sepolia",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: [rpcUrl()],
            blockExplorerUrls: [EXPLORER],
          },
        ],
      });
    } else {
      throw e;
    }
  }
}

export async function balanceEth(address: Address): Promise<number> {
  return Number(await publicClient().getBalance({ address })) / 1e18;
}

// -------------------------------------------------------- reads (public RPC)

export async function readListing(id: bigint): Promise<any> {
  return publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "getListing", args: [id] });
}
export async function currentPrice(id: bigint): Promise<bigint> {
  return publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "currentPrice", args: [id] }) as Promise<bigint>;
}
export async function priceCap(seller: Address): Promise<bigint> {
  return publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "priceCap", args: [seller] }) as Promise<bigint>;
}
export async function minStake(reservePrice: bigint): Promise<bigint> {
  return publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "minStake", args: [reservePrice] }) as Promise<bigint>;
}
export async function listingByArtifact(artifactHash: Hex): Promise<bigint> {
  return publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "listingByArtifact", args: [artifactHash] }) as Promise<bigint>;
}

async function firstEvent(eventName: string, id: bigint, tries = 16): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const events = await logsClient().getContractEvents({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, eventName: eventName as any, args: { id }, fromBlock: DEPLOYED_AT_BLOCK });
    if (events[0]) return events[0];
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`${eventName} for #${id} not indexed yet — the testnet node is lagging; try again in a moment.`);
}

async function waitReceipt(hash: Hex) {
  return publicClient().waitForTransactionReceipt({ hash, timeout: 120_000 });
}

// ------------------------------------------------ per-browser delivery inbox

const INBOX_KEY = "cyberblock.inbox.v1";

/** A throwaway secp256k1 keypair, private to this browser, used only as the
 *  envelope the seller wraps the decryption key to. It is separate from the
 *  wallet that pays — a browser wallet never exposes its raw key for ECIES — so
 *  this is the buyer's "encrypted-delivery address", like a PGP key. */
export function inboxKeypair(): { priv: Hex; pub: Hex } {
  if (typeof window !== "undefined") {
    const saved = window.localStorage.getItem(INBOX_KEY);
    if (saved) {
      try {
        const p = JSON.parse(saved);
        if (p.priv && p.pub) return p;
      } catch {}
    }
  }
  const k = new PrivateKey();
  const pair = { priv: `0x${k.toHex()}` as Hex, pub: `0x${k.publicKey.toHex(false)}` as Hex };
  if (typeof window !== "undefined") window.localStorage.setItem(INBOX_KEY, JSON.stringify(pair));
  return pair;
}

// --------------------------------------------- seller key (from a signature)

const KEY_CACHE = "cyberblock.findingkeys.v1";
const MASTER_MESSAGE = "CyberBlock seller key v2 — sign to derive your finding-encryption master secret. This costs nothing and sends nothing.";

function cacheGet(contentHash: Hex): Hex | null {
  if (typeof window === "undefined") return null;
  try {
    return (JSON.parse(window.localStorage.getItem(KEY_CACHE) ?? "{}")[contentHash.toLowerCase()] as Hex) ?? null;
  } catch {
    return null;
  }
}
function cacheSet(contentHash: Hex, key: Hex) {
  if (typeof window === "undefined") return;
  try {
    const all = JSON.parse(window.localStorage.getItem(KEY_CACHE) ?? "{}");
    all[contentHash.toLowerCase()] = key;
    window.localStorage.setItem(KEY_CACHE, JSON.stringify(all));
  } catch {}
}

const ID_KEY_CACHE = "cyberblock.listingkeys.v1";
/** Cache K by listing id, so the seller can deliver/disclose after a page reload
 *  without still holding the original finding object in memory. */
export function cacheKeyById(id: bigint, key: Hex) {
  if (typeof window === "undefined") return;
  try {
    const all = JSON.parse(window.localStorage.getItem(ID_KEY_CACHE) ?? "{}");
    all[String(id)] = key;
    window.localStorage.setItem(ID_KEY_CACHE, JSON.stringify(all));
  } catch {}
}
export function keyById(id: bigint): Hex | null {
  if (typeof window === "undefined") return null;
  try {
    return (JSON.parse(window.localStorage.getItem(ID_KEY_CACHE) ?? "{}")[String(id)] as Hex) ?? null;
  } catch {
    return null;
  }
}

async function resolveKey(account: Address, id: bigint, finding?: Finding): Promise<Hex> {
  const byId = keyById(id);
  if (byId) return byId;
  if (finding) return findingKey(account, finding);
  throw new Error("This browser does not hold the encryption key for this listing. Deliver/disclose from the same browser you listed from.");
}

/** Derive the per-finding symmetric key. The seller signs one fixed message to
 *  unlock a master secret (deterministic ECDSA → reproducible), and K falls out
 *  of that plus the finding's content hash — so any device holding the wallet can
 *  recompute K to deliver or disclose later. Cached locally for reliability. */
export async function findingKey(account: Address, finding: Finding): Promise<Hex> {
  const contentHash = contentHashOf(finding);
  const cached = cacheGet(contentHash);
  if (cached) return cached;
  const signature = await wallet().signMessage({ account, message: MASTER_MESSAGE });
  const master = keccak256(signature);
  const key = deriveKey(master, finding);
  cacheSet(contentHash, key);
  return key;
}

// ------------------------------------------------------------ package build

function tarHeader(name: string, size: number): Uint8Array {
  const h = new Uint8Array(512);
  const enc = new TextEncoder();
  const put = (s: string, off: number) => h.set(enc.encode(s), off);
  put(`package/${name}`.slice(0, 100), 0);
  put("0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(size.toString(8).padStart(11, "0") + "\0", 124);
  put("00000000000\0", 136);
  put("        ", 148);
  put("0", 156);
  put("ustar\0", 257);
  put("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  writer.write(data as BufferSource);
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

/** Build the gzipped npm tarball the sandbox will detonate, from a file map. */
export async function buildTarball(files: Record<string, string>): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const name of Object.keys(files).sort()) {
    const body = enc.encode(files[name]);
    blocks.push(tarHeader(name, body.length));
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const tar = new Uint8Array(total);
  let o = 0;
  for (const b of blocks) (tar.set(b, o), (o += b.length));
  return gzip(tar);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export async function tarballDataUrl(files: Record<string, string>): Promise<string> {
  const tgz = await buildTarball(files);
  return `data:application/gzip;base64,${toBase64(tgz)}`;
}

// ------------------------------------------------------------------ actions

export interface AttestResponse {
  ok: boolean;
  refusal?: { reason: string; detail: string; facts?: Record<string, unknown> };
  att?: AttestationStruct & { expiresAt: string };
  signature?: Hex;
  outcome?: string;
  targetLabel?: string;
  effects?: number;
  effectLabels?: string[];
  novel?: boolean;
  installBase?: number;
  judge?: { achieved: boolean; reason: string; by: string };
  captures?: unknown[];
}

export interface FindingInput {
  name: string;
  version: string;
  repro: Repro;
  claimedEffects: number;
  outcome: string;
  expectedResult: string;
  writeup: string;
  remediation: string;
  reporter: string;
  /** Either a set of files to pack into a tarball, or a ready data: URL / fixture path. */
  files?: Record<string, string>;
  artifact?: string;
}

export async function buildFinding(input: FindingInput): Promise<Finding> {
  const artifact = input.artifact ?? (input.files ? await tarballDataUrl(input.files) : "");
  if (!artifact) throw new Error("No package supplied.");
  return {
    schema: "cyberblock.finding.v2",
    target: { ecosystem: "npm", name: input.name, version: input.version, artifact },
    repro: input.repro,
    claimedEffects: input.claimedEffects,
    outcome: input.outcome,
    expectedResult: input.expectedResult,
    writeup: input.writeup,
    remediation: input.remediation,
    reporter: input.reporter,
  };
}

/** Ask the oracle to detonate and sign. Client seals first so K never round-trips
 *  in the clear beyond the oracle, exactly as the design intends. */
export async function gradeFinding(account: Address, finding: Finding): Promise<{ attest: AttestResponse; ciphertext: Hex; key: Hex; contentHash: Hex }> {
  const key = await findingKey(account, finding);
  const sealed = sealFinding(finding, key);
  const res = await fetch("/api/oracle/attest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ finding, ciphertext: sealed.ciphertext, key }),
  });
  const attest = (await res.json()) as AttestResponse;
  return { attest, ciphertext: sealed.ciphertext, key, contentHash: sealed.contentHash };
}

export interface ListParams {
  startPriceEth: number;
  reserveFraction: number; // reserve = start * fraction
  durationSeconds: number;
  contingentBps: number;
  embargoSeconds: number;
}

/** Sign `list()` from the seller's wallet. Returns the new listing id. */
export async function listFromWallet(
  account: Address,
  graded: { attest: AttestResponse; ciphertext: Hex },
  params: ListParams,
): Promise<{ id: bigint; hash: Hex }> {
  const a = graded.attest;
  if (!a.ok || !a.att || !a.signature) throw new Error("Not graded.");
  const att = { ...a.att, expiresAt: BigInt(a.att.expiresAt) };

  const cap = await priceCap(account);
  let startPrice = BigInt(Math.floor(params.startPriceEth * 1e18));
  if (startPrice > cap) startPrice = cap;
  if (startPrice === 0n) throw new Error("Your reputation price cap is 0 (too many slashes) — cannot open an auction.");
  let reservePrice = BigInt(Math.floor(Number(startPrice) * params.reserveFraction));
  if (reservePrice === 0n) reservePrice = startPrice / 4n || 1n;
  if (reservePrice > startPrice) reservePrice = startPrice;
  const stake = await minStake(reservePrice);

  await ensureChain();
  const hash = await wallet().writeContract({
    account,
    chain: CHAIN,
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "list",
    args: [att, a.signature, a.outcome, startPrice, reservePrice, BigInt(params.durationSeconds), params.contingentBps, BigInt(params.embargoSeconds), a.targetLabel, graded.ciphertext],
    value: stake,
  });
  await waitReceipt(hash);
  let id = 0n;
  for (let i = 0; i < 8 && id === 0n; i++) {
    id = await listingByArtifact(att.artifactHash);
    if (id === 0n) await new Promise((r) => setTimeout(r, 1500));
  }
  return { id, hash };
}

/** After a successful list, remember K under the listing id so this browser can
 *  deliver and disclose later even after a reload. */
export function rememberListingKey(id: bigint, key: Hex) {
  cacheKeyById(id, key);
}

export async function buyFromWallet(account: Address, id: bigint): Promise<Hex> {
  const inbox = inboxKeypair();
  // Quote the auction's start price as a ceiling rather than the live price. The
  // price only decays, and the contract refunds any excess, so sending the ceiling
  // removes the cross-node race where a read against a node whose block is slightly
  // ahead reports a lower price than the node that mines the buy will charge.
  const listing = await readListing(id);
  const ceiling = BigInt(listing.auction.startPrice);
  const live = await currentPrice(id);
  const value = ceiling > live ? ceiling : live;
  await ensureChain();
  const hash = await wallet().writeContract({
    account,
    chain: CHAIN,
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "buy",
    args: [id, inbox.pub],
    value,
  });
  await waitReceipt(hash);
  return hash;
}

/** Seller delivers the key, wrapped to the buyer's inbox public key. */
export async function deliverFromWallet(account: Address, id: bigint, finding?: Finding): Promise<Hex> {
  const bought = await firstEvent("Bought", id);
  const buyerPub = bought.args.buyerPubKey as Hex;
  const key = await resolveKey(account, id, finding);
  const wrapped = wrapKey(key, buyerPub);
  await ensureChain();
  const hash = await wallet().writeContract({
    account,
    chain: CHAIN,
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "deliver",
    args: [id, wrapped],
  });
  await waitReceipt(hash);
  return hash;
}

/** Buyer decrypts what was delivered. No transaction — pure local crypto. */
export async function receiveDelivery(id: bigint, contentHash: Hex): Promise<Finding> {
  const [listed, delivered] = await Promise.all([firstEvent("Listed", id), firstEvent("Delivered", id)]);
  const inbox = inboxKeypair();
  const key = unwrapKey(delivered.args.encryptedKey as Hex, inbox.priv);
  return openFinding(listed.args.ciphertext as Hex, key, contentHash);
}

export async function settleFromWallet(account: Address, id: bigint): Promise<Hex> {
  await ensureChain();
  const hash = await wallet().writeContract({ account, chain: CHAIN, address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "claimPayment", args: [id] });
  await waitReceipt(hash);
  return hash;
}
/** Buyer reclaims price + stake when a paid seller never delivered before the deadline. */
export async function claimTimeoutFromWallet(account: Address, id: bigint): Promise<Hex> {
  await ensureChain();
  const hash = await wallet().writeContract({ account, chain: CHAIN, address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "claimTimeout", args: [id] });
  await waitReceipt(hash);
  return hash;
}

export async function discloseFromWallet(account: Address, id: bigint, finding?: Finding): Promise<Hex> {
  const key = await resolveKey(account, id, finding);
  await ensureChain();
  const hash = await wallet().writeContract({ account, chain: CHAIN, address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "disclose", args: [id, key] });
  await waitReceipt(hash);
  return hash;
}

export function txUrl(hash: Hex): string {
  return `${EXPLORER}/tx/${hash}`;
}
