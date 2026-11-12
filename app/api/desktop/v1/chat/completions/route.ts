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
  if (process.env.VERCEL_ENV === "preview" && (!dev || !devModelAccess(userId))) {
    return NextResponse.json({ error: { message: "Dev model access is disabled for this account", type: "server_error" } }, { status: 503 });
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: { message: "Hosted models are not configured", type: "server_error" } }, { status: 503 });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: { message: "Request too large", type: "invalid_request_error" } }, { status: 413 });
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: { message: "Invalid JSON", type: "invalid_request_error" } }, { status: 400 }); }
  if (!body || typeof body.model !== "string" || !DESKTOP_MODELS.includes(body.model)) {
    return NextResponse.json({ error: { message: `Model not available. Use one of: ${DESKTOP_MODELS.join(", ")}`, type: "invalid_request_error" } }, { status: 400 });
  }
  let wire = JSON.stringify({ ...body, user: `hsd:${userId}` });
  if (dev) {
    const bounded = boundedDevCompletion(body, userId);
    if (!bounded) return NextResponse.json({ error: { message: "Request is outside the dev model test limits", type: "invalid_request_error" } }, { status: 400 });
    if (!(await reserveDevCompletion(userId, bounded.model, bounded.reservationMicrousd, request.signal))) {
      return NextResponse.json({ error: { message: "Dev model allowance is unavailable or exhausted", type: "rate_limit_error" } }, { status: 429 });
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
  console.log(JSON.stringify({ event: "desktop_llm", user: userId, model: body.model, stream: Boolean(body.stream), status: upstream.status }));
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("content-type") || "application/json", "Cache-Control": "no-store" },
  });
}
