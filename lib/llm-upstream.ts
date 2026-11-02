/** Upstreams for the hosted desktop models.
 *
 * Claude models go to Anthropic's OpenAI-compatible endpoint first when ANTHROPIC_API_KEY is set,
 * so prepaid Anthropic credit is used before OpenRouter. Any non-2xx answer from Anthropic
 * (credit used up, a field it does not accept, an outage) falls back to OpenRouter before a single
 * byte reaches the client, so the desktop never sees the difference. Everything else goes to
 * OpenRouter as before. */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/chat/completions";

// OpenRouter-only request fields; Anthropic rejects or ignores them.
const OPENROUTER_ONLY = ["provider", "transforms", "models", "route", "usage", "plugins", "reasoning", "user"];

/** "anthropic/claude-sonnet-5.5" -> "claude-sonnet-5-5"; null for models Anthropic does not serve. */
export function anthropicModel(model: string): string | null {
  const m = /^anthropic\/(claude-[a-z0-9.-]+)$/.exec(model);
  return m ? m[1].replace(/\./g, "-") : null;
}

/** The request body as Anthropic's compatible endpoint accepts it. */
export function anthropicBody(body: Record<string, unknown>, model: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body, model };
  for (const k of OPENROUTER_ONLY) delete out[k];
  const tools = out.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    delete out.tools;
    delete out.tool_choice;
    delete out.parallel_tool_calls;
  }
  return out;
}

export type Upstream = { response: Response; via: "anthropic" | "openrouter"; fallback?: string };

export async function chatCompletions(body: Record<string, unknown>, userId: string, signal: AbortSignal): Promise<Upstream> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const direct = anthropicKey ? anthropicModel(String(body.model)) : null;
  let fallback: string | undefined;
  if (anthropicKey && direct) {
    try {
      const response = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${anthropicKey}` },
        body: JSON.stringify(anthropicBody(body, direct)),
        signal,
      });
      if (response.ok) return { response, via: "anthropic" };
      fallback = `anthropic ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`;
    } catch (error) {
      if (signal.aborted) throw error;
      fallback = `anthropic error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
    }
  }
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "HTTP-Referer": "https://humanstudy-hub.com", "X-Title": "HumanStudy Desktop" },
    // `user` lets OpenRouter attribute usage per account without exposing an email.
    body: JSON.stringify({ ...body, user: `hsd:${userId}` }),
    signal,
  });
  return { response, via: "openrouter", fallback };
}
