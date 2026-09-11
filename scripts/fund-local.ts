/** Funds the oracle/seller/buyer accounts on a local Hardhat node. Local only. */
import "dotenv/config";
import { createWalletClient, http, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

const RPC = process.env.LOCAL_RPC_URL ?? "http://127.0.0.1:8545";
const ACCT0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

async function main() {
  const funder = createWalletClient({ account: privateKeyToAccount(ACCT0), chain: hardhat, transport: http(RPC) });
  for (const r of ["ORACLE", "SELLER", "BUYER", "ARBITER"] as const) {
    const a = privateKeyToAccount(process.env[`${r}_PRIVATE_KEY`] as Hex).address;
    const h = await funder.sendTransaction({ to: a, value: parseEther("100") });
    console.log(r, a, h.slice(0, 12));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
