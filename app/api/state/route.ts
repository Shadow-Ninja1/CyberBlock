import { NextResponse } from "next/server";
import { marketView } from "@/lib/view";
import { tail } from "@/lib/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const since = Number(new URL(req.url).searchParams.get("since") ?? 0);
  try {
    const market = await marketView();
    return NextResponse.json({ ok: true, ...market, logs: tail(since) });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
