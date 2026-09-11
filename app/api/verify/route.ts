import { NextResponse } from "next/server";
import { readListing, listingLogs } from "@/lib/chain";
import { findingForTarget } from "@/lib/agents";
import { analyzeFile } from "@/lib/detector";
import { Status } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Independent re-verification of a disclosed listing. Re-runs the committed
 * detector against the artifact and reports whether the re-run reproduces the
 * attested grade — the check a skeptical third party would run on the oracle.
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

    const rerun = analyzeFile(finding.target.artifact);
    const matches = {
      artifactHash: rerun.artifactHash.toLowerCase() === l.att.artifactHash.toLowerCase(),
      detectorHash: rerun.detectorHash.toLowerCase() === l.att.detectorHash.toLowerCase(),
      severity: rerun.severity === l.att.severity,
      vulnClass: rerun.vulnClass === l.att.vulnClass,
    };
    const reproduced = Object.values(matches).every(Boolean);

    return NextResponse.json({
      ok: true,
      reproduced,
      matches,
      attested: {
        artifactHash: l.att.artifactHash,
        detectorHash: l.att.detectorHash,
        severity: l.att.severity,
        vulnClass: l.att.vulnClass,
      },
      rerun: {
        artifactHash: rerun.artifactHash,
        detectorHash: rerun.detectorHash,
        severity: rerun.severity,
        vulnClass: rerun.vulnClass,
        signals: rerun.signals.map((s) => ({ rule: s.rule, file: s.file, evidence: s.evidence })),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
