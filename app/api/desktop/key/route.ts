import { NextResponse } from "next/server";
import { bearer, desktopConfigured, mintDesktopKey, promoMatches } from "@/lib/desktop-access";
import { accountInvited, rememberInvitation } from "@/lib/account-invitation";
import { grantHostedInvitation } from "@/lib/hosted-model-quota";

export const runtime = "nodejs";

/** Exchanges a signed-in Supabase session for a desktop key. An account invited at sign-up (or by an
 *  earlier redemption) needs no code; otherwise `code` is required: 403 code_required / invalid_code. */
export async function POST(request: Request) {
  const supabaseUrl = process.env.SUPABASE_URL, supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!desktopConfigured() || !supabaseUrl || !supabaseKey) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const token = bearer(request);
  if (!token) return NextResponse.json({ error: "not_signed_in" }, { status: 401 });
  const user = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${token}` }, cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<{ id?: string; email?: string; user_metadata?: { invitation_code?: unknown } }>) : null))
    .catch(() => null);
  if (!user?.id) return NextResponse.json({ error: "not_signed_in" }, { status: 401 });
  const body = ((await request.json().catch(() => null)) ?? {}) as { code?: unknown };
  const redeemed = promoMatches(body.code);
  if (!redeemed && !(await accountInvited({ id: user.id, user_metadata: user.user_metadata ?? null }))) {
    const missing = typeof body.code !== "string" || !body.code.trim();
    return NextResponse.json({ error: missing ? "code_required" : "invalid_code" }, { status: 403 });
  }
  if (!(await grantHostedInvitation(user.id))) return NextResponse.json({ error: "hosted_allowance_unavailable" }, { status: 503 });
  if (redeemed && !promoMatches(user.user_metadata?.invitation_code)) await rememberInvitation(user.id, body.code as string);
  const { key, expiresAt } = mintDesktopKey(user.id);
  return NextResponse.json({ key, expiresAt, email: user.email ?? null }, { headers: { "Cache-Control": "no-store" } });
}
