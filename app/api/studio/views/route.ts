import { NextResponse } from "next/server";
import { requireStudioResearchUser as requireStudioUser } from "@/lib/research-data/consent-server";
import { assertSameOrigin, readJsonBody, routeError, StudioError } from "@/lib/studio/http";
import { validateHumanProgram } from "@/lib/studio/human-program";
import { programContext, VIEW_CONTRACT, viewTemplates } from "@/lib/studio/views";

export const runtime = "nodejs";
export const maxDuration = 300;

const MODEL = process.env.STUDIO_VIEW_MODEL || "anthropic/claude-haiku-5.5";

/** Streams one generated view: the model's text as it arrives, to be split client-side by parseView. */
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await requireStudioUser();
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new StudioError(503, "views_not_configured");
    const body = await readJsonBody(request, 600_000) as { program?: unknown; studyId?: unknown; template?: unknown; request?: unknown };
    const program = validateHumanProgram(body.program);
    const template = viewTemplates.find(t => t.id === body.template);
    const ask = typeof body.request === "string" ? body.request.slice(0, 4000) : "";
    if (!template && !ask.trim()) throw new StudioError(400, "view_request_required");
    const studyId = typeof body.studyId === "string" ? body.studyId : undefined;
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "HTTP-Referer": "https://humanstudy-hub.org", "X-Title": "HumanStudy-Hub views" },
      body: JSON.stringify({
        model: MODEL, stream: true, temperature: 0.3, max_tokens: 16000,
        messages: [
          { role: "system", content: VIEW_CONTRACT },
          { role: "user", content: `Human Program:\n${programContext(program, studyId)}\n\nMake: ${[template?.instructions, ask].filter(Boolean).join("\n\nResearcher's request: ")}` },
        ],
      }),
      signal: request.signal,
    });
    if (!upstream.ok || !upstream.body) throw new StudioError(502, "view_model_failed");
    // Re-emit only the text deltas from OpenRouter's server-sent events.
    const decoder = new TextDecoder(), encoder = new TextEncoder();
    let buffer = "";
    const stream = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
          try { const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content; if (delta) controller.enqueue(encoder.encode(delta)); } catch { /* keep-alive comments and partial frames */ }
        }
      },
    }));
    return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof StudioError) return NextResponse.json({ error: error.code }, { status: error.status });
    return routeError(error);
  }
}
