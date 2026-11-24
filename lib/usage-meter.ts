// Metering for the hosted model route: admit a call against the account's plan before it is forwarded
// (an atomic reservation in the database), then replace the reservation with what OpenRouter reports
// the call cost. Dependencies are injected so the logic is tested without a database or a provider.

import { PLANS } from "./plans-config";
import type { BeginResult, CallTicket } from "./usage-store";
import { exhaustedMessage, modelNotInPlanMessage, planModels, SseUsageScanner, usageFrom, type AllowanceStatus, type MeteredUsage } from "./plans";

export type { BeginResult, CallTicket };

export type MeterDeps = {
  getAllowance(userId: string): Promise<AllowanceStatus>;
  beginCall(userId: string, limits: { limitUsd: number; reserveUsd: number; maxInflight: number }): Promise<BeginResult>;
  endCall(userId: string, ticket: CallTicket, usage: MeteredUsage & { costUsd: number }): Promise<void>;
  /** Cost lookup by generation id, for replies that carried none. */
  generationCost(id: string): Promise<MeteredUsage | null>;
  available: string[];
  serverDefault: string;
  log?(event: Record<string, unknown>): void;
};

export type Refusal = { status: number; body: { error: Record<string, unknown> } };

const refusal = (status: number, error: Record<string, unknown>): Refusal => ({ status, body: { error } });
const UNAVAILABLE = () => refusal(503, { message: "Usage accounting is unavailable right now. Please try again in a few minutes.", type: "server_error", code: "usage_unavailable" });

function exhausted(allowance: AllowanceStatus): Refusal {
  // 402, not 429: clients retry a 429, and retrying cannot help until the month renews.
  return refusal(402, { message: exhaustedMessage(allowance), message_zh: exhaustedMessage(allowance, "zh"), type: "insufficient_quota", code: "allowance_exhausted", plan: allowance.plan, used_usd: allowance.usedUsd, limit_usd: allowance.limitUsd, renews_at: allowance.renewsAt });
}

/** `ticket` set: forward the call. Otherwise the OpenAI-shaped error to return instead.
 *  Fails closed: without the ledger nothing bounds spend. */
export async function admit(userId: string, model: string, deps: MeterDeps): Promise<{ refusal: Refusal; ticket?: undefined } | { refusal: null; ticket: CallTicket }> {
  let allowance: AllowanceStatus;
  try { allowance = await deps.getAllowance(userId); } catch { return { refusal: UNAVAILABLE() }; }
  const { models } = planModels(allowance.plan, deps.available, deps.serverDefault);
  if (!models.includes(model)) {
    return { refusal: refusal(403, { message: modelNotInPlanMessage(model, allowance.plan, models), message_zh: modelNotInPlanMessage(model, allowance.plan, models, "zh"), type: "invalid_request_error", code: "model_not_in_plan", plan: allowance.plan, models }) };
  }
  if (allowance.exhausted) return { refusal: exhausted(allowance) };
  const plan = PLANS[allowance.plan];
  let begun: BeginResult;
  try {
    begun = await deps.beginCall(userId, { limitUsd: plan.monthlyBudgetUsd, reserveUsd: plan.reservePerCallUsd, maxInflight: plan.maxConcurrentCalls });
  } catch { return { refusal: UNAVAILABLE() }; }
  if (begun.ok) return { refusal: null, ticket: begun.ticket };
  if (begun.reason === "busy") {
    return { refusal: refusal(429, { message: "Too many requests at once for this account. Please wait a moment and try again.", message_zh: "此账户同时进行的请求过多，请稍后再试。", type: "rate_limit_error", code: "too_many_in_flight" }) };
  }
  return { refusal: exhausted({ ...allowance, usedUsd: Math.max(begun.usedUsd, allowance.usedUsd), exhausted: true }) };
}

/** OpenRouter routing fields that could reach a model other than the one admitted. */
const ROUTING_FIELDS = ["models", "route", "preset"];

