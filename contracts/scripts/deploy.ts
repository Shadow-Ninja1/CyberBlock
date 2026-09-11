import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getAddress, isAddress } from "viem";

/**
 * Deploys CyberBlock and writes the address + ABI where the web app and the
 * agents can pick them up.
 */
async function main() {
  const oracle = process.env.ORACLE_ADDRESS;
  if (!oracle || !isAddress(oracle)) {
    throw new Error("ORACLE_ADDRESS must be set to the oracle's address in .env");
  }

  const [deployer] = await hre.viem.getWalletClients();
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const balance = await publicClient.getBalance({ address: deployer.account.address });

  console.log(`network   chainId=${chainId}`);
  console.log(`deployer  ${deployer.account.address}  (${Number(balance) / 1e18} ETH)`);
  console.log(`oracle    ${getAddress(oracle)}`);

  if (balance === 0n) {
    throw new Error("Deployer has no balance. Fund it from a Base Sepolia faucet first.");
  }

  const bazaar = await hre.viem.deployContract("CyberBlock", [getAddress(oracle)]);
  console.log(`\ndeployed  ${bazaar.address}`);

  const blockNumber = await publicClient.getBlockNumber();
  console.log(`block     ${blockNumber}`);
  if (chainId === 84532) {
    console.log(`explorer  https://sepolia.basescan.org/address/${bazaar.address}`);
  }

  // On a testnet, top up the seller and buyer from the deployer so the demo only
  // needs ONE funded address. Configured accounts are [deployer, seller, buyer].
  if (chainId !== 31337) {
    const wallets = await hre.viem.getWalletClients();
    const topUp = 3_000_000_000_000_000n; // 0.003 ETH each — plenty for the demo
    for (const w of wallets.slice(1, 3)) {
      const bal = await publicClient.getBalance({ address: w.account.address });
      if (bal >= topUp) {
        console.log(`fund      ${w.account.address} already has ${Number(bal) / 1e18} ETH`);
        continue;
      }
      try {
        const hash = await deployer.sendTransaction({ to: w.account.address, value: topUp });
        await publicClient.waitForTransactionReceipt({ hash });
        console.log(`fund      ${w.account.address} += ${Number(topUp) / 1e18} ETH`);
      } catch (e) {
        console.warn(`fund      could not top up ${w.account.address}: ${(e as Error).message}`);
      }
    }
  }

  // Publish the ABI + address for the web app and CLI agents.
  const artifact = await hre.artifacts.readArtifact("CyberBlock");
  const out = path.resolve(__dirname, "../../lib/contract.json");
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        address: bazaar.address,
        chainId,
        oracle: getAddress(oracle),
        deployedAtBlock: Number(blockNumber),
        abi: artifact.abi,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote     ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
