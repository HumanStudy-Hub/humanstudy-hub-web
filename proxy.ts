import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, isGatedApi, isGatedPage } from "./lib/access";
import { isUnlocked } from "./lib/access-edge";

// The access gate. Free (read-only) browsing passes through untouched; the
// Build Study, Playground, and Contribute areas require an unlocked session:
//   pages   -> redirect to /access?next=<path>
//   APIs    -> 401 JSON
export default async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const gatePage = isGatedPage(pathname);
  const gateApi = isGatedApi(pathname);
  if (!gatePage && !gateApi) return NextResponse.next();

  const token = request.cookies.get(COOKIE_NAME)?.value;
  const unlocked = await isUnlocked(token);

  if (unlocked) return NextResponse.next();

  if (gateApi) {
    return NextResponse.json(
      { error: "promo_code_required" },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  const url = request.nextUrl.clone();
  url.pathname = "/access";
  url.search = "";
  url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    // action pages
    "/pipeline/:path*",
    "/playground/:path*",
    "/contribute/:path*",
    // action APIs
    "/api/pipeline/:path*",
    "/api/playground/:path*",
    "/api/contribute/:path*",
  ],
};