/** The upstream request body: the client's, with usage accounting on and routing fields removed. */
export function meteredBody(body: Record<string, unknown>, userId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, user: `hsd:${userId}`, usage: { include: true } };
  for (const field of ROUTING_FIELDS) delete out[field];
  if (body.stream) {
    const opts = body.stream_options && typeof body.stream_options === "object" ? body.stream_options : {};
    out.stream_options = { ...opts, include_usage: true };
  }
  return out;
}

async function settle(userId: string, ticket: CallTicket, found: MeteredUsage | null, deps: MeterDeps): Promise<void> {
  let usage = found;
  if (usage && usage.costUsd === undefined && usage.id) usage = (await deps.generationCost(usage.id).catch(() => null)) ?? usage;
  let charge: MeteredUsage & { costUsd: number };
  if (usage && usage.costUsd !== undefined) charge = { ...usage, costUsd: usage.costUsd };
  else {
    // No cost anywhere: charge the reservation, so an unpriced call is never free.
    charge = { id: usage?.id, costUsd: ticket.reserveUsd, promptTokens: usage?.promptTokens ?? 0, completionTokens: usage?.completionTokens ?? 0 };
    deps.log?.({ event: "usage_unpriced_charged_reserve", user: userId, generation: usage?.id ?? null, cost: ticket.reserveUsd });
  }
  try {
    await deps.endCall(userId, ticket, charge);
  } catch (error) {
    // The reservation stays counted until it goes stale (10 minutes), then this cost is lost: log it.
    deps.log?.({ event: "usage_record_failed", user: userId, generation: charge.id ?? null, cost: charge.costUsd, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Passes the upstream response to the client unchanged and charges its cost. `done` settles once
 * the cost is recorded; hand it to `after()` so the function stays alive for it.
 *
 * The upstream body is always read to its end, even when the client goes away: the usage block comes
 * last, and OpenRouter bills a generation that has started. (So the route must not pass the client's
 * abort signal upstream.) A failed upstream response is not billed by OpenRouter: the reservation is
 * released at no cost.
 */
export function meterResponse(upstream: Response, userId: string, stream: boolean, ticket: CallTicket, deps: MeterDeps): { body: BodyInit | null; done: Promise<void> } {
  if (!upstream.ok || !upstream.body) {
    const done = deps.endCall(userId, ticket, { costUsd: 0, promptTokens: 0, completionTokens: 0 })
      .catch((error) => deps.log?.({ event: "usage_release_failed", user: userId, error: error instanceof Error ? error.message : String(error) }));
    return { body: upstream.body, done: Promise.resolve(done).then(() => undefined) };
  }
  if (!stream) {
    const text = upstream.text();
    const done = text.then(
      (t) => { let parsed: unknown = null; try { parsed = JSON.parse(t); } catch { /* not JSON */ } return settle(userId, ticket, usageFrom(parsed), deps); },
      () => settle(userId, ticket, null, deps),
    );
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        try { controller.enqueue(new TextEncoder().encode(await text)); controller.close(); }
        catch (error) { controller.error(error); }
      },
    });
    return { body: readable, done };
  }
  const scanner = new SseUsageScanner();
  const reader = upstream.body.getReader();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  let settled = false;
  const close = () => { if (settled) return; settled = true; void settle(userId, ticket, scanner.end(), deps).finally(finish); };
  /** The client is gone: keep reading upstream (bounded by max_tokens and maxDuration) for the usage chunk. */
  const drain = async () => {
    try { for (;;) { const { value, done: ended } = await reader.read(); if (ended) break; scanner.push(value); } } catch { /* upstream failed */ }
    close();
  };
  const readable = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done: ended } = await reader.read();
        if (ended) { controller.close(); close(); return; }
        scanner.push(value);
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        close();
      }
    },
    cancel() { void drain(); },
  });
  return { body: readable, done };
}
