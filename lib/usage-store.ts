// Usage metering storage (Supabase, service role). Server-side only: never takes a user token, and the
// tables have no write policies for users (supabase/migrations/20261109120000_usage_plans.sql).

import { allowanceStatus, periodStart, type AllowanceStatus, type MeteredUsage } from "./plans";

type Fetch = typeof fetch;

export function usageStoreConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export class UsageStoreError extends Error {}

async function rpc<T>(name: string, args: Record<string, unknown>, f: Fetch): Promise<T> {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new UsageStoreError("Usage accounting is not configured.");
  const response = await f(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    cache: "no-store",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new UsageStoreError(`Usage accounting request failed (${response.status}).`);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** The account's plan and this month's spend. */
export async function getAllowance(userId: string, now = Date.now(), f: Fetch = fetch): Promise<AllowanceStatus> {
  const row = await rpc<{ plan?: unknown; used_usd?: unknown } | null>("model_allowance", { p_user: userId, p_period: periodStart(now) }, f);
  return allowanceStatus({ plan: row?.plan, usedUsd: row?.used_usd, now });
}

export type CallTicket = { call: string; period: string; reserveUsd: number };
export type BeginResult = { ok: true; ticket: CallTicket } | { ok: false; reason: "busy" | "exhausted"; usedUsd: number };

/** Atomically admits one call against the plan's limits and reserves `reserveUsd` for it. */
export async function beginCall(userId: string, limits: { limitUsd: number; reserveUsd: number; maxInflight: number }, now = Date.now(), f: Fetch = fetch): Promise<BeginResult> {
  const period = periodStart(now);
  const row = await rpc<{ ok?: unknown; call?: unknown; reason?: unknown; used_usd?: unknown } | null>("begin_model_call", {
    p_user: userId, p_period: period, p_limit: limits.limitUsd, p_reserve: limits.reserveUsd, p_max_inflight: limits.maxInflight, p_stale_seconds: 600,
  }, f);
  if (row?.ok === true && typeof row.call === "string") return { ok: true, ticket: { call: row.call, period, reserveUsd: limits.reserveUsd } };
  if (row?.ok === false && (row.reason === "busy" || row.reason === "exhausted")) return { ok: false, reason: row.reason, usedUsd: Number(row.used_usd) || 0 };
  throw new UsageStoreError("Unexpected usage accounting reply.");
}

/** Releases a call's reservation and charges its cost to the month it was admitted in. */
export async function endCall(userId: string, ticket: CallTicket, usage: MeteredUsage & { costUsd: number }, f: Fetch = fetch): Promise<void> {
  await rpc("end_model_call", {
    p_call: ticket.call, p_user: userId, p_period: ticket.period, p_cost: usage.costUsd, p_prompt: usage.promptTokens, p_completion: usage.completionTokens,
  }, f);
}

/** When a reply carried no cost (a stream the client closed early), OpenRouter's generation record
 *  has it. The record appears shortly after the call, so this retries a few times. */
export async function generationCost(id: string, apiKey: string, f: Fetch = fetch, waitMs = [1000, 3000, 8000, 15000]): Promise<MeteredUsage | null> {
  for (const wait of waitMs) {
    await new Promise((r) => setTimeout(r, wait));
    try {
      const r = await f(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      if (!r.ok) continue;
      const body = (await r.json()) as { data?: { total_cost?: unknown; tokens_prompt?: unknown; tokens_completion?: unknown } };
      const cost = Number(body.data?.total_cost);
      if (!Number.isFinite(cost) || cost < 0) continue;
      const n = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);
      return { id, costUsd: cost, promptTokens: n(body.data?.tokens_prompt), completionTokens: n(body.data?.tokens_completion) };
    } catch { /* retry */ }
  }
  return null;
}
