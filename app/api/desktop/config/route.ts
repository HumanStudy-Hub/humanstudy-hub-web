import { NextResponse } from "next/server";
import { DESKTOP_DEFAULT_MODEL, DESKTOP_MODELS } from "@/lib/desktop-access";

export const runtime = "nodejs";

/** Public values the desktop app needs to sign in to the same Supabase project as the website. */
export async function GET() {
  const supabaseUrl = process.env.SUPABASE_URL, supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  return NextResponse.json({ supabaseUrl, supabaseKey, defaultModel: DESKTOP_DEFAULT_MODEL, models: DESKTOP_MODELS, ...(process.env.STUDIO_AUTH_ORIGIN ? { authOrigin: process.env.STUDIO_AUTH_ORIGIN } : {}) }, { headers: { "Cache-Control": "public, max-age=300" } });
}
