import { NextResponse } from "next/server";
import { sandboxSource } from "@/lib/sandbox";

export const runtime = "nodejs";

/**
 * Serves the exact sandbox runtime behind every attestation, plus its keccak256.
 * Anyone can fetch this, hash it, and confirm it matches the `sandboxHash`
 * committed in a listing's attestation, then re-run it to reproduce the trace.
 */
export async function GET() {
  const s = sandboxSource();
  return NextResponse.json({ ok: true, sandboxHash: s.sandboxHash, bytes: s.bytes, source: s.source });
}
