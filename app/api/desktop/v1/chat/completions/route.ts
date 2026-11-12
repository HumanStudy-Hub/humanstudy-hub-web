import { withProviderUsageSettlement } from "@/lib/provider-usage-settlement";
import { hostedQuotaEnvironment, reserveHostedCompletion, settleHostedCompletion } from "@/lib/hosted-model-quota";
import { readBoundedText } from "@/lib/bounded-request";
import { NextResponse } from "next/server";
import { bearer, DESKTOP_MODELS, verifyDesktopKey } from "@/lib/desktop-access";
import { devModelAccess, isDevPreview } from "@/lib/try-dev-models";
import { boundedDevCompletion, reserveDevCompletion } from "@/lib/try-dev-model-budget";

export const runtime = "nodejs";
export const maxDuration = 300;

const MAX_BODY = 4_000_000;

/** OpenAI-compatible chat completions for HumanStudy Desktop, forwarded to OpenRouter with the
 * server's key. Streaming responses are passed through unchanged. */
export async function POST(request: Request) {
  const userId = verifyDesktopKey(bearer(request));
  if (!userId) return NextResponse.json({ error: { message: "Invalid or expired desktop key", type: "invalid_api_key" } }, { status: 401 });
  const dev = isDevPreview();
  const quota = hostedQuotaEnvironment();
  if (process.env.HOSTED_MODEL_QUOTAS && process.env.HOSTED_MODEL_QUOTAS !== "0" && !quota) return NextResponse.json({ error: { message: "Hosted allowance configuration is unavailable", type: "server_error" } }, { status: 503 });
  if (process.env.VERCEL_ENV === "preview" && (!dev || (!quota && !devModelAccess(userId)))) {
    return NextResponse.json({ error: { message: "Dev model access is disabled for this account", type: "server_error" } }, { status: 503 });
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: { message: "Hosted models are not configured", type: "server_error" } }, { status: 503 });
  let raw: string | null;
  try { raw = await readBoundedText(request, MAX_BODY); } catch { return NextResponse.json({ error: { message: "Invalid request body", type: "invalid_request_error" } }, { status: 400 }); }
  if (raw === null) return NextResponse.json({ error: { message: "Request too large", type: "invalid_request_error" } }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: { message: "Invalid JSON", type: "invalid_request_error" } }, { status: 400 }); }
  if (!body || typeof body.model !== "string" || !DESKTOP_MODELS.includes(body.model)) {
    return NextResponse.json({ error: { message: `Model not available. Use one of: ${DESKTOP_MODELS.join(", ")}`, type: "invalid_request_error" } }, { status: 400 });
  }
  let reservationId: string | undefined;
  let wire = JSON.stringify({ ...body, user: `hsd:${userId}` });
  if (dev || quota) {
    const bounded = boundedDevCompletion(body, userId);
    if (!bounded) return NextResponse.json({ error: { message: "Request is outside supported hosted model limits", type: "invalid_request_error" } }, { status: 400 });
    const reserved = quota
      ? await reserveHostedCompletion(userId, bounded.model, bounded.reservationMicrousd, request.signal)
      : await reserveDevCompletion(userId, bounded.model, bounded.reservationMicrousd, request.signal);
    if (!reserved) {
      return NextResponse.json({ error: { message: "Hosted model allowance is unavailable or exhausted; saved work is unchanged", type: "rate_limit_error" } }, { status: 429 });
    }
    if (quota && typeof reserved === "string") {
      reservationId = reserved;
      console.log(JSON.stringify({ event: "hosted_model_reserved", reservationId, user: userId, environment: quota, model: bounded.model }));
    }
    wire = bounded.wire;
  }
  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "HTTP-Referer": "https://humanstudy-hub.com", "X-Title": "HumanStudy Desktop" },
    // `user` lets OpenRouter attribute usage per account without exposing an email.
    body: wire,
    signal: request.signal,
  });
  console.log(JSON.stringify({ event: "desktop_llm", reservationId, upstreamRequestId: upstream.headers.get("x-request-id") ?? undefined, user: userId, model: body.model, stream: Boolean(body.stream), status: upstream.status }));
  const responseBody = reservationId ? withProviderUsageSettlement(upstream, {
    streaming: body.stream === true, signal: request.signal,
    settle: actual => settleHostedCompletion(reservationId!, actual),
    report: outcome => console.log(JSON.stringify({ event: "hosted_model_accounting", reservationId, ...outcome })),
  }) : upstream.body;
  return new Response(responseBody, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") || "application/json", "Cache-Control": "no-store" },
  });
}
