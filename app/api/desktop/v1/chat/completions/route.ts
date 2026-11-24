import { after, NextResponse } from "next/server";
import { bearer, DESKTOP_DEFAULT_MODEL, DESKTOP_MODELS, verifyDesktopKey } from "@/lib/desktop-access";
import { usagePlansEnabled } from "@/lib/plans";
import { admit, meteredBody, meterResponse, type CallTicket, type MeterDeps } from "@/lib/usage-meter";
import { beginCall, endCall, generationCost, getAllowance } from "@/lib/usage-store";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BODY = 4_000_000;

function meterDeps(apiKey: string): MeterDeps {
  return {
    getAllowance: (userId) => getAllowance(userId),
    beginCall: (userId, limits) => beginCall(userId, limits),
    endCall: (userId, ticket, usage) => endCall(userId, ticket, usage),
    generationCost: (id) => generationCost(id, apiKey),
    available: DESKTOP_MODELS,
    serverDefault: DESKTOP_DEFAULT_MODEL,
    log: (event) => console.error(JSON.stringify(event)),
  };
}

/** OpenAI-compatible chat completions for HumanStudy Desktop, forwarded to OpenRouter with the
 * server's key. Streaming responses are passed through unchanged. With USAGE_PLANS_ENABLED=1 every
 * call is admitted against the account's monthly allowance and its reported cost is recorded. */
export async function POST(request: Request) {
  const userId = verifyDesktopKey(bearer(request));
  if (!userId) return NextResponse.json({ error: { message: "Invalid or expired desktop key", type: "invalid_api_key" } }, { status: 401 });
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: { message: "Hosted models are not configured", type: "server_error" } }, { status: 503 });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: { message: "Request too large", type: "invalid_request_error" } }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: { message: "Invalid JSON", type: "invalid_request_error" } }, { status: 400 }); }
  if (typeof body.model !== "string" || !DESKTOP_MODELS.includes(body.model)) {
    return NextResponse.json({ error: { message: `Model not available. Use one of: ${DESKTOP_MODELS.join(", ")}`, type: "invalid_request_error" } }, { status: 400 });
  }
  const metered = usagePlansEnabled();
  const deps = metered ? meterDeps(apiKey) : null;
  let ticket: CallTicket | null = null;
  if (deps) {
    const admitted = await admit(userId, body.model, deps);
    const { refusal } = admitted;
    ticket = admitted.ticket ?? null;
    if (refusal) {
      console.log(JSON.stringify({ event: "desktop_llm_refused", user: userId, model: body.model, code: refusal.body.error.code }));
      return NextResponse.json(refusal.body, { status: refusal.status, headers: { "Cache-Control": "no-store" } });
    }
  }
  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "HTTP-Referer": "https://humanstudy-hub.com", "X-Title": "HumanStudy Desktop" },
    // `user` lets OpenRouter attribute usage per account without exposing an email.
    body: JSON.stringify(deps ? meteredBody(body, userId) : { ...body, user: `hsd:${userId}` }),
    // Metered calls are read to the end even if the client leaves (the cost comes last and is billed
    // anyway), so the client's abort is not passed upstream; max_tokens and maxDuration bound them.
    ...(deps ? {} : { signal: request.signal }),
  }).catch((error) => error as Error);
  if (upstream instanceof Error) {
    if (deps && ticket) after(deps.endCall(userId, ticket, { costUsd: 0, promptTokens: 0, completionTokens: 0 }).catch(() => undefined));
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return NextResponse.json({ error: { message: "Could not reach the model provider. Please try again.", type: "server_error" } }, { status: 502 });
  }
  console.log(JSON.stringify({ event: "desktop_llm", user: userId, model: body.model, stream: Boolean(body.stream), status: upstream.status }));
  let out: BodyInit | null = upstream.body;
  if (deps && ticket) {
    const { body: passed, done } = meterResponse(upstream, userId, Boolean(body.stream), ticket, deps);
    out = passed;
    after(done);
  }
  return new Response(out, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") || "application/json", "Cache-Control": "no-store" },
  });
}
