/**
 * Novelty check against OSV (osv.dev), the aggregate feed behind GHSA and npm audit.
 *
 * This is the one thing the market cannot decide for itself: whether a finding is
 * already public. If OSV already lists the package version, the seller is trying to
 * resell a known problem, the oracle refuses to attest, and no listing exists.
 */
import type { NoveltyResult } from "./types";

const OSV_QUERY = "https://api.osv.dev/v1/query";

export interface NpmTarget {
  name: string;
  version: string;
}

export async function checkNovelty(target: NpmTarget, now = new Date()): Promise<NoveltyResult> {
  const checkedAt = now.toISOString();
  try {
    const res = await fetch(OSV_QUERY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        package: { name: target.name, ecosystem: "npm" },
        version: target.version,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return { novel: false, osvIds: [], checkedAt, error: `OSV returned HTTP ${res.status}` };
    }

    const body = (await res.json()) as { vulns?: Array<{ id: string; aliases?: string[] }> };
    const vulns = body.vulns ?? [];
    const osvIds = vulns
      .flatMap((v) => [v.id, ...(v.aliases ?? [])])
      .filter((id, i, a) => a.indexOf(id) === i)
      .sort();

    return { novel: osvIds.length === 0, osvIds, checkedAt };
  } catch (e) {
    // Fail closed: an unreachable feed means we cannot claim novelty.
    return {
      novel: false,
      osvIds: [],
      checkedAt,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Weekly download count, used as the blast-radius input to the on-chain pricing
 * rule. Unknown packages (including local demo fixtures) get 0, which prices the
 * finding at its floor rather than failing the listing.
 */
export async function weeklyDownloads(name: string): Promise<number> {
  try {
    const res = await fetch(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return 0;
    const body = (await res.json()) as { downloads?: number };
    return typeof body.downloads === "number" ? body.downloads : 0;
  } catch {
    return 0;
  }
}

/** The registry's own content hash for a published tarball, when there is one. */
export async function registryTarball(
  target: NpmTarget,
): Promise<{ tarballUrl: string; integrity?: string } | null> {
  try {
    const res = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(target.name)}/${encodeURIComponent(target.version)}`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { dist?: { tarball?: string; integrity?: string } };
    if (!body.dist?.tarball) return null;
    return { tarballUrl: body.dist.tarball, integrity: body.dist.integrity };
  } catch {
    return null;
  }
}
