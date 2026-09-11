import type { ListingView } from "@/lib/view";
import type { NextStep } from "../lifecycle";

export type Act = (key: string, body: Record<string, unknown>) => void;
export type View = "overview" | "trade" | "market" | "verifier" | "sell";

export interface ViewProps {
  listings: ListingView[];
  now: number;
  busy: string | null;
  act: Act;
  step: NextStep;
  go: (v: View, listingId?: number) => void;
  explorer?: string;
  sandboxHash?: string;
}
