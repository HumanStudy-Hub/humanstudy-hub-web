import "server-only";
import { hostedQuotaEnvironment } from "./hosted-model-quota";
import { tryServiceKey } from "./try-online-config";

/** Current per-account hosted model grant (supabase/migrations/20261123004929_invitation_allowance_v3.sql).
 *  Change these together with the grant migration. */
export const ALLOWANCE_TOTAL_MICROUSD = 10_000_000;
export const ALLOWANCE_TOTAL_REQUESTS = 3_000;

export type AllowanceRow = { remaining_microusd?: unknown; remaining_requests?: unknown; expires_at?: unknown; revoked?: unknown };
/** User-facing summary. Never carries dollar amounts. */
export type Allowance = { available: boolean; percentLeft: number; requestsLeft: number; revoked: boolean; expired: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONE: Allowance = { available: false, percentLeft: 0, requestsLeft: 0, revoked: false, expired: false };
const count = (value: unknown) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; };
const percent = (left: number, total: number) => Math.max(0, Math.min(100, Math.floor((left / total) * 100)));

/** Percent left = the smaller of dollar% and request% left, floored and clamped to 0–100; at least 1 while both
 *  remaining values are positive (never "0% left" while still usable). Revoked or expired = 0. */
export function summarizeAllowance(row: AllowanceRow | null | undefined, now = Date.now()): Allowance {
  if (!row) return NONE;
  const revoked = row.revoked !== false;
  // Postgres returns "infinity" for grants that never expire (all production grants), which Date.parse can't read.
  const raw = typeof row.expires_at === "string" ? row.expires_at.trim().toLowerCase() : "";
  const expiry = raw === "infinity" ? Infinity : raw ? Date.parse(raw) : NaN;
  const expired = Number.isNaN(expiry) || expiry <= now;
  if (revoked || expired) return { available: true, percentLeft: 0, requestsLeft: 0, revoked, expired };
  const microusd = count(row.remaining_microusd), requests = Math.floor(count(row.remaining_requests));
  return {
    available: true,
    percentLeft: microusd > 0 && requests > 0
      ? Math.max(1, Math.min(percent(microusd, ALLOWANCE_TOTAL_MICROUSD), percent(requests, ALLOWANCE_TOTAL_REQUESTS)))
      : 0,
    requestsLeft: requests, revoked, expired,
  };
}

/** Reads the account's grant row for the active quota environment (`<env>:account:<uuid>`) with the service role.
 *  Quotas off, missing row or lookup failure = not available. */
export async function accountAllowance(userId: string): Promise<Allowance> {
  const environment = hostedQuotaEnvironment();
  if (!environment || !UUID.test(userId)) return NONE;
  try {
    const key = tryServiceKey(), url = new URL(process.env.SUPABASE_URL || "");
    if (!key || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return NONE;
    const budgetKey = encodeURIComponent(`${environment}:account:${userId}`);
    const response = await fetch(`${url.origin}/rest/v1/online_dev_model_budget?select=remaining_microusd,remaining_requests,expires_at,revoked&budget_key=eq.${budgetKey}&limit=1`, {
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!response.ok) return NONE;
    const rows = await response.json().catch(() => null);
    return summarizeAllowance(Array.isArray(rows) ? rows[0] : null);
  } catch { return NONE; }
}
