import { NextResponse } from "next/server";
import { detectorSource } from "@/lib/detector";

export const runtime = "nodejs";

/**
 * Serves the exact detector source behind every attestation, plus its keccak256.
 * This is what makes the oracle auditable: anyone can fetch this, hash it, and
 * confirm it matches the `detectorHash` committed in a listing's attestation.
 */
export async function GET() {
  const d = detectorSource();
  return NextResponse.json({ ok: true, detectorHash: d.detectorHash, bytes: d.bytes, source: d.source });
}
