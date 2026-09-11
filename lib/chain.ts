import {
  createPublicClient,
  createWalletClient,
  http,
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, hardhat } from "viem/chains";
import contract from "./contract.json";
import { Status, type AttestationStruct } from "./types";

export const CONTRACT_ABI = contract.abi;
export const CHAIN_ID = contract.chainId as number;
export const CONTRACT_ADDRESS = getAddress(contract.address) as Address;
export const ORACLE_ADDRESS = getAddress(contract.oracle) as Address;
export const ARBITER_ADDRESS = getAddress((contract as any).arbiter ?? contract.oracle) as Address;
export const DEPLOYED_AT_BLOCK = BigInt(contract.deployedAtBlock ?? 0);

export const chain = CHAIN_ID === 84532 ? baseSepolia : hardhat;

export const EXPLORER = CHAIN_ID === 84532 ? "https://sepolia.basescan.org" : "http://localhost:8545";

export function txUrl(hash: Hex): string {
  return `${EXPLORER}/tx/${hash}`;
}
export function addressUrl(address: string): string {
  return `${EXPLORER}/address/${address}`;
}

/** Endpoint for eth_call traffic (getListing, sellerRep, currentPrice, ...). A keyed
 *  provider such as Alchemy is ideal here: high rate limit, and these calls are
 *  tiny. Concurrent reads are coalesced into one JSON-RPC batch per tick. */
function rpcUrl(): string {
  if (CHAIN_ID === 31337) return process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545";
  return process.env.NEXT_PUBLIC_RPC_URL ?? process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
}

/** Endpoint for eth_getLogs. We scan from the deploy block to head, which keyed
 *  free tiers refuse (Alchemy caps free getLogs at a 10-block range), so logs go
 *  to a provider that allows wide ranges. Defaults to the calls endpoint on
 *  localhost and to publicnode on Base Sepolia; override with LOGS_RPC_URL. */
function logsRpcUrl(): string {
  if (CHAIN_ID === 31337) return rpcUrl();
  return process.env.LOGS_RPC_URL ?? process.env.NEXT_PUBLIC_LOGS_RPC_URL ?? "https://base-sepolia-rpc.publicnode.com";
}

let cachedPublic: PublicClient | null = null;
export function publicClient(): PublicClient {
  if (!cachedPublic) cachedPublic = createPublicClient({ chain, transport: http(rpcUrl(), { batch: true }) }) as PublicClient;
  return cachedPublic;
}

let cachedLogs: PublicClient | null = null;
export function logsClient(): PublicClient {
  if (!cachedLogs) cachedLogs = createPublicClient({ chain, transport: http(logsRpcUrl()) }) as PublicClient;
  return cachedLogs;
}

export type Role = "ORACLE" | "ARBITER" | "SELLER" | "BUYER";

