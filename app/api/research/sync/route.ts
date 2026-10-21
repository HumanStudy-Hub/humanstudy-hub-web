import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Trusted Bench worker only. The caller can select a commit, never an arbitrary fetch URL. */
export async function POST(request: Request) {
  const secret = process.env.RESEARCH_INDEX_SYNC_SECRET;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /i, "") || "";
  const expected = Buffer.from(secret || ""), given = Buffer.from(supplied);
  if (!secret || expected.length !== given.length || !timingSafeEqual(expected, given))
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  let sourceCommit: string;
  try {
    const body = await request.text();
    if (body.length > 1024) throw new Error("oversize");
    sourceCommit = JSON.parse(body).sourceCommit;
    if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("invalid commit");
  } catch { return NextResponse.json({ error: "An exact source commit is required." }, { status: 400 }); }
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "Research storage is not configured." }, { status: 503 });
  try {
    const source = await fetch(`https://raw.githubusercontent.com/HumanStudy-Hub/HumanStudy-Bench/${sourceCommit}/co_website/data/research_index.json`, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!source.ok) throw new Error("source unavailable");
    const payload = await source.json();
    if (payload.schemaVersion !== 1 || !Array.isArray(payload.papers)) throw new Error("invalid source catalog");
    const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
    const state = await fetch(`${url}/rest/v1/research_catalog_state?select=snapshot&id=eq.true`, { headers, cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!state.ok) throw new Error("storage unavailable");
    const previous = (await state.json())[0]?.snapshot ?? null;
    const result = await fetch(`${url}/rest/v1/rpc/publish_research_catalog`, { method: "POST", headers, cache: "no-store",
      signal: AbortSignal.timeout(25000), body: JSON.stringify({ payload, expected_snapshot: previous }) });
    if (!result.ok) return NextResponse.json({ error: "Catalog changed or failed validation. Retry against the current source." }, { status: 409 });
    return NextResponse.json({ snapshot: await result.json(), papers: payload.papers.length, sourceCommit });
  } catch { return NextResponse.json({ error: "Research catalog sync did not complete. The previous snapshot is retained." }, { status: 503 }); }
}
