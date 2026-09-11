import type { ListingView } from "@/lib/view";
import { Contingent } from "@/lib/types";

/** The stages of the guided walkthrough, in order. */
export const STEPS = ["Grade & list", "Buy blind", "Deliver", "Settle", "Disclose", "Confirm"] as const;

export type Actor = "seller" | "buyer" | "oracle" | "arbiter" | "chain";

/** Plain-language status for a listing: a short label, a tone, and a sentence. */
export function statusCopy(l: ListingView): { headline: string; detail: string; tone: string } {
  switch (l.status) {
    case 1:
      return { headline: "Auction live", detail: "Sealed on-chain. Only the observed effects and one-sentence outcome are visible; the price is falling.", tone: "red" };
    case 2:
      return { headline: "In escrow", detail: "The buyer paid the clearing price. The seller now owes the decryption key.", tone: "white" };
    case 3:
      return { headline: "Key delivered", detail: "The buyer decrypted it and confirmed the hash. Challenge window open.", tone: "white" };
    case 4:
      return { headline: "Challenged", detail: "Someone challenged the trace. The arbiter re-detonates the repro to rule.", tone: "warn" };
    case 5:
      return { headline: "Settled · embargo", detail: "The seller took the base. The buyer holds it exclusively until the embargo ends.", tone: "good" };
    case 6:
      return {
        headline: l.contingentState === Contingent.Released ? "Public · confirmed" : l.contingentState === Contingent.Returned ? "Public · unconfirmed" : "Public · awaiting confirmation",
        detail:
          l.contingentState === Contingent.Escrowed
            ? "The key is public. The contingent share waits for an external advisory to confirm the finding."
            : l.contingentState === Contingent.Released
              ? "An advisory confirmed the finding; the contingent share went to the seller."
              : "No advisory arrived; most of the contingent returned to the buyer.",
        tone: "good",
      };
    case 7:
      return { headline: "Refunded", detail: "Buyer refunded; the challenger took the seller's stake. The seller was slashed.", tone: "bad" };
    case 8:
      return { headline: "Withdrawn", detail: "The seller pulled the listing before a sale.", tone: "neutral" };
    default:
      return { headline: "Unknown", detail: "", tone: "neutral" };
  }
}

export interface NextStep {
  step: number;
  actor: Actor;
  title: string;
  accent: string;
  body: string;
  action?: { label: string; body: Record<string, unknown>; key: string; danger?: boolean };
  /** Pulls the unsold listing so the walkthrough can begin again at step 1. */
  restart?: { label: string; body: Record<string, unknown>; key: string };
  waitUntil?: number | null;
  waitLabel?: string;
  listingId?: number;
  done?: boolean;
}

const NEXT_FIXTURE = ["evil-widget-1.2.0.json", "sneaky-utils-0.4.1.json"];
const RECENT_SECONDS = 15 * 60;

function lastTouched(l: ListingView): number {
  return Math.max(l.auctionStartedAt, l.soldAt, l.deliveredAt, l.disclosedAt);
}