export function privateKeyFor(role: Role): Hex {
  const key = process.env[`${role}_PRIVATE_KEY`];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${role}_PRIVATE_KEY is missing or malformed in the environment`);
  return key as Hex;
}
export function accountFor(role: Role) {
  return privateKeyToAccount(privateKeyFor(role));
}
export function walletFor(role: Role): WalletClient {
  return createWalletClient({ account: accountFor(role), chain, transport: http(rpcUrl()) });
}

// ------------------------------------------------------------------ EIP-712

export const EIP712_DOMAIN = {
  name: "CyberBlock",
  version: "2",
  chainId: CHAIN_ID,
  verifyingContract: CONTRACT_ADDRESS,
} as const;

export const EIP712_TYPES = {
  Attestation: [
    { name: "artifactHash", type: "bytes32" },
    { name: "contentHash", type: "bytes32" },
    { name: "keyHash", type: "bytes32" },
    { name: "traceHash", type: "bytes32" },
    { name: "sandboxHash", type: "bytes32" },
    { name: "outcomeHash", type: "bytes32" },
    { name: "effects", type: "uint16" },
    { name: "novel", type: "bool" },
    { name: "installBase", type: "uint32" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export async function signAttestation(att: AttestationStruct): Promise<Hex> {
  return accountFor("ORACLE").signTypedData({ domain: EIP712_DOMAIN, types: EIP712_TYPES, primaryType: "Attestation", message: att });
}

// ---------------------------------------------------------------- read paths

export interface OnChainAuction {
  startPrice: bigint;
  reservePrice: bigint;
  startedAt: bigint;
  duration: bigint;
  contingentBps: number;
}

export interface OnChainListing {
  id: bigint;
  seller: Address;
  buyer: Address;
  challenger: Address;
  price: bigint;
  basePart: bigint;
  contingentPart: bigint;
  stake: bigint;
  challengeBond: bigint;
  embargo: bigint;
  soldAt: bigint;
  deliveredAt: bigint;
  disclosedAt: bigint;
  status: number;
  contingent: number;
  att: AttestationStruct;
  auction: OnChainAuction;
}

export async function readListing(id: bigint): Promise<OnChainListing> {
  const l = (await publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "getListing", args: [id] })) as any;
  return { id, ...l };
}

export async function nextListingId(): Promise<bigint> {
  return (await publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "nextListingId" })) as bigint;
}

export async function allListings(): Promise<OnChainListing[]> {
  const next = await nextListingId();
  const ids = Array.from({ length: Number(next) - 1 }, (_, i) => BigInt(i + 1));
  return Promise.all(ids.map(readListing));
}

export async function sellerRep(address: Address): Promise<{ sold: number; slashed: number; confirmed: number; unconfirmed: number }> {
  const r = (await publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "sellerRep", args: [address] })) as [number, number, number, number];
  return { sold: Number(r[0]), slashed: Number(r[1]), confirmed: Number(r[2]), unconfirmed: Number(r[3]) };
}

export async function currentPrice(id: bigint): Promise<bigint> {
  return (await publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "currentPrice", args: [id] })) as bigint;
}
export async function priceCap(seller: Address): Promise<bigint> {
  return (await publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "priceCap", args: [seller] })) as bigint;
}
export async function minStake(reservePrice: bigint): Promise<bigint> {
  return (await publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "minStake", args: [reservePrice] })) as bigint;
}
export async function challengeBondFor(price: bigint): Promise<bigint> {
  return (await publicClient().readContract({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: "challengeBondFor", args: [price] })) as bigint;
}

/** First occurrence of a per-listing event, scanning from the deploy block. */
export async function firstEvent(eventName: "Listed" | "Delivered" | "Disclosed", id: bigint): Promise<any> {
  const events = await logsClient().getContractEvents({ address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, eventName, args: { id }, fromBlock: DEPLOYED_AT_BLOCK });
  return events[0] as any;
}

/** Each of these events fires at most once per listing and never changes, so once
 *  seen it is cached for the life of the process. Only misses hit the RPC. */
const eventCache = new Map<string, any>();
async function cachedEvent(eventName: "Listed" | "Delivered" | "Disclosed", id: bigint): Promise<any> {
  const k = `${eventName}:${id}`;
  if (eventCache.has(k)) return eventCache.get(k);
  const ev = await firstEvent(eventName, id);
  if (ev) eventCache.set(k, ev);
  return ev;
}

/** Pull the sealed blob and the wrapped key back out of the event log. Pass the
 *  listing's status to skip scanning for events it cannot have emitted yet. */
export async function listingLogs(id: bigint, status?: Status) {
  const mayHaveDelivered = status === undefined || status >= Status.Delivered;
  const mayHaveDisclosed = status === undefined || status === Status.Disclosed;
  const [listed, delivered, disclosed] = await Promise.all([
    cachedEvent("Listed", id),
    mayHaveDelivered ? cachedEvent("Delivered", id) : undefined,
    mayHaveDisclosed ? cachedEvent("Disclosed", id) : undefined,
  ]);
  return { listed, delivered, disclosed };
}

export async function waitFor(hash: Hex) {
  return publicClient().waitForTransactionReceipt({ hash, timeout: 120_000 });
}
