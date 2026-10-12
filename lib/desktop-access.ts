// Access for HumanStudy Desktop: a signed-in Hub account redeems the promo code once
// and receives a desktop key. The key is an HMAC-signed claim (user id, expiry) that the
// model proxy verifies without a database call; it expires after 30 days.

import { createHmac, timingSafeEqual } from "node:crypto";
import { ACCESS_SECRET, PROMO_CODE } from "./access";

export const DESKTOP_KEY_DAYS = 30;
const PREFIX = "hsd_v1";

/** Models the hosted proxy forwards. The desktop app picks its default from here. */
export const DESKTOP_MODELS = (process.env.DESKTOP_MODELS || "anthropic/claude-haiku-5.5,anthropic/claude-sonnet-5.5,deepseek/deepseek-chat")
  .split(",").map((m) => m.trim()).filter(Boolean);
export const DESKTOP_DEFAULT_MODEL = process.env.DESKTOP_DEFAULT_MODEL || DESKTOP_MODELS[0];

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (payload: string) => createHmac("sha256", ACCESS_SECRET).update(`${PREFIX}.${payload}`).digest("base64url");

export function desktopConfigured(): boolean {
  return Boolean(ACCESS_SECRET && PROMO_CODE);
}

export function mintDesktopKey(userId: string, now = Date.now()): { key: string; expiresAt: string } {
  const exp = now + DESKTOP_KEY_DAYS * 86_400_000;
  const payload = b64(JSON.stringify({ u: userId, e: exp }));
  return { key: `${PREFIX}.${payload}.${sign(payload)}`, expiresAt: new Date(exp).toISOString() };
}

/** Returns the user id of a valid, unexpired key, or null. */
export function verifyDesktopKey(key: string | null | undefined, now = Date.now()): string | null {
  if (!key || !ACCESS_SECRET) return null;
  const parts = key.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload, sig] = parts;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: unknown; e?: unknown };
    if (typeof claim.u !== "string" || typeof claim.e !== "number" || claim.e < now) return null;
    return claim.u;
  } catch {
    return null;
  }
}

/** Constant-time promo code check. */
export function promoMatches(code: unknown): boolean {
  if (typeof code !== "string" || !PROMO_CODE) return false;
  const a = Buffer.from(code.trim()), b = Buffer.from(PROMO_CODE);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearer(request: Request): string | null {
  const value = request.headers.get("authorization") || "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : null;
}
