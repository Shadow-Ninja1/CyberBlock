/**
 * Server-side read model for the UI. Pulls every listing from chain, decodes the
 * event log for the sealed blob / wrapped key / disclosed key, and — only once a
 * listing is publicly disclosed — opens the plaintext so the page can show it.
 *
 * Before disclosure the plaintext is never reconstructed here; the page only ever
 * sees the attested grade, exactly like a real buyer.
 */
import type { Hex } from "viem";
import {
  allListings,
  listingLogs,
  sellerRep,
  fairPrice,
  txUrl,
  addressUrl,
  BAZAAR_ADDRESS,
  ORACLE_ADDRESS,
  CHAIN_ID,
  EXPLORER,
  type OnChainListing,
} from "./chain";
import { openFinding } from "./crypto";
import { detectorSource } from "./detector";
import { Status, STATUS_LABEL, VULN_CLASS_LABEL, type Finding } from "./types";

export interface ListingView {
  id: number;
  status: number;
  statusLabel: string;
  seller: string;
  buyer: string;
  targetLabel: string;
  severity: number;
  vulnClass: number;
  vulnClassLabel: string;
  novel: boolean;
  installBase: number;
  priceWei: string;
  priceEth: number;
  fairPriceEth: number;
  stakeEth: number;
  embargoMinutes: number;
  artifactHash: Hex;
  contentHash: Hex;
  detectorHash: Hex;
  soldAt: number;
  deliveredAt: number;
  challengeEndsAt: number | null;
  embargoEndsAt: number | null;
  sellerRep: { sold: number; slashed: number };
  listedTx: string | null;
  disclosedTx: string | null;
  /** Present only after public disclosure. */
  revealed: (Finding & { key: Hex }) | null;
}

export interface MarketView {
  contract: { address: string; explorer: string; chainId: number; oracle: string; addressUrl: string };
  listings: ListingView[];
  detector: { detectorHash: Hex; bytes: number };
  now: number;
}

async function toView(l: OnChainListing): Promise<ListingView> {
  const logs = await listingLogs(l.id);
  const rep = await sellerRep(l.seller);
  const fair = await fairPrice(l.att, l.embargo);

  const targetLabel = (logs.listed?.args?.targetLabel as string) ?? "unknown";
  const soldAt = Number(l.soldAt);
  const deliveredAt = Number(l.deliveredAt);

  let revealed: (Finding & { key: Hex }) | null = null;
  if (l.status === Status.Disclosed && logs.disclosed && logs.listed) {
    try {
      const key = logs.disclosed.args.key as Hex;
      const ciphertext = logs.listed.args.ciphertext as Hex;
      const finding = openFinding(ciphertext, key, l.att.contentHash);
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
    targetLabel,
    severity: l.att.severity,
    vulnClass: l.att.vulnClass,
    vulnClassLabel: VULN_CLASS_LABEL[l.att.vulnClass] ?? "Unclassified",
    novel: l.att.novel,
    installBase: l.att.installBase,
    priceWei: l.price.toString(),
    priceEth: Number(l.price) / 1e18,
    fairPriceEth: Number(fair) / 1e18,
    stakeEth: Number(l.stake) / 1e18,
    embargoMinutes: Number(l.embargo) / 60,
    artifactHash: l.att.artifactHash,
    contentHash: l.att.contentHash,
    detectorHash: l.att.detectorHash,
    soldAt,
    deliveredAt,
    challengeEndsAt: deliveredAt ? deliveredAt + 60 : null,
    embargoEndsAt: deliveredAt ? deliveredAt + Number(l.embargo) : null,
    sellerRep: rep,
    listedTx: logs.listed ? txUrl(logs.listed.transactionHash as Hex) : null,
    disclosedTx: logs.disclosed ? txUrl(logs.disclosed.transactionHash as Hex) : null,
    revealed,
  };
}

export async function marketView(): Promise<MarketView> {
  const listings = await allListings();
  const views = await Promise.all(listings.map(toView));
  views.sort((a, b) => b.id - a.id);
  const det = detectorSource();
  return {
    contract: {
      address: BAZAAR_ADDRESS,
      explorer: EXPLORER,
      chainId: CHAIN_ID,
      oracle: ORACLE_ADDRESS,
      addressUrl: addressUrl(BAZAAR_ADDRESS),
    },
    listings: views,
    detector: { detectorHash: det.detectorHash, bytes: det.bytes },
    now: Math.floor(Date.now() / 1000),
  };
}
