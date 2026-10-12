import { NextResponse } from "next/server";
import { bearer, desktopConfigured, mintDesktopKey, promoMatches } from "@/lib/desktop-access";

export const runtime = "nodejs";

/** Exchanges a signed-in Supabase session plus the promo code for a desktop key. */
export async function POST(request: Request) {
  const supabaseUrl = process.env.SUPABASE_URL, supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!desktopConfigured() || !supabaseUrl || !supabaseKey) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const token = bearer(request);
  if (!token) return NextResponse.json({ error: "not_signed_in" }, { status: 401 });
  const user = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${token}` }, cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<{ id?: string; email?: string }>) : null))
    .catch(() => null);
  if (!user?.id) return NextResponse.json({ error: "not_signed_in" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { code?: unknown };
  if (!promoMatches(body.code)) return NextResponse.json({ error: "invalid_code" }, { status: 403 });
  const { key, expiresAt } = mintDesktopKey(user.id);
  return NextResponse.json({ key, expiresAt, email: user.email ?? null }, { headers: { "Cache-Control": "no-store" } });
}
