import { NextResponse } from "next/server";
import { readListing, listingLogs } from "@/lib/chain";
import { findingForTarget } from "@/lib/agents";
import { loadArtifact } from "@/lib/oracle";
import { run } from "@/lib/sandbox";
import { effectList, Status } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Independent re-verification of a disclosed listing: re-detonate the committed
 * repro in the committed sandbox and report whether it reproduces the attested
 * trace, sandbox hash and effects — the check a skeptical third party runs.
 */
export async function POST(req: Request) {
  try {
    const { id } = await req.json();
    const l = await readListing(BigInt(id));
    if (l.status !== Status.Disclosed) {
      return NextResponse.json({ ok: false, error: "listing is not disclosed yet" }, { status: 400 });
    }
    const target = (await listingLogs(BigInt(id))).listed.args.targetLabel as string;
    const finding = findingForTarget(target);
    if (!finding) return NextResponse.json({ ok: false, error: "artifact not found" }, { status: 404 });

    const tarball = await loadArtifact(finding);
    if (!tarball) return NextResponse.json({ ok: false, error: "artifact not found" }, { status: 404 });
    const rerun = run(tarball, finding.repro);
    const matches = {
      artifactHash: rerun.artifactHash.toLowerCase() === l.att.artifactHash.toLowerCase(),
      sandboxHash: rerun.sandboxHash.toLowerCase() === l.att.sandboxHash.toLowerCase(),
      traceHash: rerun.traceHash.toLowerCase() === l.att.traceHash.toLowerCase(),
      effects: rerun.effects === l.att.effects,
    };
    const reproduced = Object.values(matches).every(Boolean);

    return NextResponse.json({
      ok: true,
      reproduced,
      matches,
      attested: { artifactHash: l.att.artifactHash, sandboxHash: l.att.sandboxHash, traceHash: l.att.traceHash, effects: l.att.effects, effectLabels: effectList(l.att.effects).map((e) => e.label) },
      rerun: { artifactHash: rerun.artifactHash, sandboxHash: rerun.sandboxHash, traceHash: rerun.traceHash, effects: rerun.effects, effectLabels: effectList(rerun.effects).map((e) => e.label), trace: rerun.trace, captures: rerun.captures },
      expectedResult: finding.expectedResult,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
