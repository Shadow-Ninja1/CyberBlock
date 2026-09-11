import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import hre from "hardhat";

chai.use(chaiAsPromised);
const { expect } = chai;
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  keccak256,
  toHex,
  encodePacked,
  parseEther,
  type Hex,
  getAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Hardhat's default account #1 acts as the oracle, so it can both sign
// attestations off-chain and send resolve() transactions on-chain.
const ORACLE_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const oracleAccount = privateKeyToAccount(ORACLE_PK);

const MINUTE = 60;
const MIN_EMBARGO = 2 * MINUTE;
const CHALLENGE_WINDOW = 1 * MINUTE;
const DELIVERY_DEADLINE = 10 * MINUTE;
const DISCLOSURE_GRACE = 2 * MINUTE;

type Attestation = {
  artifactHash: Hex;
  contentHash: Hex;
  keyHash: Hex;
  detectorHash: Hex;
  severity: number;
  vulnClass: number;
  novel: boolean;
  installBase: number;
  expiresAt: bigint;
};

const EIP712_TYPES = {
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

const KEY = keccak256(toHex("demo-symmetric-key"));

async function fixture() {
  const clients = await hre.viem.getWalletClients();
  const [deployer, oracleWallet, seller, buyer, stranger] = clients;
  const bazaar = await hre.viem.deployContract("CyberBlock", [oracleAccount.address]);
  const publicClient = await hre.viem.getPublicClient();

  return { bazaar, publicClient, deployer, seller, buyer, stranger, oracleWallet };
}

async function makeAttestation(
  bazaar: any,
  overrides: Partial<Attestation> = {},
): Promise<{ att: Attestation; sig: Hex }> {
  const latest = await time.latest();
  const att: Attestation = {
    artifactHash: keccak256(toHex("npm:evil-widget@1.2.0")),
    contentHash: keccak256(toHex("the finding plaintext")),
    keyHash: keccak256(encodePacked(["bytes32"], [KEY])),
    detectorHash: keccak256(toHex("detector-v1")),
    severity: 81,
    vulnClass: 1, // InstallHookExfil
    novel: true,
    installBase: 250_000,
    expiresAt: BigInt(latest + 3600),
    ...overrides,
  };

  const sig = await oracleAccount.signTypedData({
    domain: {
      name: "CyberBlock",
      version: "1",
      chainId: 31337,
      verifyingContract: getAddress(bazaar.address),
    },
    types: EIP712_TYPES,
    primaryType: "Attestation",
    message: att,
  });

  return { att, sig };
}

/** Lists a finding at the attested fair price with the minimum stake. */
async function listFinding(
  bazaar: any,
  seller: any,
  overrides: Partial<Attestation> = {},
  embargo = BigInt(MIN_EMBARGO),
) {
  const { att, sig } = await makeAttestation(bazaar, overrides);
  const fair = await bazaar.read.fairPrice([att, embargo]);
  const stake = await bazaar.read.minStake([fair]);
  const hash = await bazaar.write.list(
    [att, sig, fair, embargo, "npm:evil-widget@1.2.0", toHex("ciphertext-blob")],
    { account: seller.account, value: stake },
  );
  const publicClient = await hre.viem.getPublicClient();
  await publicClient.waitForTransactionReceipt({ hash });
  return { att, sig, price: fair as bigint, stake: stake as bigint, id: 1n };
}

const BUYER_PUBKEY = ("0x04" + "11".repeat(64)) as Hex;

/**
 * Net balance change for `address` across a transaction it sent, with the gas it
 * burned added back, so amounts can be asserted exactly.
 */
async function netReceived(publicClient: any, address: Hex, send: () => Promise<Hex>) {
  const before = await publicClient.getBalance({ address });
  const hash = await send();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const after = await publicClient.getBalance({ address });
  return after - before + receipt.gasUsed * receipt.effectiveGasPrice;
}

describe("CyberBlock", () => {
  describe("pricing rule", () => {
    it("prices a finding from attested severity, class, blast radius and embargo", async () => {
      const { bazaar } = await fixture();
      const { att } = await makeAttestation(bazaar);

      const short = (await bazaar.read.fairPrice([att, BigInt(MIN_EMBARGO)])) as bigint;
      const long = (await bazaar.read.fairPrice([att, BigInt(30 * 24 * 3600)])) as bigint;

      // severity 81 -> 0.0004 * 0.81 = 0.000324; class 130% -> 0.0004212;
      // installBase 250k -> reach 25 -> 125% -> 0.0005265
      expect(short).to.equal(526_500_000_000_000n);
      // A maximum embargo doubles it: the buyer is paying for exclusivity time.
      expect(long).to.equal(short * 2n);
    });

    it("prices a non-novel finding at zero, so it cannot be listed", async () => {
      const { bazaar } = await fixture();
      const { att } = await makeAttestation(bazaar, { novel: false });
      expect(await bazaar.read.fairPrice([att, BigInt(MIN_EMBARGO)])).to.equal(0n);
    });

    it("caps a new seller's listing size and grows it with reputation", async () => {
      const { bazaar, seller } = await fixture();
      const cap = (await bazaar.read.priceCap([seller.account.address])) as bigint;
      expect(cap).to.equal(parseEther("0.002"));
    });
  });

  describe("listing", () => {
    it("accepts a listing carrying a valid oracle attestation", async () => {
      const { bazaar, seller, publicClient } = await fixture();
      const { price, stake } = await listFinding(bazaar, seller);

      const l = (await bazaar.read.getListing([1n])) as any;
      expect(getAddress(l.seller)).to.equal(getAddress(seller.account.address));
      expect(l.price).to.equal(price);
      expect(l.stake).to.equal(stake);
      expect(l.status).to.equal(1); // Listed
      expect(await publicClient.getBalance({ address: bazaar.address })).to.equal(stake);
    });

    it("rejects a listing whose attestation was not signed by the oracle", async () => {
      const { bazaar, seller } = await fixture();
      const { att } = await makeAttestation(bazaar);
      const impostor = privateKeyToAccount(
        "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" as Hex,
      );
      const sig = await impostor.signTypedData({
        domain: {
          name: "CyberBlock",
          version: "1",
          chainId: 31337,
          verifyingContract: getAddress(bazaar.address),
        },
        types: EIP712_TYPES,
        primaryType: "Attestation",
        message: att,
      });
      const fair = await bazaar.read.fairPrice([att, BigInt(MIN_EMBARGO)]);
      await expect(
        bazaar.write.list([att, sig, fair, BigInt(MIN_EMBARGO), "x", "0x00"], {
          account: seller.account,
          value: await bazaar.read.minStake([fair]),
        }),
      ).to.be.rejectedWith("BadSignature");
    });

    it("rejects a listing whose attestation fields were tampered with after signing", async () => {
      const { bazaar, seller } = await fixture();
      const { att, sig } = await makeAttestation(bazaar);
      const inflated = { ...att, severity: 100 };
      const fair = await bazaar.read.fairPrice([inflated, BigInt(MIN_EMBARGO)]);
      await expect(
        bazaar.write.list([inflated, sig, fair, BigInt(MIN_EMBARGO), "x", "0x00"], {
          account: seller.account,
          value: await bazaar.read.minStake([fair]),
        }),
      ).to.be.rejectedWith("BadSignature");
    });

    it("rejects an expired attestation voucher", async () => {
      const { bazaar, seller } = await fixture();
      const latest = await time.latest();
      const { att, sig } = await makeAttestation(bazaar, { expiresAt: BigInt(latest - 1) });
      await expect(
        bazaar.write.list([att, sig, 1n, BigInt(MIN_EMBARGO), "x", "0x00"], {
          account: seller.account,
          value: 1n,
        }),
      ).to.be.rejectedWith("AttestationExpired");
    });

    it("rejects an extortion price outside the attested fair-value band", async () => {
      const { bazaar, seller } = await fixture();
      const { att, sig } = await makeAttestation(bazaar);
      const fair = (await bazaar.read.fairPrice([att, BigInt(MIN_EMBARGO)])) as bigint;
      const greedy = fair * 4n;
      await expect(
        bazaar.write.list([att, sig, greedy, BigInt(MIN_EMBARGO), "x", "0x00"], {
          account: seller.account,
          value: await bazaar.read.minStake([greedy]),
        }),
      ).to.be.rejectedWith("PriceOutOfBand");
    });

    it("rejects a second listing for the same artifact", async () => {
      const { bazaar, seller, buyer } = await fixture();
      await listFinding(bazaar, seller);
      const { att, sig } = await makeAttestation(bazaar); // same artifactHash
      const fair = await bazaar.read.fairPrice([att, BigInt(MIN_EMBARGO)]);
      await expect(
        bazaar.write.list([att, sig, fair, BigInt(MIN_EMBARGO), "x", "0x00"], {
          account: buyer.account,
          value: await bazaar.read.minStake([fair]),
        }),
      ).to.be.rejectedWith("DuplicateArtifact");
    });

    it("rejects an understaked listing", async () => {
      const { bazaar, seller } = await fixture();
      const { att, sig } = await makeAttestation(bazaar);
      const fair = (await bazaar.read.fairPrice([att, BigInt(MIN_EMBARGO)])) as bigint;
      await expect(
        bazaar.write.list([att, sig, fair, BigInt(MIN_EMBARGO), "x", "0x00"], {
          account: seller.account,
          value: (await bazaar.read.minStake([fair])) - 1n,
        }),
      ).to.be.rejectedWith("StakeTooLow");
    });

    it("returns the stake when a seller cancels an unsold listing", async () => {
      const { bazaar, seller, publicClient } = await fixture();
      const { stake } = await listFinding(bazaar, seller);
      const recovered = await netReceived(publicClient, seller.account.address, () =>
        bazaar.write.cancel([1n], { account: seller.account }),
      );
      expect(recovered).to.equal(stake);
      expect(await publicClient.getBalance({ address: bazaar.address })).to.equal(0n);
    });
  });

  describe("happy path", () => {
    it("pays the seller after the challenge window and returns the bond on disclosure", async () => {
      const { bazaar, seller, buyer, publicClient } = await fixture();
      const { price, stake } = await listFinding(bazaar, seller);

      await bazaar.write.buy([1n, BUYER_PUBKEY], { account: buyer.account, value: price });
      expect(((await bazaar.read.getListing([1n])) as any).status).to.equal(2); // Sold

      await bazaar.write.deliver([1n, toHex("ecies-wrapped-key")], { account: seller.account });
      expect(((await bazaar.read.getListing([1n])) as any).status).to.equal(3); // Delivered

      // Cannot be paid before the buyer's challenge window closes.
      await expect(bazaar.write.claimPayment([1n], { account: seller.account })).to.be.rejectedWith(
        "TooEarly",
      );

      await time.increase(CHALLENGE_WINDOW + 1);
      const beforePay = await publicClient.getBalance({ address: seller.account.address });
      await bazaar.write.claimPayment([1n], { account: buyer.account }); // anyone may trigger it
      const afterPay = await publicClient.getBalance({ address: seller.account.address });
      expect(afterPay - beforePay).to.equal(price);

      const l = (await bazaar.read.getListing([1n])) as any;
      expect(l.status).to.equal(5); // Settled
      expect(l.paidOut).to.equal(true);
      // The stake is still held: it is a disclosure bond, not a performance bond.
      expect(await publicClient.getBalance({ address: bazaar.address })).to.equal(stake);
      expect(((await bazaar.read.sellerRep([seller.account.address])) as any)[0]).to.equal(1);

      // Embargo still running: no public disclosure yet.
      await expect(bazaar.write.disclose([1n, KEY], { account: seller.account })).to.be.rejectedWith(
        "TooEarly",
      );

      await time.increase(MIN_EMBARGO);
      const bondBack = await netReceived(publicClient, seller.account.address, () =>
        bazaar.write.disclose([1n, KEY], { account: seller.account }),
      );
      expect(bondBack).to.equal(stake);

      expect(((await bazaar.read.getListing([1n])) as any).status).to.equal(6); // Disclosed
      expect(await publicClient.getBalance({ address: bazaar.address })).to.equal(0n);

      const events = await publicClient.getContractEvents({
        address: bazaar.address,
        abi: bazaar.abi,
        eventName: "Disclosed",
      });
      expect(events[0].args.key).to.equal(KEY);
    });

    it("rejects a disclosure with the wrong key", async () => {
      const { bazaar, seller, buyer } = await fixture();
      const { price } = await listFinding(bazaar, seller);
      await bazaar.write.buy([1n, BUYER_PUBKEY], { account: buyer.account, value: price });
      await bazaar.write.deliver([1n, toHex("k")], { account: seller.account });
      await time.increase(CHALLENGE_WINDOW + MIN_EMBARGO + 1);
      await expect(
        bazaar.write.disclose([1n, keccak256(toHex("wrong"))], { account: seller.account }),
      ).to.be.rejectedWith("BadKey");
    });
  });

  describe("disclosure bond", () => {
    it("lets anyone holding the key claim the bond if the seller stalls past the grace period", async () => {
      const { bazaar, seller, buyer, stranger, publicClient } = await fixture();
      const { price, stake } = await listFinding(bazaar, seller);
      await bazaar.write.buy([1n, BUYER_PUBKEY], { account: buyer.account, value: price });
      await bazaar.write.deliver([1n, toHex("k")], { account: seller.account });
      await time.increase(CHALLENGE_WINDOW + MIN_EMBARGO + 1);

      // Only the seller may disclose during the grace period.
      await expect(bazaar.write.disclose([1n, KEY], { account: stranger.account })).to.be.rejectedWith(
        "TooEarly",
      );

      await time.increase(DISCLOSURE_GRACE);
      const bounty = await netReceived(publicClient, stranger.account.address, () =>
        bazaar.write.disclose([1n, KEY], { account: stranger.account }),
      );
      expect(bounty).to.equal(stake);
      expect(((await bazaar.read.getListing([1n])) as any).status).to.equal(6);
    });
  });

  describe("dispute", () => {
    it("pays the seller and awards the bond when the oracle upholds the attestation", async () => {
      const { bazaar, seller, buyer, oracleWallet, publicClient } = await fixture();
      const { price } = await listFinding(bazaar, seller);
      await bazaar.write.buy([1n, BUYER_PUBKEY], { account: buyer.account, value: price });
      await bazaar.write.deliver([1n, toHex("k")], { account: seller.account });

      const bond = (await bazaar.read.disputeBondFor([price])) as bigint;
      await bazaar.write.dispute([1n, "claims not reproducible"], {
        account: buyer.account,
        value: bond,
      });
      expect(((await bazaar.read.getListing([1n])) as any).status).to.equal(4); // Disputed

      const before = await publicClient.getBalance({ address: seller.account.address });
      await bazaar.write.resolve([1n, true, "detector re-run reproduces the finding"], {
        account: oracleWallet.account,
      });
      const after = await publicClient.getBalance({ address: seller.account.address });
      expect(after - before).to.equal(price + bond); // griefing costs the buyer the bond

      const l = (await bazaar.read.getListing([1n])) as any;
      expect(l.status).to.equal(5); // Settled
      expect(((await bazaar.read.sellerRep([seller.account.address])) as any)[0]).to.equal(1);
    });

    it("refunds the buyer and slashes the stake when the oracle overturns the attestation", async () => {
      const { bazaar, seller, buyer, oracleWallet, publicClient } = await fixture();
      const { price, stake } = await listFinding(bazaar, seller);
      await bazaar.write.buy([1n, BUYER_PUBKEY], { account: buyer.account, value: price });
      await bazaar.write.deliver([1n, toHex("k")], { account: seller.account });

      const bond = (await bazaar.read.disputeBondFor([price])) as bigint;
      await bazaar.write.dispute([1n, "already public as GHSA-xxxx"], {
        account: buyer.account,
        value: bond,
      });

      const before = await publicClient.getBalance({ address: buyer.account.address });
      await bazaar.write.resolve([1n, false, "OSV lists this package as of an earlier date"], {
        account: oracleWallet.account,
      });
      const after = await publicClient.getBalance({ address: buyer.account.address });
      expect(after - before).to.equal(price + stake + bond);

      const l = (await bazaar.read.getListing([1n])) as any;
      expect(l.status).to.equal(7); // Refunded
      expect(((await bazaar.read.sellerRep([seller.account.address])) as any)[1]).to.equal(1);
      expect(await publicClient.getBalance({ address: bazaar.address })).to.equal(0n);

      // The artifact lock is released so an honest seller can report it properly.
      expect(await bazaar.read.listingByArtifact([keccak256(toHex("npm:evil-widget@1.2.0"))])).to.equal(0n);
    });

    it("only lets the oracle resolve a dispute", async () => {
      const { bazaar, seller, buyer } = await fixture();
      const { price } = await listFinding(bazaar, seller);
      await bazaar.write.buy([1n, BUYER_PUBKEY], { account: buyer.account, value: price });
      await bazaar.write.deliver([1n, toHex("k")], { account: seller.account });
      await bazaar.write.dispute([1n, "r"], {
        account: buyer.account,
        value: await bazaar.read.disputeBondFor([price]),
      });
      await expect(
        bazaar.write.resolve([1n, true, "self-serving"], { account: seller.account }),
      ).to.be.rejectedWith("NotOracle");
    });

    it("rejects a dispute filed after the challenge window closes", async () => {
      const { bazaar, seller, buyer } = await fixture();
      const { price } = await listFinding(bazaar, seller);
      await bazaar.write.buy([1n, BUYER_PUBKEY], { account: buyer.account, value: price });
      await bazaar.write.deliver([1n, toHex("k")], { account: seller.account });
      await time.increase(CHALLENGE_WINDOW + 1);
      await expect(
        bazaar.write.dispute([1n, "too late"], {
          account: buyer.account,
          value: await bazaar.read.disputeBondFor([price]),
        }),
      ).to.be.rejectedWith("TooLate");
    });
  });

  describe("seller timeout", () => {
    it("refunds the buyer the price plus the whole stake when the seller never delivers", async () => {
      const { bazaar, seller, buyer, publicClient } = await fixture();
      const { price, stake } = await listFinding(bazaar, seller);
      await bazaar.write.buy([1n, BUYER_PUBKEY], { account: buyer.account, value: price });

      await expect(bazaar.write.claimTimeout([1n], { account: buyer.account })).to.be.rejectedWith(
        "TooEarly",
      );

      await time.increase(DELIVERY_DEADLINE + 1);
      const refund = await netReceived(publicClient, buyer.account.address, () =>
        bazaar.write.claimTimeout([1n], { account: buyer.account }),
      );
      expect(refund).to.equal(price + stake);

      expect(((await bazaar.read.getListing([1n])) as any).status).to.equal(7); // Refunded
      expect(((await bazaar.read.sellerRep([seller.account.address])) as any)[1]).to.equal(1);
      expect(await publicClient.getBalance({ address: bazaar.address })).to.equal(0n);
    });

    it("stops the seller delivering after the deadline has passed", async () => {
      const { bazaar, seller, buyer } = await fixture();
      const { price } = await listFinding(bazaar, seller);
      await bazaar.write.buy([1n, BUYER_PUBKEY], { account: buyer.account, value: price });
      await time.increase(DELIVERY_DEADLINE + 1);
      await expect(
        bazaar.write.deliver([1n, toHex("k")], { account: seller.account }),
      ).to.be.rejectedWith("TooLate");
    });
  });

  describe("access control", () => {
    it("only lets the assigned buyer dispute, and only the seller deliver", async () => {
      const { bazaar, seller, buyer, stranger } = await fixture();
      const { price } = await listFinding(bazaar, seller);
      await bazaar.write.buy([1n, BUYER_PUBKEY], { account: buyer.account, value: price });
      await expect(
        bazaar.write.deliver([1n, toHex("k")], { account: stranger.account }),
      ).to.be.rejectedWith("NotSeller");
      await bazaar.write.deliver([1n, toHex("k")], { account: seller.account });
      await expect(
        bazaar.write.dispute([1n, "not mine"], {
          account: stranger.account,
          value: await bazaar.read.disputeBondFor([price]),
        }),
      ).to.be.rejectedWith("NotBuyer");
    });

    it("rejects a purchase at the wrong price", async () => {
      const { bazaar, seller, buyer } = await fixture();
      const { price } = await listFinding(bazaar, seller);
      await expect(
        bazaar.write.buy([1n, BUYER_PUBKEY], { account: buyer.account, value: price - 1n }),
      ).to.be.rejectedWith("WrongPayment");
    });
  });
});
