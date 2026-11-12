import { tryServiceKey } from "./try-online-config";

// Conservative USD per million tokens, including a margin for input cache writes.
const prices = new Map([
  ["anthropic/claude-haiku-5.5", { input: 1, output: 2.5 }],
  ["deepseek/deepseek-v4.1-flash-1017", { input: 0.6, output: 1.2 }],
]);
export const BOUNDED_HOSTED_MODELS = [...prices.keys()];
const MAX_INPUT_BYTES = 4_000_000;
const MAX_OUTPUT_TOKENS = 32_768;
const FORMAT_OVERHEAD_TOKENS = 4096;
const supportedFields = new Set([
  "model", "messages", "tools", "tool_choice", "parallel_tool_calls", "temperature", "top_p", "top_k",
  "frequency_penalty", "presence_penalty", "seed", "stop", "reasoning", "reasoning_effort", "include_reasoning",
  "response_format", "max_tokens", "max_completion_tokens", "stream", "stream_options", "cache_control", "n", "user",
]);
const reasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh"];

function cacheControl(value: unknown) {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.type !== "ephemeral" || (value.ttl !== undefined && value.ttl !== "5m" && value.ttl !== "1h")) return null;
  return { type: value.type, ttl: value.ttl };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textMessage(value: unknown) {
  if (!isRecord(value) || typeof value.role !== "string" || !["system", "developer", "user", "assistant", "tool"].includes(value.role)) return null;
  const { role, name, content, tool_call_id, tool_calls } = value;
  const cache = cacheControl(value.cache_control);
  if (cache === null) return null;
  let text = content;
  if (Array.isArray(content)) {
    if (!content.every(part => isRecord(part) && part.type === "text" && typeof part.text === "string"
      && cacheControl(part.cache_control) !== null)) return null;
    text = content.map(part => ({ type: "text", text: part.text, cache_control: cacheControl(part.cache_control) }));
  } else if (typeof content !== "string" && content !== null && !(role === "assistant" && content === undefined && Array.isArray(tool_calls))) return null;
  if (value.reasoning !== undefined && typeof value.reasoning !== "string") return null;
  if (value.reasoning_details !== undefined && (!Array.isArray(value.reasoning_details) || !value.reasoning_details.every(detail =>
    isRecord(detail) && ["reasoning.text", "reasoning.summary", "reasoning.encrypted"].includes(String(detail.type))))) return null;
  if (tool_calls !== undefined && (!Array.isArray(tool_calls) || !tool_calls.every(call => isRecord(call)
    && call.type === "function" && typeof call.id === "string" && isRecord(call.function)
    && typeof call.function.name === "string" && typeof call.function.arguments === "string"))) return null;
  return {
    role, content: text, cache_control: cache,
    ...(typeof value.reasoning === "string" ? { reasoning: value.reasoning } : {}),
    ...(Array.isArray(value.reasoning_details) ? { reasoning_details: value.reasoning_details } : {}),
    ...(typeof name === "string" ? { name } : {}),
    ...(typeof tool_call_id === "string" ? { tool_call_id } : {}),
    ...(Array.isArray(tool_calls) ? { tool_calls: tool_calls.map(call => ({
      id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments },
    })) } : {}),
  };
}

