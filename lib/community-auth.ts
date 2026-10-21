import { NextResponse } from "next/server";
import { bearer } from "./desktop-access";
import { requireStudioUser } from "./studio/auth";
import { assertSameOrigin } from "./studio/http";

/** Same check as /api/desktop/key: the bearer token must be a live Supabase session. */
export async function requireHubUser(request: Request): Promise<{ id: string; email: string | null } | NextResponse> {
  if (!bearer(request)) {
    try {
      assertSameOrigin(request);
      const { user } = await requireStudioUser();
      return { id: user.id, email: user.email ?? null };
    } catch { return fail(401, "not_signed_in", "Sign in to HumanStudy Hub to contribute."); }
  }
  const supabaseUrl = process.env.SUPABASE_URL, supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) return NextResponse.json({ error: "not_configured", message: "Community publishing is not set up on this server yet." }, { status: 503 });
  const token = bearer(request);
  if (!token) return NextResponse.json({ error: "not_signed_in", message: "Sign in to HumanStudy Hub to publish." }, { status: 401 });
  const user = await fetch(`${supabaseUrl}/auth/v1/user`, { headers: { apikey: supabaseKey, Authorization: `Bearer ${token}` }, cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<{ id?: string; email?: string }>) : null))
    .catch(() => null);
  if (!user?.id) return NextResponse.json({ error: "not_signed_in", message: "Your sign-in has expired. Sign in again and retry." }, { status: 401 });
  return { id: user.id, email: user.email ?? null };
}

export function fail(status: number, error: string, message: string) {
  return NextResponse.json({ error, message }, { status });
}
