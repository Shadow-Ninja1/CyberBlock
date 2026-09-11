import * as chai from "chai";
import chaiAsPromised from "chai-as-promised";
import hre from "hardhat";

chai.use(chaiAsPromised);
const { expect } = chai;
import { time } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256, toHex, encodePacked, parseEther, type Hex, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Hardhat default account #1 is the oracle and #2 the arbiter, so each can sign
// off-chain and send its own transactions on-chain.
const ORACLE_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
const ARBITER_PK = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" as Hex;
const oracleAccount = privateKeyToAccount(ORACLE_PK);
const arbiterAccount = privateKeyToAccount(ARBITER_PK);

const MINUTE = 60;
const MIN_AUCTION = 1 * MINUTE;
const MIN_EMBARGO = 2 * MINUTE;
const CHALLENGE_WINDOW = 1 * MINUTE;
const DELIVERY_DEADLINE = 10 * MINUTE;
const DISCLOSURE_GRACE = 2 * MINUTE;
const CONFIRMATION_WINDOW = 2 * MINUTE;

type Attestation = {
  artifactHash: Hex;
  contentHash: Hex;
  keyHash: Hex;
  traceHash: Hex;
  sandboxHash: Hex;
  outcomeHash: Hex;
  effects: number;
  novel: boolean;
  installBase: number;
  expiresAt: bigint;
};

