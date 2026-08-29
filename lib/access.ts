// Shared access-gate constants and path matching.
//
// The gate is deliberately coarse: every page and API route under the Build
// Study, Playground, and Contribute namespaces requires an unlocked session,
// while the read-only browsing pages (home, datasets, study catalog, benchmark,
// agent evaluations, citation, docs, partnerships) stay open. The free pages
// read from public GitHub raw content, never from these gated APIs, so closing
// the whole prefix cannot break browsing.

export const COOKIE_NAME = "hs_unlock";

// The one promo code that unlocks the action area. Read server-side only.
export const PROMO_CODE = process.env.PROMO_CODE ?? "";

// HMAC key for the unlock token. Falls back to the promo code itself (which is
// already secret and server-only), so a single env var is enough to run.
export const ACCESS_SECRET = process.env.ACCESS_COOKIE_SECRET || PROMO_CODE;

export const TOKEN_MESSAGE = "humanstudy-hub:unlock:v1";

// 30 days.
export const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

// Pages that require an unlocked session.
const GATED_PAGES = ["/pipeline", "/playground", "/contribute"];

// API namespaces that require an unlocked session (everything here dispatches
// work, uploads, or mutates run/job state).
const GATED_API_PREFIXES = ["/api/pipeline", "/api/playground", "/api/contribute"];

export function isGatedPage(pathname: string): boolean {
  return GATED_PAGES.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

export function isGatedApi(pathname: string): boolean {
  return GATED_API_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}
