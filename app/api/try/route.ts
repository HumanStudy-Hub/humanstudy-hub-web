import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME } from "@/lib/access";
import { isUnlocked } from "@/lib/access-edge";
import { requireStudioUser } from "@/lib/studio/auth";
import { assertSameOrigin, routeError, StudioError } from "@/lib/studio/http";
import { launchTryOnline, TryError } from "@/lib/try-online";

export const runtime = "nodejs";
// Creating a sandbox from the snapshot and starting the app takes ~15-30 s.
export const maxDuration = 60;

/** Starts the signed-in user's HumanStudy Hub sandbox and returns the address to open. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { user } = await requireStudioUser();
    // Hosted models follow the same rule as the desktop key: the user has entered the invitation code.
    const unlocked = await isUnlocked((await cookies()).get(COOKIE_NAME)?.value);
    const { url, resumed } = await launchTryOnline(user, unlocked);
    return NextResponse.json({ url, resumed }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TryError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
    if (!(error instanceof StudioError)) console.error("try-online launch failed", error);
    return routeError(error);
  }
}