function generationOptions(body: Record<string, unknown>, maxOutput: number): Record<string, unknown> | null {
  const options: Record<string, unknown> = {};
  const bounds = { temperature: [0, 2], top_p: [0, 1], frequency_penalty: [-2, 2], presence_penalty: [-2, 2] };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return null;
    options[key] = value;
  }
  if (body.top_k !== undefined) {
    if (typeof body.top_k !== "number" || !Number.isSafeInteger(body.top_k) || body.top_k < 0 || body.top_k > 1000) return null;
    options.top_k = body.top_k;
  }
  if (body.seed !== undefined) {
    if (!Number.isSafeInteger(body.seed)) return null;
    options.seed = body.seed;
  }
  if (body.stop !== undefined) {
    const stops = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (!stops.length || stops.length > 4 || !stops.every(value => typeof value === "string" && value.length <= 1024)) return null;
    options.stop = body.stop;
  }
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== "boolean") return null;
    options.parallel_tool_calls = body.parallel_tool_calls;
  }
  const choice = body.tool_choice;
  if (choice !== undefined) {
    if (typeof choice === "string" && ["none", "auto", "required"].includes(choice)) options.tool_choice = choice;
    else if (isRecord(choice) && choice.type === "function" && isRecord(choice.function) && typeof choice.function.name === "string") {
      options.tool_choice = { type: "function", function: { name: choice.function.name } };
    } else return null;
  }
  const reasoning = body.reasoning;
  const effortAlias = body.reasoning_effort;
  if (effortAlias !== undefined && (typeof effortAlias !== "string" || !reasoningEfforts.includes(effortAlias) || reasoning !== undefined)) return null;
  if (typeof effortAlias === "string") options.reasoning = { effort: effortAlias };
  if (body.include_reasoning !== undefined) {
    if (typeof body.include_reasoning !== "boolean") return null;
    options.include_reasoning = body.include_reasoning;
  }
  if (reasoning !== undefined) {
    if (!isRecord(reasoning)) return null;
    const { effort, max_tokens, enabled, exclude, summary } = reasoning;
    if ((effort !== undefined && (typeof effort !== "string" || !reasoningEfforts.includes(effort)))
      || (max_tokens !== undefined && (typeof max_tokens !== "number" || !Number.isSafeInteger(max_tokens) || max_tokens < 1 || max_tokens > maxOutput))
      || (enabled !== undefined && typeof enabled !== "boolean") || (exclude !== undefined && typeof exclude !== "boolean")
      || (summary !== undefined && (typeof summary !== "string" || !["auto", "concise", "detailed"].includes(summary)))) return null;
    options.reasoning = { effort, max_tokens, enabled, exclude, summary };
  }
  const format = body.response_format;
  if (format !== undefined) {
    if (!isRecord(format) || !["text", "json_object", "json_schema"].includes(String(format.type))
      || (format.type === "json_schema" && !isRecord(format.json_schema))) return null;
    options.response_format = format.type === "json_schema"
      ? { type: format.type, json_schema: format.json_schema }
      : { type: format.type };
  }
  return options;
}

/** Build the exact provider payload before charging. No client-controlled plugins or fallback routing. */
export function boundedDevCompletion(body: unknown, userId: string) {
  if (!isRecord(body) || typeof body.model !== "string" || !Array.isArray(body.messages) || !body.messages.length
    || Object.keys(body).some(key => !supportedFields.has(key)) || (body.n !== undefined && body.n !== 1)
    || (body.stream !== undefined && typeof body.stream !== "boolean")) return null;
  const cache = cacheControl(body.cache_control);
  if (cache === null) return null;
  const price = prices.get(body.model);
  if (!price) return null;
  const messages = body.messages.map(textMessage);
  if (messages.some(message => message === null)) return null;
  const tools = body.tools;
  if (tools !== undefined && (!Array.isArray(tools) || !tools.every(tool => isRecord(tool) && tool.type === "function"
    && isRecord(tool.function) && typeof tool.function.name === "string"
    && (tool.function.description === undefined || typeof tool.function.description === "string")
    && (tool.function.parameters === undefined || isRecord(tool.function.parameters))
    && (tool.function.strict === undefined || typeof tool.function.strict === "boolean")))) return null;
  const requested = body.max_completion_tokens ?? body.max_tokens ?? MAX_OUTPUT_TOKENS;
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1 || requested > MAX_OUTPUT_TOKENS) return null;
  if (body.max_completion_tokens !== undefined && body.max_tokens !== undefined && body.max_completion_tokens !== body.max_tokens) return null;
  const generation = generationOptions(body, requested);
  if (!generation) return null;
  const wire = JSON.stringify({
    model: body.model, messages, max_tokens: requested, ...generation, cache_control: cache,
    stream: body.stream === true, user: `hsd:${userId}`,
    ...(body.stream === true ? { stream_options: { include_usage: true } } : {}),
    ...(Array.isArray(tools) && tools.length ? { tools: tools.map(tool => ({
      type: "function", function: {
        name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters, strict: tool.function.strict,
      },
    })) } : {}),
    provider: { allow_fallbacks: false, require_parameters: true, max_price: { prompt: price.input, completion: price.output, request: 0 } },
  });
  const bytes = Buffer.byteLength(wire);
  if (bytes > MAX_INPUT_BYTES) return null;
  const reservationMicrousd = Math.ceil(2 * ((bytes + FORMAT_OVERHEAD_TOKENS) * price.input + requested * price.output));
  return { wire, model: body.model, reservationMicrousd };
}

export async function reserveDevCompletion(userId: string, modelId: string, reservationMicrousd: number, signal: AbortSignal): Promise<boolean> {
  const key = tryServiceKey();
  try {
    const url = new URL(process.env.SUPABASE_URL || "");
    if (!key || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
    const response = await fetch(url.origin + "/rest/v1/rpc/online_reserve_dev_model_budget", {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: userId, model_id: modelId, reservation_microusd: reservationMicrousd }),
    });
    return response.ok && await response.json() === true;
  } catch {
    return false;
  }
}
