import "server-only";
import { randomUUID } from "node:crypto";
import { tryServiceKey } from "./try-online-config";

export type QuotaEnvironment = "dev" | "production";
/** Explicit rollout only. Never accept environment/account scope from request JSON. */
export function hostedQuotaEnvironment(): QuotaEnvironment | null {
  if (process.env.HOSTED_MODEL_QUOTAS !== "1") return null;
  if (process.env.VERCEL_ENV === "production") return "production";
  if (process.env.VERCEL_ENV === "preview" && process.env.VERCEL_GIT_COMMIT_REF === "dev") return "dev";
  return null;
}
async function rpc(name: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  try {
    const key = tryServiceKey(), url = new URL(process.env.SUPABASE_URL || "");
    if (!key || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
    const response = await fetch(url.origin + `/rest/v1/rpc/${name}`, {
      method: "POST", redirect: "error", cache: "no-store",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return response.ok ? await response.json() : false;
  } catch { return false; }
}
export async function reserveHostedCompletion(account: string, model: string, amount: number, signal: AbortSignal): Promise<string | null> {
  const environment = hostedQuotaEnvironment();
  if (!environment || !Number.isSafeInteger(amount) || amount <= 0) return null;
  const id = randomUUID();
  return await rpc("online_reserve_account_model_budget", {
    request_id: id, budget_environment: environment, account_id: account, model_id: model, reservation_microusd: amount,
  }, signal) === true ? id : null;
}
/** Internal only: caller must establish complete authoritative provider usage. Not exposed as an HTTP route.
 * The provider observer calls this only after verified complete usage; missing/uncertain usage retains its reservation. */
export async function settleHostedCompletion(requestId: string, actualMicrousd: number): Promise<boolean> {
  const environment = hostedQuotaEnvironment();
  if (!environment || !Number.isSafeInteger(actualMicrousd) || actualMicrousd < 0) return false;
  return await rpc("online_settle_account_model_budget", { request_id: requestId, budget_environment: environment, actual_microusd: actualMicrousd }) === true;
}

export async function hostedModelsForAccount(account: string): Promise<string[]> {
  const environment = hostedQuotaEnvironment();
  if (!environment) return [];
  const result = await rpc("online_account_model_access", { budget_environment: environment, account_id: account });
  return Array.isArray(result) && result.every(value => typeof value === "string") ? result : [];
}
