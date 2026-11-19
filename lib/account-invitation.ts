import "server-only";
import { promoMatches } from "./desktop-access";
import { tryServiceKey } from "./try-online-config";

// An account enters its invitation code once, at sign-up (stored as user metadata
// `invitation_code`) or at its first redemption (which creates the production budget
// row, unless revoked). Either record admits the account on any device without asking again.

type InvitableUser = { id: string; user_metadata?: { invitation_code?: unknown } | null };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function service(): { origin: string; key: string } | null {
  try {
    const key = tryServiceKey(), url = new URL(process.env.SUPABASE_URL || "");
    if (!key || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return { origin: url.origin, key };
  } catch { return null; }
}

async function call(path: string, init: RequestInit = {}): Promise<Response | null> {
  const s = service();
  if (!s) return null;
  try {
    return await fetch(s.origin + path, {
      ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
      headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, "Content-Type": "application/json" },
    });
  } catch { return null; }
}

async function hasProductionGrant(id: string): Promise<boolean> {
  const response = await call(`/rest/v1/online_dev_model_budget?select=budget_key&budget_key=eq.${encodeURIComponent(`production:account:${id}`)}&revoked=is.false`);
  if (!response?.ok) return false;
  const rows = await response.json().catch(() => null);
  return Array.isArray(rows) && rows.length > 0;
}

async function metadataCode(user: InvitableUser): Promise<unknown> {
  if (user.user_metadata) return user.user_metadata.invitation_code;
  const response = await call(`/auth/v1/admin/users/${user.id}`);
  if (!response?.ok) return undefined;
  const body = (await response.json().catch(() => null)) as { user_metadata?: { invitation_code?: unknown } } | null;
  return body?.user_metadata?.invitation_code;
}

/** True when this account already redeemed an invitation, at sign-up or later. Service role only. */
export async function accountInvited(user: InvitableUser): Promise<boolean> {
  if (!UUID.test(user.id)) return false;
  if (promoMatches(await metadataCode(user))) return true;
  return hasProductionGrant(user.id);
}

/** Best effort: remember a code redeemed after sign-up so the account is not asked again. */
export async function rememberInvitation(id: string, code: string): Promise<void> {
  if (!UUID.test(id) || !promoMatches(code)) return;
  await call(`/auth/v1/admin/users/${id}`, { method: "PUT", body: JSON.stringify({ user_metadata: { invitation_code: code.trim() } }) });
}