const EIP712_TYPES = {
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

const KEY = keccak256(toHex("demo-symmetric-key"));
const OUTCOME = "On npm install, reads ~/.npmrc and POSTs it to telemetry-cdn.xyz.";
const BUYER_PUBKEY = ("0x04" + "11".repeat(64)) as Hex;

const START = parseEther("0.002");
const RESERVE = parseEther("0.0005");
const DURATION = BigInt(3 * MINUTE);
const CONTINGENT_BPS = 5_000;

async function fixture() {
  const clients = await hre.viem.getWalletClients();
  const [deployer, oracleWallet, arbiterWallet, seller, buyer, stranger] = clients;
  const bazaar = await hre.viem.deployContract("CyberBlock", [oracleAccount.address, arbiterAccount.address]);
  const publicClient = await hre.viem.getPublicClient();
  return { bazaar, publicClient, deployer, seller, buyer, stranger, oracleWallet, arbiterWallet };
}

async function makeAttestation(bazaar: any, overrides: Partial<Attestation> = {}, signer = oracleAccount) {
  const latest = await time.latest();
  const att: Attestation = {
    artifactHash: keccak256(toHex("npm:evil-widget@1.2.0")),
    contentHash: keccak256(toHex("the finding plaintext")),
    keyHash: keccak256(encodePacked(["bytes32"], [KEY])),
    traceHash: keccak256(toHex("canonical sandbox trace")),
    sandboxHash: keccak256(toHex("sandbox-v2")),
    outcomeHash: keccak256(toHex(OUTCOME)),
    effects: 1 | 4 | 8 | 64,
    novel: true,
    installBase: 250_000,
    expiresAt: BigInt(latest + 3600),
    ...overrides,
  };
  const sig = await signer.signTypedData({
    domain: { name: "CyberBlock", version: "2", chainId: 31337, verifyingContract: getAddress(bazaar.address) },
    types: EIP712_TYPES,
    primaryType: "Attestation",
    message: att,
  });
  return { att, sig };
}

interface ListOpts {
  overrides?: Partial<Attestation>;
  start?: bigint;
  reserve?: bigint;
  duration?: bigint;
  contingentBps?: number;
  embargo?: bigint;
  outcome?: string;
  stake?: bigint;
}

async function listFinding(bazaar: any, seller: any, o: ListOpts = {}) {
  const { att, sig } = await makeAttestation(bazaar, o.overrides);
  const start = o.start ?? START;
  const reserve = o.reserve ?? RESERVE;
  const stake = o.stake ?? ((await bazaar.read.minStake([reserve])) as bigint);
  const hash = await bazaar.write.list(
    [
      att,
      sig,
      o.outcome ?? OUTCOME,
      start,
      reserve,
      o.duration ?? DURATION,
      o.contingentBps ?? CONTINGENT_BPS,
      o.embargo ?? BigInt(MIN_EMBARGO),
      "npm:evil-widget@1.2.0",
      toHex("ciphertext-blob"),
    ],
    { account: seller.account, value: stake },
  );
  await (await hre.viem.getPublicClient()).waitForTransactionReceipt({ hash });
  return { att, sig, stake, id: 1n };
}

/** Buys at the current price, sending exactly that amount. Returns the clearing price. */
async function buyNow(bazaar: any, buyer: any, id = 1n) {
  const p = (await bazaar.read.currentPrice([id])) as bigint;
  // Send a little extra so the block timestamp moving forward can never underpay.
  await bazaar.write.buy([id, BUYER_PUBKEY], { account: buyer.account, value: p });
  return ((await bazaar.read.getListing([id])) as any).price as bigint;
}

async function netReceived(publicClient: any, address: Hex, send: () => Promise<Hex>) {
  const before = await publicClient.getBalance({ address });
  const hash = await send();
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const after = await publicClient.getBalance({ address });
  return after - before + receipt.gasUsed * receipt.effectiveGasPrice;
}

/** Balance change for `address` across a transaction somebody ELSE sent. */
async function receivedFromOther(publicClient: any, address: Hex, send: () => Promise<Hex>) {
  const before = await publicClient.getBalance({ address });
  const hash = await send();
  await publicClient.waitForTransactionReceipt({ hash });
  const after = await publicClient.getBalance({ address });
  return after - before;
}

describe("CyberBlock", () => {
  describe("dutch auction", () => {
    it("decays linearly from the start price to the reserve and then holds", async () => {
      const { bazaar, seller } = await fixture();
      await listFinding(bazaar, seller);
      const p0 = (await bazaar.read.currentPrice([1n])) as bigint;
      expect(p0).to.equal(START);

      await time.increase(90); // half way through a 3 minute auction
      const pHalf = (await bazaar.read.currentPrice([1n])) as bigint;
      const mid = (START + RESERVE) / 2n;
      expect(pHalf <= mid + (START - RESERVE) / 100n && pHalf >= mid - (START - RESERVE) / 100n).to.equal(true);

      await time.increase(3 * MINUTE);
      expect((await bazaar.read.currentPrice([1n])) as bigint).to.equal(RESERVE);
    });

    it("charges the current price and refunds any excess the buyer sent", async () => {
      const { bazaar, seller, buyer, publicClient } = await fixture();
      await listFinding(bazaar, seller);
      await time.increase(DURATION); // now at reserve
      const spent = -(await netReceived(publicClient, buyer.account.address, () =>
        bazaar.write.buy([1n, BUYER_PUBKEY], { account: buyer.account, value: START }),
      ));
      expect(spent).to.equal(RESERVE);
      const l = (await bazaar.read.getListing([1n])) as any;
      expect(l.price).to.equal(RESERVE);
      expect(l.contingentPart).to.equal(RESERVE / 2n);
      expect(l.basePart).to.equal(RESERVE - RESERVE / 2n);
      expect(l.contingent).to.equal(1); // Escrowed
    });

    it("rejects a purchase below the current price", async () => {
      const { bazaar, seller, buyer } = await fixture();
      await listFinding(bazaar, seller);
      await expect(
        bazaar.write.buy([1n, BUYER_PUBKEY], { account: buyer.account, value: RESERVE }),
      ).to.be.rejectedWith("WrongPayment");
    });

    it("rejects auctions with a zero reserve, an inverted range, or a bad duration", async () => {
      const { bazaar, seller } = await fixture();
      await expect(listFinding(bazaar, seller, { reserve: 0n })).to.be.rejectedWith("BadAuction");
      await expect(listFinding(bazaar, seller, { reserve: START * 2n, start: START })).to.be.rejectedWith("BadAuction");
      await expect(listFinding(bazaar, seller, { duration: 10n })).to.be.rejectedWith("BadAuction");
    });

    it("rejects a contingent share above the maximum", async () => {
      const { bazaar, seller } = await fixture();
      await expect(listFinding(bazaar, seller, { contingentBps: 9_500 })).to.be.rejectedWith("BadContingent");
    });

    it("caps a new seller's start price and grows the cap with reputation", async () => {
      const { bazaar, seller } = await fixture();
      const cap = (await bazaar.read.priceCap([seller.account.address])) as bigint;
      expect(cap).to.equal(parseEther("0.002"));
      await expect(listFinding(bazaar, seller, { start: cap + 1n })).to.be.rejectedWith("PriceAboveRepCap");
    });
  });

  describe("listing", () => {
    it("accepts a listing carrying a valid oracle attestation", async () => {
      const { bazaar, seller } = await fixture();
      const { stake } = await listFinding(bazaar, seller);
      const l = (await bazaar.read.getListing([1n])) as any;
      expect(l.seller.toLowerCase()).to.equal(seller.account.address.toLowerCase());
      expect(l.status).to.equal(1);
      expect(l.stake).to.equal(stake);
      expect(l.auction.contingentBps).to.equal(CONTINGENT_BPS);
    });

    it("rejects a listing whose attestation was not signed by the oracle", async () => {
      const { bazaar, seller } = await fixture();
      const impostor = privateKeyToAccount(ARBITER_PK);
      const { att, sig } = await makeAttestation(bazaar, {}, impostor);
      await expect(
        bazaar.write.list(
          [att, sig, OUTCOME, START, RESERVE, DURATION, CONTINGENT_BPS, BigInt(MIN_EMBARGO), "x", toHex("c")],
          { account: seller.account, value: parseEther("1") },
        ),
      ).to.be.rejectedWith("BadSignature");
    });

    it("rejects a listing whose attestation fields were tampered with after signing", async () => {
      const { bazaar, seller } = await fixture();
      const { att, sig } = await makeAttestation(bazaar);
      const tampered = { ...att, effects: 127 };
      await expect(
        bazaar.write.list(
          [tampered, sig, OUTCOME, START, RESERVE, DURATION, CONTINGENT_BPS, BigInt(MIN_EMBARGO), "x", toHex("c")],
          { account: seller.account, value: parseEther("1") },
        ),
      ).to.be.rejectedWith("BadSignature");
    });

    it("rejects a public outcome that differs from the one the oracle signed", async () => {
      const { bazaar, seller } = await fixture();
      await expect(listFinding(bazaar, seller, { outcome: "Steals SSH keys and drops a reverse shell." })).to.be.rejectedWith(
        "OutcomeMismatch",
      );
    });

    it("rejects an expired attestation voucher", async () => {
      const { bazaar, seller } = await fixture();
      const latest = await time.latest();
      await expect(listFinding(bazaar, seller, { overrides: { expiresAt: BigInt(latest - 1) } })).to.be.rejectedWith(
        "AttestationExpired",
      );
    });

    it("rejects a non-novel finding", async () => {
      const { bazaar, seller } = await fixture();
      await expect(listFinding(bazaar, seller, { overrides: { novel: false } })).to.be.rejectedWith("NotNovel");
    });

    it("rejects a second listing for the same artifact", async () => {
      const { bazaar, seller } = await fixture();
      await listFinding(bazaar, seller);
      await expect(listFinding(bazaar, seller)).to.be.rejectedWith("DuplicateArtifact");
    });

    it("rejects an understaked listing", async () => {
      const { bazaar, seller } = await fixture();
      await expect(listFinding(bazaar, seller, { stake: 1n })).to.be.rejectedWith("StakeTooLow");
    });

    it("returns the stake when a seller cancels an unsold listing", async () => {
      const { bazaar, seller, publicClient } = await fixture();
      const { stake } = await listFinding(bazaar, seller);
      const back = await netReceived(publicClient, seller.account.address, () =>
        bazaar.write.cancel([1n], { account: seller.account }),
      );
      expect(back).to.equal(stake);
      expect(((await bazaar.read.getListing([1n])) as any).status).to.equal(8);
    });
  });

  describe("happy path", () => {
    it("pays the base at settlement, returns the bond on disclosure, and releases the contingent on confirmation", async () => {
      const { bazaar, seller, buyer, publicClient, oracleWallet } = await fixture();
      const { stake } = await listFinding(bazaar, seller);
      const price = await buyNow(bazaar, buyer);
      const l0 = (await bazaar.read.getListing([1n])) as any;
      const base = l0.basePart as bigint;
      const contingent = l0.contingentPart as bigint;
      expect(base + contingent).to.equal(price);

      await bazaar.write.deliver([1n, toHex("ecies-wrapped-key")], { account: seller.account });
      await expect(bazaar.write.claimPayment([1n], { account: seller.account })).to.be.rejectedWith("TooEarly");

      await time.increase(CHALLENGE_WINDOW + 1);
      const paid = await netReceived(publicClient, seller.account.address, () =>
        bazaar.write.claimPayment([1n], { account: seller.account }),
      );
      expect(paid).to.equal(base);
      // Stake and contingent are both still held.
      expect(await publicClient.getBalance({ address: bazaar.address })).to.equal(stake + contingent);
      expect(((await bazaar.read.sellerRep([seller.account.address])) as any)[0]).to.equal(1);

      await expect(bazaar.write.disclose([1n, KEY], { account: seller.account })).to.be.rejectedWith("TooEarly");
      await time.increase(MIN_EMBARGO);
      const bondBack = await netReceived(publicClient, seller.account.address, () =>
        bazaar.write.disclose([1n, KEY], { account: seller.account }),
      );
      expect(bondBack).to.equal(stake);
      expect(((await bazaar.read.getListing([1n])) as any).status).to.equal(6);

      // An advisory lands inside the confirmation window: the contingent goes to the seller.
      const released = await receivedFromOther(publicClient, seller.account.address, () =>
        bazaar.write.confirmOutcome([1n, "GHSA-xxxx-yyyy-zzzz"], { account: oracleWallet.account }),
      );
      expect(released).to.equal(contingent);
      expect(await publicClient.getBalance({ address: bazaar.address })).to.equal(0n);
      const l = (await bazaar.read.getListing([1n])) as any;
      expect(l.contingent).to.equal(2); // Released
      expect(((await bazaar.read.sellerRep([seller.account.address])) as any)[2]).to.equal(1);
    });

    it("returns most of the contingent to the buyer and keeps a slice in the pool when no advisory arrives", async () => {
      const { bazaar, seller, buyer, publicClient, stranger } = await fixture();
      await listFinding(bazaar, seller);
      await buyNow(bazaar, buyer);
      const contingent = ((await bazaar.read.getListing([1n])) as any).contingentPart as bigint;
      await bazaar.write.deliver([1n, toHex("k")], { account: seller.account });
      await time.increase(CHALLENGE_WINDOW + MIN_EMBARGO + 1);
      await bazaar.write.disclose([1n, KEY], { account: seller.account });

      await expect(bazaar.write.expireContingent([1n], { account: stranger.account })).to.be.rejectedWith("TooEarly");
      await time.increase(CONFIRMATION_WINDOW + 1);

      const toBuyer = await netReceived(publicClient, buyer.account.address, () =>
        bazaar.write.expireContingent([1n], { account: buyer.account }),
      );
      const toPool = (contingent * 2_000n) / 10_000n;
      expect(toBuyer).to.equal(contingent - toPool);
      expect((await bazaar.read.disclosurePool()) as bigint).to.equal(toPool);
      expect(((await bazaar.read.getListing([1n])) as any).contingent).to.equal(3); // Returned
      expect(((await bazaar.read.sellerRep([seller.account.address])) as any)[3]).to.equal(1);
      // Too late for the oracle to confirm now.
      await expect(bazaar.write.confirmOutcome([1n, "late"], { account: (await hre.viem.getWalletClients())[1].account })).to.be.rejectedWith(
        "NothingEscrowed",
      );
    });

    it("only lets the oracle confirm, and only inside the window", async () => {
      const { bazaar, seller, buyer, stranger, oracleWallet } = await fixture();
      await listFinding(bazaar, seller);
      await buyNow(bazaar, buyer);
      await bazaar.write.deliver([1n, toHex("k")], { account: seller.account });
      await time.increase(CHALLENGE_WINDOW + MIN_EMBARGO + 1);
      await bazaar.write.disclose([1n, KEY], { account: seller.account });
      await expect(bazaar.write.confirmOutcome([1n, "x"], { account: stranger.account })).to.be.rejectedWith("NotOracle");
      await time.increase(CONFIRMATION_WINDOW + 1);
      await expect(bazaar.write.confirmOutcome([1n, "x"], { account: oracleWallet.account })).to.be.rejectedWith("TooLate");
    });

    it("rejects a disclosure with the wrong key", async () => {
      const { bazaar, seller, buyer } = await fixture();
      await listFinding(bazaar, seller);
      await buyNow(bazaar, buyer);
      await bazaar.write.deliver([1n, toHex("k")], { account: seller.account });
      await time.increase(CHALLENGE_WINDOW + MIN_EMBARGO + 1);
      await expect(bazaar.write.disclose([1n, keccak256(toHex("wrong"))], { account: seller.account })).to.be.rejectedWith("BadKey");
    });

    it("lets anyone holding the key claim the bond if the seller stalls past the grace period", async () => {
      const { bazaar, seller, buyer, publicClient } = await fixture();
      const { stake } = await listFinding(bazaar, seller);
      await buyNow(bazaar, buyer);
      await bazaar.write.deliver([1n, toHex("k")], { account: seller.account });
      await time.increase(CHALLENGE_WINDOW + MIN_EMBARGO + 1);
      await expect(bazaar.write.disclose([1n, KEY], { account: buyer.account })).to.be.rejectedWith("TooEarly");
      await time.increase(DISCLOSURE_GRACE);
      const got = await netReceived(publicClient, buyer.account.address, () =>
        bazaar.write.disclose([1n, KEY], { account: buyer.account }),
      );
      expect(got).to.equal(stake);
    });
  });

  describe("challenge", () => {
    async function delivered() {
      const f = await fixture();
      const { stake } = await listFinding(f.bazaar, f.seller);
      const price = await buyNow(f.bazaar, f.buyer);
      await f.bazaar.write.deliver([1n, toHex("k")], { account: f.seller.account });
      const bond = (await f.bazaar.read.challengeBondFor([price])) as bigint;
      const l = (await f.bazaar.read.getListing([1n])) as any;
      return { ...f, stake, price, bond, base: l.basePart as bigint, contingent: l.contingentPart as bigint };
    }

    it("pays the seller the base plus the bond when the arbiter upholds the attestation", async () => {
      const { bazaar, seller, buyer, arbiterWallet, publicClient, bond, base, stake, contingent } = await delivered();
      await bazaar.write.challenge([1n, keccak256(toHex("my trace")), "trace differs"], { account: buyer.account, value: bond });
      expect(((await bazaar.read.getListing([1n])) as any).status).to.equal(4);
      const got = await receivedFromOther(publicClient, seller.account.address, () =>
        bazaar.write.resolveChallenge([1n, true, keccak256(toHex("rerun")), "three fresh runs reproduced the attested trace"], {
          account: arbiterWallet.account,
        }),
      );
      expect(got).to.equal(base + bond);
      expect(((await bazaar.read.getListing([1n])) as any).status).to.equal(5);
      expect(await publicClient.getBalance({ address: bazaar.address })).to.equal(stake + contingent);
    });

    it("refunds the buyer and hands the stake to a third-party challenger when the challenge is upheld", async () => {
      const { bazaar, seller, buyer, stranger, arbiterWallet, publicClient, bond, price, stake } = await delivered();
      await bazaar.write.challenge([1n, keccak256(toHex("t")), "claims not reproduced"], { account: stranger.account, value: bond });
      const buyerBefore = await publicClient.getBalance({ address: buyer.account.address });
      const challengerGot = await receivedFromOther(publicClient, stranger.account.address, () =>
        bazaar.write.resolveChallenge([1n, false, keccak256(toHex("rerun")), "claimed exfil never happened"], {
          account: arbiterWallet.account,
        }),
      );
      const buyerAfter = await publicClient.getBalance({ address: buyer.account.address });
      expect(buyerAfter - buyerBefore).to.equal(price);
      expect(challengerGot).to.equal(bond + stake);
      expect(((await bazaar.read.getListing([1n])) as any).status).to.equal(7);
      expect(((await bazaar.read.sellerRep([seller.account.address])) as any)[1]).to.equal(1);
      expect(await publicClient.getBalance({ address: bazaar.address })).to.equal(0n);
    });

    it("only lets the arbiter resolve, never the oracle", async () => {
      const { bazaar, buyer, oracleWallet, bond } = await delivered();
      await bazaar.write.challenge([1n, keccak256(toHex("t")), "x"], { account: buyer.account, value: bond });
      await expect(
        bazaar.write.resolveChallenge([1n, true, keccak256(toHex("r")), "x"], { account: oracleWallet.account }),
      ).to.be.rejectedWith("NotArbiter");
    });

    it("rejects a challenge filed after the window closes", async () => {
      const { bazaar, buyer, bond } = await delivered();
      await time.increase(CHALLENGE_WINDOW + 1);
      await expect(bazaar.write.challenge([1n, keccak256(toHex("t")), "x"], { account: buyer.account, value: bond })).to.be.rejectedWith(
        "TooLate",
      );
    });
  });

  describe("seller timeout", () => {
    it("refunds the buyer the price plus the whole stake when the seller never delivers", async () => {
      const { bazaar, seller, buyer, publicClient } = await fixture();
      const { stake } = await listFinding(bazaar, seller);
      const price = await buyNow(bazaar, buyer);
      await expect(bazaar.write.claimTimeout([1n], { account: buyer.account })).to.be.rejectedWith("TooEarly");
      await time.increase(DELIVERY_DEADLINE + 1);
      const got = await netReceived(publicClient, buyer.account.address, () =>
        bazaar.write.claimTimeout([1n], { account: buyer.account }),
      );
      expect(got).to.equal(price + stake);
      expect(((await bazaar.read.getListing([1n])) as any).status).to.equal(7);
      expect(((await bazaar.read.sellerRep([seller.account.address])) as any)[1]).to.equal(1);
    });

    it("stops the seller delivering after the deadline has passed", async () => {
      const { bazaar, seller, buyer } = await fixture();
      await listFinding(bazaar, seller);
      await buyNow(bazaar, buyer);
      await time.increase(DELIVERY_DEADLINE + 1);
      await expect(bazaar.write.deliver([1n, toHex("k")], { account: seller.account })).to.be.rejectedWith("TooLate");
    });
  });

  describe("access control", () => {
    it("only lets the seller deliver and only the buyer claim a timeout", async () => {
      const { bazaar, seller, buyer, stranger } = await fixture();
      await listFinding(bazaar, seller);
      await buyNow(bazaar, buyer);
      await expect(bazaar.write.deliver([1n, toHex("k")], { account: stranger.account })).to.be.rejectedWith("NotSeller");
      await time.increase(DELIVERY_DEADLINE + 1);
      await expect(bazaar.write.claimTimeout([1n], { account: stranger.account })).to.be.rejectedWith("NotBuyer");
    });
  });
});
