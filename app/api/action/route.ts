import { NextResponse } from "next/server";
import {
  sellerList,
  buyById,
  deliverById,
  discloseById,
  resolveById,
  buyerDispute,
  claimPayment,
  requestAttestation,
} from "@/lib/agents";
import { tail, record } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Drives one lifecycle step on-chain, as the relevant agent. The page calls this;
 * the agents sign with the role keys held only on the server.
 */
export async function POST(req: Request) {
  const since = Date.now() - 1;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* empty body ok for some actions */
  }
  const { action } = body;
  const id = body.id !== undefined ? BigInt(body.id) : undefined;

  try {
    switch (action) {
      case "list":
        await sellerList(body.findingFile);
        break;

      case "attest-only": {
        // Show the oracle's decision (including refusals) without listing.
        const out = await requestAttestation(body.findingFile);
        if (!out.ok) {
          // requestAttestation already logged the refusal.
        }
        break;
      }

      case "buy":
        if (id === undefined) throw new Error("id required");
        await buyById(id);
        break;

      case "deliver":
        if (id === undefined) throw new Error("id required");
        await deliverById(id);
        break;

      case "settle":
        if (id === undefined) throw new Error("id required");
        await claimPayment(id);
        break;

      case "disclose":
        if (id === undefined) throw new Error("id required");
        await discloseById(id);
        break;

      case "dispute":
        if (id === undefined) throw new Error("id required");
        await buyerDispute(id, body.reason ?? "buyer challenges the attestation");
        break;

      case "resolve":
        if (id === undefined) throw new Error("id required");
        await resolveById(id);
        break;

      default:
        return NextResponse.json({ ok: false, error: `unknown action: ${action}` }, { status: 400 });
    }

    return NextResponse.json({ ok: true, logs: tail(since) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    record({ actor: "system", level: "error", message: `${action} failed: ${msg.slice(0, 200)}` });
    return NextResponse.json({ ok: false, error: msg, logs: tail(since) }, { status: 500 });
  }
}
