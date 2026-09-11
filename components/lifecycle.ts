import type { ListingView } from "@/lib/view";

/** The five happy-path stages a listing moves through. */
export const STAGES = ["Listed", "Sold", "Delivered", "Settled", "Disclosed"] as const;

export const STAGE_INDEX: Record<number, number> = {
  1: 0, // Listed
  2: 1, // Sold
  3: 2, // Delivered
  4: 2, // Disputed — sits at the Delivered stage
  5: 3, // Settled
  6: 4, // Disclosed
  7: 2, // Refunded — ended at Delivered
  8: 0, // Cancelled
};

/** Plain-language explanation of where a listing stands and what it means. */
export function statusCopy(l: ListingView): { headline: string; detail: string; tone: string } {
  switch (l.status) {
    case 1:
      return {
        headline: "Sealed and for sale",
        detail:
          "The grade below is public. The finding itself is encrypted on-chain — nobody, including the buyer, can read it yet.",
        tone: "info",
      };
    case 2:
      return {
        headline: "Paid for, awaiting the key",
        detail:
          "The buyer's money is locked in escrow. The seller now owes the decryption key, or the buyer can reclaim everything.",
        tone: "info",
      };
    case 3:
      return {
        headline: "Delivered — buyer is checking it",
        detail:
          "The buyer decrypted the finding and confirmed its hash matches what the verifier graded. They can settle, or challenge the grade.",
        tone: "brand",
      };
    case 4:
      return {
        headline: "Under dispute",
        detail:
          "The buyer challenged the grade and put up a bond. The verifier re-runs the exact detector to decide who is right.",
        tone: "warn",
      };
    case 5:
      return {
        headline: "Paid — buyer has exclusivity",
        detail:
          "The seller has been paid. The buyer holds this finding exclusively until the embargo expires, then it goes public.",
        tone: "good",
      };
    case 6:
      return {
        headline: "Public",
        detail:
          "The key was published on-chain. Anyone can now read the finding for free and re-run the detector to check the verifier's work.",
        tone: "good",
      };
    case 7:
      return {
        headline: "Refunded, seller slashed",
        detail: "The buyer got their money back plus the seller's stake. The seller's reputation took a hit.",
        tone: "bad",
      };
    case 8:
      return { headline: "Withdrawn", detail: "The seller pulled the listing before anyone bought it.", tone: "neutral" };
    default:
      return { headline: "Unknown", detail: "", tone: "neutral" };
  }
}

export interface NextStep {
  step: number;
  title: string;
  body: string;
  /** The action to take now, if any. */
  action?: { label: string; body: Record<string, unknown>; key: string };
  /** A timer we're waiting on before the action unlocks. */
  waitUntil?: number | null;
  waitLabel?: string;
  listingId?: number;
  done?: boolean;
}

/**
 * Works out the single most useful thing to do next, so the page can always
 * answer "what happens now?" instead of leaving the visitor to guess.
 */
export function nextStep(listings: ListingView[], now: number): NextStep {
  if (listings.length === 0) {
    return {
      step: 1,
      title: "Put a finding on the market",
      body: "A researcher has found malware in an npm package. Before it can be listed, an independent verifier re-runs a public detector against the real package file and signs a grade. Nothing can be listed without that signature.",
      action: {
        label: "List a finding",
        key: "list-evil",
        body: { action: "list", findingFile: "evil-widget-1.2.0.json" },
      },
    };
  }

  // Work on the oldest listing that is still moving.
  const active = [...listings].reverse().find((l) => l.status >= 1 && l.status <= 5);

  if (!active) {
    const anyDisclosed = listings.some((l) => l.status === 6);
    return {
      step: 6,
      title: anyDisclosed ? "The loop is complete" : "Nothing in flight",
      body: anyDisclosed
        ? "A finding has gone through the full cycle and is now public. Hit “re-verify” on it to independently re-run the detector and confirm the verifier graded it honestly. You can also list the second finding to run the dispute path."
        : "List another finding to start a new cycle.",
      action: {
        label: "List the second finding",
        key: "list-sneaky",
        body: { action: "list", findingFile: "sneaky-utils-0.4.1.json" },
      },
      done: anyDisclosed,
    };
  }

  const id = active.id;
  switch (active.status) {
    case 1:
      return {
        step: 2,
        listingId: id,
        title: "The buyer decides, blind",
        body: `A security vendor's agent looks only at the signed grade — severity, category, how many installs are affected, and the seller's track record. It cannot see the finding. If the grade clears its policy, it pays ${eth(active.priceEth)} ETH into escrow.`,
        action: { label: "Let the buyer evaluate and buy", key: `buy-${id}`, body: { action: "buy", id } },
      };
    case 2:
      return {
        step: 3,
        listingId: id,
        title: "The seller hands over the key",
        body: "The money is in escrow. The seller now sends the decryption key, encrypted so only this buyer can open it. The buyer immediately checks that what they decrypted hashes to exactly what the verifier graded.",
        action: { label: "Deliver the key", key: `deliver-${id}`, body: { action: "deliver", id } },
      };
    case 3: {
      const ready = active.challengeEndsAt !== null && now >= active.challengeEndsAt;
      return {
        step: 4,
        listingId: id,
        title: ready ? "Release the money" : "Challenge window is open",
        body: ready
          ? "The challenge window closed without a dispute. The escrow can now be released to the seller. Their stake stays locked as a disclosure bond."
          : "The buyer has the finding and has verified it. During this window they can challenge the grade by posting a bond. If they don't, the seller gets paid.",
        action: ready
          ? { label: "Release escrow to the seller", key: `settle-${id}`, body: { action: "settle", id } }
          : {
              label: "Challenge the grade instead",
              key: `dispute-${id}`,
              body: { action: "dispute", id, reason: "buyer challenges the attestation" },
            },
        waitUntil: ready ? null : active.challengeEndsAt,
        waitLabel: "until escrow can be released",
      };
    }
    case 4:
      return {
        step: 4,
        listingId: id,
        title: "The verifier settles it",
        body: "The verifier re-downloads the exact package file, re-runs the exact detector whose hash was committed in the grade, and re-checks the public vulnerability database. Whoever is wrong loses money.",
        action: { label: "Re-run the detector and rule", key: `resolve-${id}`, body: { action: "resolve", id } },
      };
    case 5: {
      const ready = active.embargoEndsAt !== null && now >= active.embargoEndsAt;
      return {
        step: 5,
        listingId: id,
        title: ready ? "Publish it to everyone" : "Embargo running",
        body: ready
          ? "The buyer's exclusive window is over. Publishing the key releases the finding to the whole world for free and returns the seller's bond. This is the point of the market: the buyer's fee paid for a disclosure everyone now gets."
          : "The buyer paid for a head start, and this is it. While the clock runs, only they have the finding. When it expires the key goes public and the seller's bond comes back.",
        action: ready
          ? { label: "Publish the key", key: `disclose-${id}`, body: { action: "disclose", id } }
          : undefined,
        waitUntil: ready ? null : active.embargoEndsAt,
        waitLabel: "until it goes public",
      };
    }
    default:
      return { step: 1, title: "", body: "" };
  }
}

function eth(n: number) {
  return n < 0.001 ? n.toFixed(6) : n.toFixed(4);
}
