/**
 * Server-side read model for the UI. Pulls every listing from chain, decodes the
 * event log for the sealed blob / wrapped key / disclosed key / outcome, and — only
 * once a listing is publicly disclosed — opens the plaintext so the page can show it.
 *
 * Before disclosure the plaintext is never reconstructed here; the page sees only
 * the attested effects and the one-sentence outcome, exactly like a real buyer.
 */
import type { Address, Hex } from "viem";
import {
  allListings,
  listingLogs,
  sellerRep,
  currentPrice,
  txUrl,
  addressUrl,
  CONTRACT_ADDRESS,
  ORACLE_ADDRESS,
  ARBITER_ADDRESS,
  CHAIN_ID,
  EXPLORER,
  type OnChainListing,
} from "./chain";
import { openFinding } from "./crypto";
import { sandboxSource } from "./sandbox";
import { findingForTarget } from "./agents";
import { Status, STATUS_LABEL, Contingent, effectList, type Finding } from "./types";

const CHALLENGE_WINDOW = 60;
const CONFIRMATION_WINDOW = 120;
const DELIVERY_DEADLINE = 600; // matches the contract's DELIVERY_DEADLINE (10 min)

export interface ListingView {
  id: number;
  status: number;
  statusLabel: string;
  seller: string;
  buyer: string;
  challenger: string;
  targetLabel: string;
  outcome: string;
  effects: number;
  effectLabels: string[];
  novel: boolean;
  installBase: number;
  /** True when the oracle host holds the finding for this listing, so the built-in
   *  demo agents can drive deliver/settle/disclose/verify from the server. A listing
   *  created by a wallet or the CLI is false: only its own author can advance it. */
  serverManaged: boolean;
  // pricing
  startPriceEth: number;
  reservePriceEth: number;
  currentPriceEth: number;
  clearingPriceEth: number; // set once sold
  contingentBps: number;
  basePriceEth: number;
  contingentPriceEth: number;
  contingentState: number;
  contingentStateLabel: string;
  auctionStartedAt: number;
  auctionEndsAt: number;
  stakeEth: number;
  embargoMinutes: number;
  // commitments
  artifactHash: Hex;
  contentHash: Hex;
  traceHash: Hex;
  sandboxHash: Hex;
  // timeline
  soldAt: number;
  deliveredAt: number;
  disclosedAt: number;
  deliveryDeadline: number | null;
  challengeEndsAt: number | null;
  embargoEndsAt: number | null;
  confirmationEndsAt: number | null;
  sellerRep: { sold: number; slashed: number; confirmed: number; unconfirmed: number };
  listedTx: string | null;
  disclosedTx: string | null;
  revealed: (Finding & { key: Hex }) | null;
}

export interface MarketView {
  contract: { address: string; explorer: string; chainId: number; oracle: string; arbiter: string; addressUrl: string };
  listings: ListingView[];
  sandbox: { sandboxHash: Hex; bytes: number };
  now: number;
}

const CONTINGENT_LABEL: Record<number, string> = { 0: "None", 1: "Escrowed", 2: "Released", 3: "Returned" };

async function toView(l: OnChainListing, repOf: (seller: Address) => Promise<ListingView["sellerRep"]>): Promise<ListingView> {
  const [logs, rep, priceNow] = await Promise.all([
    listingLogs(l.id, l.status),
    repOf(l.seller),
    l.status === Status.Listed ? currentPrice(l.id) : Promise.resolve(l.price),
  ]);

  const targetLabel = (logs.listed?.args?.targetLabel as string) ?? "unknown";
  const outcome = (logs.listed?.args?.outcome as string) ?? "";
  const soldAt = Number(l.soldAt);
  const deliveredAt = Number(l.deliveredAt);
  const disclosedAt = Number(l.disclosedAt);
  const auctionStartedAt = Number(l.auction.startedAt);

  let revealed: (Finding & { key: Hex }) | null = null;
  if (l.status === Status.Disclosed && logs.disclosed && logs.listed) {
    try {
      const key = logs.disclosed.args.key as Hex;
      const finding = openFinding(logs.listed.args.ciphertext as Hex, key, l.att.contentHash);
      revealed = { ...finding, key };
    } catch {
      revealed = null;
    }
  }

  return {
    id: Number(l.id),
    status: l.status,
    statusLabel: STATUS_LABEL[l.status],
    seller: l.seller,
    buyer: l.buyer,
    challenger: l.challenger,
    targetLabel,
    outcome,
    effects: l.att.effects,
    effectLabels: effectList(l.att.effects).map((e) => e.label),
    novel: l.att.novel,
    installBase: l.att.installBase,
    serverManaged: findingForTarget(targetLabel) != null,
    startPriceEth: Number(l.auction.startPrice) / 1e18,
    reservePriceEth: Number(l.auction.reservePrice) / 1e18,
    currentPriceEth: Number(priceNow) / 1e18,
    clearingPriceEth: Number(l.price) / 1e18,
    contingentBps: l.auction.contingentBps,
    basePriceEth: Number(l.basePart) / 1e18,
    contingentPriceEth: Number(l.contingentPart) / 1e18,
    contingentState: l.contingent,
    contingentStateLabel: CONTINGENT_LABEL[l.contingent] ?? "None",
    auctionStartedAt,
    auctionEndsAt: auctionStartedAt + Number(l.auction.duration),
    stakeEth: Number(l.stake) / 1e18,
    embargoMinutes: Number(l.embargo) / 60,
    artifactHash: l.att.artifactHash,
    contentHash: l.att.contentHash,
    traceHash: l.att.traceHash,
    sandboxHash: l.att.sandboxHash,
    soldAt,
    deliveredAt,
    disclosedAt,
    deliveryDeadline: soldAt ? soldAt + DELIVERY_DEADLINE : null,
    challengeEndsAt: deliveredAt ? deliveredAt + CHALLENGE_WINDOW : null,
    embargoEndsAt: deliveredAt ? deliveredAt + Number(l.embargo) : null,
    confirmationEndsAt: disclosedAt ? disclosedAt + CONFIRMATION_WINDOW : null,
    sellerRep: rep,
    listedTx: logs.listed ? txUrl(logs.listed.transactionHash as Hex) : null,
    disclosedTx: logs.disclosed ? txUrl(logs.disclosed.transactionHash as Hex) : null,
    revealed,
  };
}

export async function marketView(): Promise<MarketView> {
  const listings = await allListings();
  // One sellerRep read per distinct seller per refresh, not per listing.
  const reps = new Map<Address, Promise<ListingView["sellerRep"]>>();
  const repOf = (seller: Address) => {
    let p = reps.get(seller);
    if (!p) reps.set(seller, (p = sellerRep(seller)));
    return p;
  };
  const views = await Promise.all(listings.map((l) => toView(l, repOf)));
  views.sort((a, b) => b.id - a.id);
  const sb = sandboxSource();
  return {
    contract: {
      address: CONTRACT_ADDRESS,
      explorer: EXPLORER,
      chainId: CHAIN_ID,
      oracle: ORACLE_ADDRESS,
      arbiter: ARBITER_ADDRESS,
      addressUrl: addressUrl(CONTRACT_ADDRESS),
    },
    listings: views,
    sandbox: { sandboxHash: sb.sandboxHash, bytes: sb.bytes },
    now: Math.floor(Date.now() / 1000),
  };
}

export { Contingent };
