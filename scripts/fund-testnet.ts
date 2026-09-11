/**
 * Tops up the three demo agents (seller, buyer, arbiter) from the deployer/oracle
 * account so the built-in walkthrough can run end to end on Base Sepolia — including
 * the second listing, whose auction opens at the seller's grown reputation cap, and
 * the arbiter's resolve transaction on the challenge path.
 *
 *   npx tsx scripts/fund-testnet.ts            # top each up to the default target
 *   TARGET_ETH=0.02 npx tsx scripts/fund-testnet.ts
 *
 * Only tops up an account below the target, and only by the shortfall, so it is safe
 * to re-run. The deployer must hold enough test ETH to cover the shortfalls + gas.
 */
import "dotenv/config";
import { createWalletClient, http, formatEther, parseEther, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, publicClient, CHAIN_ID } from "../lib/chain";

const TARGET = parseEther(process.env.TARGET_ETH ?? "0.015");

function key(name: string): Hex {
  const k = process.env[name];
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} missing or malformed in .env`);
  return k as Hex;
}

async function main() {
  if (CHAIN_ID === 31337) throw new Error("This script is for a testnet; use scripts/fund-local.ts on a local node.");
  const funderKey = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.ORACLE_PRIVATE_KEY;
  if (!funderKey) throw new Error("DEPLOYER_PRIVATE_KEY (or ORACLE_PRIVATE_KEY) must be set");
  const funder = createWalletClient({ account: privateKeyToAccount(funderKey as Hex), chain, transport: http() });
  const pc = publicClient();

  const targets = [
    ["seller", key("SELLER_PRIVATE_KEY")],
    ["buyer", key("BUYER_PRIVATE_KEY")],
    ["arbiter", key("ARBITER_PRIVATE_KEY")],
  ] as const;

  console.log(`funder ${funder.account.address}  target ${formatEther(TARGET)} ETH each\n`);
  for (const [name, pk] of targets) {
    const address = privateKeyToAccount(pk).address;
    const bal = await pc.getBalance({ address });
    if (bal >= TARGET) {
      console.log(`skip  ${name.padEnd(7)} ${address}  has ${formatEther(bal)} ETH`);
      continue;
    }
    const need = TARGET - bal;
    const hash = await funder.sendTransaction({ to: address, value: need, account: funder.account, chain });
    await pc.waitForTransactionReceipt({ hash });
    console.log(`fund  ${name.padEnd(7)} ${address}  += ${formatEther(need)} ETH  ->  ${formatEther(TARGET)} ETH`);
  }
  console.log(`\ndeployer/oracle now holds ${formatEther(await pc.getBalance({ address: funder.account.address }))} ETH`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
