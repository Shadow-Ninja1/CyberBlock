import { NextResponse } from "next/server";
import { attest } from "@/lib/oracle";
import { effectList, type Finding } from "@/lib/types";
import { record } from "@/lib/store";
import type { Hex } from "viem";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Grades a finding submitted by a real (wallet) seller. The client seals the
 * finding, then posts the plaintext finding, the ciphertext and the key here. The
 * oracle detonates the repro in the committed sandbox, verifies the claimed effects
 * and the declared access, checks OSV, and — only if all pass — returns its EIP-712
 * signature over the attestation. The seller then signs `list()` from their wallet.
 * No listing is possible without this signature.
 */
export async function POST(req: Request) {
  let body: { finding?: Finding; ciphertext?: Hex; key?: Hex } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, refusal: { reason: "bad-request", detail: "Malformed JSON." } }, { status: 400 });
  }
  const { finding, ciphertext, key } = body;
  if (!finding || !ciphertext || !key) {
    return NextResponse.json({ ok: false, refusal: { reason: "bad-request", detail: "finding, ciphertext and key are required." } }, { status: 400 });
  }

  try {
    record({ actor: "seller", level: "info", message: `wallet seller submitted "${finding.outcome}" for grading` });
    const outcome = await attest({ finding, ciphertext, key });

    if (!outcome.ok) {
      record({ actor: "oracle", level: "warn", message: `REFUSED (${outcome.reason}): ${outcome.detail}` });
      return NextResponse.json({ ok: false, refusal: { reason: outcome.reason, detail: outcome.detail, facts: outcome.facts } });
    }

    const effectLabels = effectList(outcome.att.effects).map((e) => e.label);
    record({
      actor: "oracle",
      level: "ok",
      message: `detonated ${outcome.meta.targetLabel}: observed ${effectLabels.join(", ")}; trace ${outcome.att.traceHash.slice(0, 10)}; signed for wallet seller`,
    });

    return NextResponse.json({
      ok: true,
      // expiresAt is a bigint; serialize as string and re-hydrate on the client.
      att: { ...outcome.att, expiresAt: outcome.att.expiresAt.toString() },
      signature: outcome.signature,
      outcome: outcome.meta.outcome,
      targetLabel: outcome.meta.targetLabel,
      effects: outcome.att.effects,
      effectLabels,
      novel: outcome.att.novel,
      installBase: outcome.att.installBase,
      judge: outcome.meta.judge,
      captures: outcome.meta.captures,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    record({ actor: "system", level: "error", message: `attest failed: ${msg.slice(0, 200)}` });
    return NextResponse.json({ ok: false, refusal: { reason: "error", detail: msg } }, { status: 500 });
  }
}
