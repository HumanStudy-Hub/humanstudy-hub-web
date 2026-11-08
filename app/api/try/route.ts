import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { promoMatches } from "@/lib/desktop-access";
import { requireStudioUser } from "@/lib/studio/auth";
import { assertSameOrigin, readJsonBody, routeError, StudioError } from "@/lib/studio/http";
import { accessCookieFor, hasAccess, launchTryOnline, TRY_ACCESS_COOKIE, TRY_ACCESS_DAYS, TryError } from "@/lib/try-online";

export const runtime = "nodejs";
// Creating a sandbox from the snapshot and starting the app takes 5-30 s.
export const maxDuration = 90;

/**
 * Starts the signed-in user's HumanStudy Hub sandbox and returns the address to open. The first time,
 * the body carries an invitation code (the same codes as the desktop app); it is remembered per user.
 */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { user } = await requireStudioUser();
    const jar = await cookies();
    if (!hasAccess(user.id, jar.get(TRY_ACCESS_COOKIE)?.value)) {
      const body = (await readJsonBody(request, 4_000).catch(() => ({}))) as { code?: unknown };
      if (!promoMatches(body?.code)) {
        return NextResponse.json({ error: body?.code ? "invalid_code" : "code_required", message: body?.code ? "That code is not valid." : "Enter your invitation code." }, { status: 403 });
      }
      jar.set(TRY_ACCESS_COOKIE, accessCookieFor(user.id), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: TRY_ACCESS_DAYS * 86_400 });
    }
    const { url, resumed } = await launchTryOnline(user);
    return NextResponse.json({ url, resumed }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TryError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    if (!(error instanceof StudioError)) console.error("try-online launch failed", error);
    return routeError(error);
  }
}
