import { NextResponse } from "next/server";
import { bearer, DESKTOP_DEFAULT_MODEL, DESKTOP_MODELS, verifyDesktopKey } from "@/lib/desktop-access";
import { planModels, usagePlansEnabled } from "@/lib/plans";
import { PLANS } from "@/lib/plans-config";
import { getAllowance } from "@/lib/usage-store";

export const runtime = "nodejs";

/** Public values the desktop app needs to sign in to the same Supabase project as the website.
 *  With usage plans on and a desktop key presented, the model list is the account's plan's, and the
 *  response carries the plan and this month's usage (private, never cached). */
export async function GET(request: Request) {
  const supabaseUrl = process.env.SUPABASE_URL, supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!supabaseUrl || !supabaseKey) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const base = { supabaseUrl, supabaseKey, defaultModel: DESKTOP_DEFAULT_MODEL, models: DESKTOP_MODELS, ...(process.env.STUDIO_AUTH_ORIGIN ? { authOrigin: process.env.STUDIO_AUTH_ORIGIN } : {}) };
  const userId = usagePlansEnabled() ? verifyDesktopKey(bearer(request)) : null;
  if (userId) {
    const allowance = await getAllowance(userId).catch(() => null);
    if (allowance) {
      const { models, defaultModel } = planModels(allowance.plan, DESKTOP_MODELS, DESKTOP_DEFAULT_MODEL);
      const p = PLANS[allowance.plan];
      return NextResponse.json(
        { ...base, plans: true, models, defaultModel, plan: { id: allowance.plan, label: p.label, maxParticipantsPerArm: p.maxParticipantsPerArm, batchAcrossModels: p.batchAcrossModels, priority: p.priority }, usage: allowance },
        { headers: { "Cache-Control": "private, no-store", Vary: "Authorization" } },
      );
    }
  }
  // `plans` tells the desktop it may claim a Free key without a code.
  const body = usagePlansEnabled() ? { ...base, plans: true } : base;
  return NextResponse.json(body, { headers: usagePlansEnabled() ? { "Cache-Control": bearer(request) ? "private, no-store" : "public, max-age=300", Vary: "Authorization" } : { "Cache-Control": "public, max-age=300" } });
}