/** Works out the single most useful thing to do next. */
export function nextStep(listings: ListingView[], now: number): NextStep {
  // The walkthrough drives the built-in demo agents on the server, so it can only
  // advance a listing whose finding the oracle host holds. A listing created from a
  // wallet or the CLI (serverManaged === false) is driven by its own author in the
  // Market tab and must never capture the guided flow, or its buttons would 500.
  const active = [...listings]
    .reverse()
    .find((l) => l.serverManaged && ((l.status >= 1 && l.status <= 5) || (l.status === 6 && l.contingentState === Contingent.Escrowed)));

  if (!active) {
    // Count only the demo listings the walkthrough itself created, so a wallet or
    // CLI listing on the market never makes the flow think a cycle has run. The
    // contract is long-lived, so earlier sessions' runs are still on it: a fresh
    // visit starts at step 1, and "complete" is shown only for a run that just ended.
    const managed = listings.filter((l) => l.serverManaged);
    const fixture = NEXT_FIXTURE[managed.length % NEXT_FIXTURE.length];
    const latest = managed.reduce<ListingView | null>((a, l) => (a && a.id > l.id ? a : l), null);
    const justFinished = latest != null && (latest.status === 6 || latest.status === 7) && now - lastTouched(latest) < RECENT_SECONDS;
    return {
      step: justFinished ? 6 : 1,
      actor: "seller",
      title: justFinished ? "Cycle complete." : "A researcher seals",
      accent: justFinished ? "Run another." : "a real malicious package.",
      body: justFinished
        ? "A finding has gone through the whole loop and is public. Open the Verifier to re-detonate the repro yourself, or list the next finding to see the challenge path."
        : "The researcher found malware and wrote a repro. Before it can be listed, the oracle detonates that repro in an instrumented sandbox, records exactly what the package did, and signs the observed effects. No signature, no listing.",
      action: { label: justFinished ? "List the next finding" : "Detonate and list the finding", key: `list-${fixture}`, body: { action: "list", findingFile: fixture } },
      done: justFinished,
    };
  }

  const id = active.id;
  switch (active.status) {
    case 1:
      return {
        step: 2,
        actor: "buyer",
        listingId: id,
        title: "The buyer decides",
        accent: "without looking.",
        body: `Its agent sees only what the sandbox observed — ${active.effectLabels.join(", ") || "the effects"} — plus the one-sentence outcome, the install base and the seller's record. If that clears its policy it buys at the current falling price of ${eth(active.currentPriceEth)} ETH. It never opens the finding.`,
        action: { label: "Let the vendor evaluate and buy", key: `buy-${id}`, body: { action: "buy", id } },
        restart: { label: "Pull this listing and start over", key: `cancel-${id}`, body: { action: "cancel", id } },
      };
    case 2: {
      const timedOut = active.deliveryDeadline !== null && now >= active.deliveryDeadline;
      if (timedOut)
        return {
          step: 3,
          actor: "buyer",
          listingId: id,
          title: "The seller went dark.",
          accent: "Refund the buyer.",
          body: "The delivery deadline passed with no key. The buyer reclaims the price plus the whole of the seller's stake, and the seller is slashed — so a paid seller can never strand the escrow.",
          action: { label: "Refund the buyer", key: `timeout-${id}`, body: { action: "timeout", id }, danger: true },
        };
      return {
        step: 3,
        actor: "seller",
        listingId: id,
        title: "The seller hands over",
        accent: "the key.",
        body: "The money is in escrow. The seller sends the decryption key, wrapped so only this buyer can open it. The buyer decrypts and checks the result hashes to exactly what the oracle graded.",
        action: { label: "Deliver the key", key: `deliver-${id}`, body: { action: "deliver", id } },
      };
    }
    case 3: {
      const ready = active.challengeEndsAt !== null && now >= active.challengeEndsAt;
      return {
        step: 4,
        actor: ready ? "chain" : "buyer",
        listingId: id,
        title: ready ? "Release the base" : "The buyer can",
        accent: ready ? "to the seller." : "challenge the trace.",
        body: ready
          ? "The challenge window closed with no challenge. The base share releases to the seller. Their stake stays locked as a disclosure bond, and the contingent share waits on the outcome."
          : "The buyer has the finding and verified it. Until the window closes anyone may re-detonate the repro and challenge the trace by posting a bond. If nobody does, the seller takes the base.",
        action: ready
          ? { label: "Release the base to the seller", key: `settle-${id}`, body: { action: "settle", id } }
          : { label: "Challenge the trace instead", key: `challenge-${id}`, body: { action: "challenge", id, reason: "buyer challenges the attested trace" }, danger: true },
        waitUntil: ready ? null : active.challengeEndsAt,
        waitLabel: "challenge window",
      };
    }
    case 4:
      return {
        step: 4,
        actor: "arbiter",
        listingId: id,
        title: "The arbiter",
        accent: "rules.",
        body: "A separate party from the oracle re-downloads the exact package, re-detonates the repro several times in the committed sandbox, and checks it reproduces the attested trace and effects. Whoever was wrong loses money.",
        action: { label: "Re-detonate and rule", key: `resolve-${id}`, body: { action: "resolve", id } },
      };
    case 5: {
      const ready = active.embargoEndsAt !== null && now >= active.embargoEndsAt;
      return {
        step: 5,
        actor: "chain",
        listingId: id,
        title: ready ? "Publish it" : "The buyer's",
        accent: ready ? "to everyone." : "head start.",
        body: ready
          ? "The exclusive window is over. Publishing the key releases the finding to the whole world for free, returns the seller's bond, and opens the confirmation window for the contingent share."
          : "This is what the buyer paid the base for. While the clock runs only they have the finding. When it expires the key goes public and the seller's bond comes back.",
        action: ready ? { label: "Publish the key", key: `disclose-${id}`, body: { action: "disclose", id } } : undefined,
        waitUntil: ready ? null : active.embargoEndsAt,
        waitLabel: "embargo",
      };
    }
    case 6: {
      const ready = active.confirmationEndsAt !== null && now >= active.confirmationEndsAt;
      return {
        step: 6,
        actor: ready ? "buyer" : "oracle",
        listingId: id,
        title: ready ? "No advisory came." : "Did the world",
        accent: ready ? "Refund the buyer." : "confirm it?",
        body: ready
          ? "The confirmation window closed with no external advisory. The buyer reclaims most of the contingent share; a slice stays in the disclosure pool so a buyer who could suppress an advisory gains nothing by doing so."
          : "The finding is public. If an OSV/GHSA advisory or a registry takedown confirms it inside the window, the escrowed contingent share is released to the seller. This is the ground-truth check that makes the seller's split a credibility signal.",
        action: ready
          ? { label: "Return the contingent to the buyer", key: `expire-${id}`, body: { action: "expire", id } }
          : { label: "Record the external advisory", key: `confirm-${id}`, body: { action: "confirm", id } },
        waitUntil: ready ? null : active.confirmationEndsAt,
        waitLabel: "confirmation window",
      };
    }
    default:
      return { step: 1, actor: "seller", title: "", accent: "", body: "" };
  }
}

function eth(n: number) {
  return n < 0.001 ? n.toFixed(6) : n.toFixed(4);
}
