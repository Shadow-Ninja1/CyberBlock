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
import type { AttestationStruct } from "./types";

export const CONTRACT_ABI = contract.abi;
export const CHAIN_ID = contract.chainId as number;
export const CONTRACT_ADDRESS = getAddress(contract.address) as Address;
export const ORACLE_ADDRESS = getAddress(contract.oracle) as Address;
export const DEPLOYED_AT_BLOCK = BigInt(contract.deployedAtBlock ?? 0);

export const chain = CHAIN_ID === 84532 ? baseSepolia : hardhat;

export const EXPLORER =
  CHAIN_ID === 84532 ? "https://sepolia.basescan.org" : "http://localhost:8545";

export function txUrl(hash: Hex): string {
  return `${EXPLORER}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  return `${EXPLORER}/address/${address}`;
}

function rpcUrl(): string {
  // A local deployment always talks to the local node, regardless of any testnet
  // RPC left in the environment.
  if (CHAIN_ID === 31337) return process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545";
  return process.env.NEXT_PUBLIC_RPC_URL ?? process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
}

let cachedPublic: PublicClient | null = null;

export function publicClient(): PublicClient {
  if (!cachedPublic) {
    cachedPublic = createPublicClient({ chain, transport: http(rpcUrl()) }) as PublicClient;
  }
  return cachedPublic;
}

export type Role = "ORACLE" | "SELLER" | "BUYER";

export function privateKeyFor(role: Role): Hex {
  const key = process.env[`${role}_PRIVATE_KEY`];
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`${role}_PRIVATE_KEY is missing or malformed in the environment`);
  }
  return key as Hex;
}

export function accountFor(role: Role) {
  return privateKeyToAccount(privateKeyFor(role));
}

export function walletFor(role: Role): WalletClient {
  return createWalletClient({
    account: accountFor(role),
    chain,
    transport: http(rpcUrl()),
  });
}

// ------------------------------------------------------------------ EIP-712

export const EIP712_DOMAIN = {
  name: "CyberBlock",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: CONTRACT_ADDRESS,
} as const;

export const EIP712_TYPES = {
  Attestation: [
    { name: "artifactHash", type: "bytes32" },
    { name: "contentHash", type: "bytes32" },
    { name: "keyHash", type: "bytes32" },
    { name: "detectorHash", type: "bytes32" },
    { name: "severity", type: "uint8" },
    { name: "vulnClass", type: "uint8" },
    { name: "novel", type: "bool" },
    { name: "installBase", type: "uint32" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export async function signAttestation(att: AttestationStruct): Promise<Hex> {
  return accountFor("ORACLE").signTypedData({
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "Attestation",
    message: att,
  });
}

// ---------------------------------------------------------------- read paths

export interface OnChainListing {
  id: bigint;
  seller: Address;
  buyer: Address;
  price: bigint;
  stake: bigint;
  disputeBond: bigint;
  embargo: bigint;
  soldAt: bigint;
  deliveredAt: bigint;
  status: number;
  paidOut: boolean;
  att: AttestationStruct;
}

export async function readListing(id: bigint): Promise<OnChainListing> {
  const l = (await publicClient().readContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "getListing",
    args: [id],
  })) as any;
  return { id, ...l };
}

export async function nextListingId(): Promise<bigint> {
  return (await publicClient().readContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "nextListingId",
  })) as bigint;
}

export async function allListings(): Promise<OnChainListing[]> {
  const next = await nextListingId();
  const ids = Array.from({ length: Number(next) - 1 }, (_, i) => BigInt(i + 1));
  return Promise.all(ids.map(readListing));
}

export async function sellerRep(address: Address): Promise<{ sold: number; slashed: number }> {
  const r = (await publicClient().readContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "sellerRep",
    args: [address],
  })) as [number, number];
  return { sold: Number(r[0]), slashed: Number(r[1]) };
}

export async function fairPrice(att: AttestationStruct, embargo: bigint): Promise<bigint> {
  return (await publicClient().readContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "fairPrice",
    args: [att, embargo],
  })) as bigint;
}

export async function minStake(price: bigint): Promise<bigint> {
  return (await publicClient().readContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "minStake",
    args: [price],
  })) as bigint;
}

export async function disputeBondFor(price: bigint): Promise<bigint> {
  return (await publicClient().readContract({
    address: CONTRACT_ADDRESS,
    abi: CONTRACT_ABI,
    functionName: "disputeBondFor",
    args: [price],
  })) as bigint;
}

/** Pull the sealed blob and the wrapped key back out of the event log. */
export async function listingLogs(id: bigint) {
  const client = publicClient();
  const [listed, delivered, disclosed] = await Promise.all([
    client.getContractEvents({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      eventName: "Listed",
      args: { id },
      fromBlock: DEPLOYED_AT_BLOCK,
    }),
    client.getContractEvents({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      eventName: "Delivered",
      args: { id },
      fromBlock: DEPLOYED_AT_BLOCK,
    }),
    client.getContractEvents({
      address: CONTRACT_ADDRESS,
      abi: CONTRACT_ABI,
      eventName: "Disclosed",
      args: { id },
      fromBlock: DEPLOYED_AT_BLOCK,
    }),
  ]);
  return {
    listed: listed[0] as any,
    delivered: delivered[0] as any,
    disclosed: disclosed[0] as any,
  };
}

export async function waitFor(hash: Hex) {
  return publicClient().waitForTransactionReceipt({ hash, timeout: 120_000 });
}
