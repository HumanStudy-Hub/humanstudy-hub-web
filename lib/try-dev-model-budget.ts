import { tryServiceKey } from "./try-online-config";

// USD per million tokens: 2x the OpenRouter list price (DeepSeek: see below) (checked 2026-11-24 via GET /api/v1/models: Haiku 5.5
// 0.10/0.50, V4.1 Flash 0.05/0.199, -1017 0.03/0.20), a margin for cache writes and provider spread. These size
// the reservation and cap provider choice (max_price); the allowance is settled from OpenRouter's actual usage.cost.
// They were 5-20x the list price before, so every in-flight call held far more allowance than it could cost.
const prices = new Map([
  ["anthropic/claude-haiku-5.5", { input: 0.2, output: 1 }],
  // DeepSeek's list price is its cheapest provider (Baidu), which lacks `seed`; simulations send a seed and
  // require_parameters is on, so the cap must admit the seed-capable providers (Wafer, DeepInfra, InferenceNet,
  // River, Novita, ... all <= 0.20/0.80 on GET /api/v1/models/deepseek/deepseek-v4.1-flash/endpoints, 2026-11-24).
  // At 0.10/0.40 every seed-capable provider was excluded and each call was a 404 "No endpoints found".
  ["deepseek/deepseek-v4.1-flash", { input: 0.2, output: 0.8 }],
  ["deepseek/deepseek-v4.1-flash-1017", { input: 0.2, output: 0.8 }],
]);
export const BOUNDED_HOSTED_MODELS = [...prices.keys()];
// Sampling parameters each hosted model's OpenRouter endpoint does NOT list in supported_parameters (checked
// 2026-11-22 via GET /api/v1/models). With require_parameters, sending one makes OpenRouter answer 404
// "No endpoints found", so the proxy drops them. Claude Haiku 5.5 takes no temperature/top_p/top_k/seed/penalties.
const UNSUPPORTED_SAMPLING: Record<string, readonly string[]> = {
  "anthropic/claude-haiku-5.5": ["temperature", "top_p", "top_k", "seed", "frequency_penalty", "presence_penalty", "parallel_tool_calls"],
};
const MAX_INPUT_BYTES = 4_000_000;
// Pictures (desktop protocol simulations show participants the study's images; desktop model-relay.ts sends them):
// inline data URLs only, in user messages only, for models that take images. The incoming body is capped at
// 4,000,000 bytes by the route (Vercel refuses function bodies over 4.5 MB), so these keep a request well inside it.
const IMAGE_MODELS = new Set(["anthropic/claude-haiku-5.5"]);
const MAX_IMAGES = 8;
const MAX_IMAGE_BASE64_BYTES = 1_000_000;
// Reserved per picture instead of its base64 bytes: a model bills a picture by its pixels, and Claude models stay
// under this. Same figure as desktop model-relay.ts IMAGE_RESERVE_TOKENS and skills/run/participants.py (budget.py).
const IMAGE_RESERVE_TOKENS = 5000;
// Larger pictures are refused rather than resized (the provider would downscale them anyway).
const MAX_IMAGE_SIDE = 8000;
// A request with pictures stays inside the standard (not long-context) price tier the reservation's prices assume:
// estimated input tokens, on the reservation's basis (pictures x IMAGE_RESERVE_TOKENS + the other wire bytes), at most
// this. Text-only requests keep their existing limit (MAX_INPUT_BYTES) so large agent contexts are unchanged.
const MAX_IMAGE_REQUEST_INPUT_TOKENS = 100_000;
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const imageDetails = ["low", "high", "auto"];
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

/** Width and height read from the image header, or null when the bytes are not a readable header of the declared
 *  type (which also catches a picture whose bytes do not match its mime type). */
export function imageSize(mime: string, data: Buffer): { width: number; height: number } | null {
  const ascii = (at: number, length: number) => data.subarray(at, at + length).toString("latin1");
  let size: { width: number; height: number } | null = null;
  if (mime === "png") {
    if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && ascii(12, 4) === "IHDR") {
      size = { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    }
  } else if (mime === "gif") {
    if (data.length >= 10 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) size = { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  } else if (mime === "webp") {
    if (data.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
      const chunk = ascii(12, 4);
      if (chunk === "VP8 " && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
        size = { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
      } else if (chunk === "VP8L" && data[20] === 0x2f) {
        const bits = data.readUInt32LE(21);
        size = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      } else if (chunk === "VP8X") {
        size = { width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
      }
    }
  } else if (mime === "jpeg" && data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    // Walk the marker segments to the first baseline/extended/progressive frame header (SOF0/1/2).
    let at = 2;
    while (at + 4 <= data.length && !size) {
      if (data[at] !== 0xff) return null;
      const marker = data[at + 1];
      if (marker === 0xff) { at++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) return null;
      const length = data.readUInt16BE(at + 2);
      if (length < 2) return null;
      if (marker >= 0xc0 && marker <= 0xc2) {
        if (at + 9 > data.length) return null;
        size = { width: data.readUInt16BE(at + 7), height: data.readUInt16BE(at + 5) };
      }
      at += 2 + length;
    }
  }
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** An inline picture part, or null. Never a remote URL (the provider would fetch it). */
function imagePart(part: Record<string, unknown>) {
  const image = part.image_url;
  if (!isRecord(image) || typeof image.url !== "string") return null;
  if (image.detail !== undefined && (typeof image.detail !== "string" || !imageDetails.includes(image.detail))) return null;
  const cache = cacheControl(part.cache_control);
  if (cache === null) return null;
  const match = DATA_IMAGE.exec(image.url);
  if (!match || match[2].length % 4 !== 0 || match[2].length > MAX_IMAGE_BASE64_BYTES) return null;
  const size = imageSize(match[1], Buffer.from(match[2], "base64"));
  if (!size || size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE) return null;
  return {
    part: { type: "image_url", image_url: { url: image.url, ...(image.detail !== undefined ? { detail: image.detail } : {}) }, cache_control: cache },
    base64Bytes: match[2].length,
  };
}

type Pictures = { count: number; base64Bytes: number };

function textMessage(value: unknown, images: boolean, pictures: Pictures) {
  if (!isRecord(value) || typeof value.role !== "string" || !["system", "developer", "user", "assistant", "tool"].includes(value.role)) return null;
  const { role, name, content, tool_call_id, tool_calls } = value;
  const cache = cacheControl(value.cache_control);
  if (cache === null) return null;
  let text = content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const part of content) {
      if (!isRecord(part)) return null;
      if (part.type === "text" && typeof part.text === "string") {
        const partCache = cacheControl(part.cache_control);
        if (partCache === null) return null;
        parts.push({ type: "text", text: part.text, cache_control: partCache });
      } else if (part.type === "image_url" && images && role === "user") {
        const picture = imagePart(part);
        if (!picture) return null;
        pictures.count++;
        pictures.base64Bytes += picture.base64Bytes;
        parts.push(picture.part);
      } else return null;
    }
    text = parts;
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
  const pictures: Pictures = { count: 0, base64Bytes: 0 };
  const messages = body.messages.map(message => textMessage(message, IMAGE_MODELS.has(body.model as string), pictures));
  if (messages.some(message => message === null) || pictures.count > MAX_IMAGES) return null;
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
  // With require_parameters, OpenRouter refuses (404) any parameter the model's provider can't honour.
  for (const key of UNSUPPORTED_SAMPLING[body.model] ?? []) delete (generation as Record<string, unknown>)[key];
  const wire = JSON.stringify({
    model: body.model, messages, max_tokens: requested, ...generation, cache_control: cache,
    stream: body.stream === true, user: `hsd:${userId}`,
    ...(body.stream === true ? { stream_options: { include_usage: true } } : {}),
    ...(Array.isArray(tools) && tools.length ? { tools: tools.map(tool => ({
      type: "function", function: {
        name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters, strict: tool.function.strict,
      },
    })) } : {}),
    // Fallbacks only move between providers that already pass require_parameters and max_price, so cost stays
    // bounded; without them one rate-limited provider (429) fails every parallel simulation call.
    provider: { allow_fallbacks: true, require_parameters: true, max_price: { prompt: price.input, completion: price.output, request: 0 } },
  });
  const bytes = Buffer.byteLength(wire);
  if (bytes > MAX_INPUT_BYTES) return null;
  // Text is charged by its wire bytes (an upper bound on its tokens); each picture a fixed IMAGE_RESERVE_TOKENS
  // instead of its base64 bytes, which would reserve far more than the picture can cost.
  const estimatedInput = bytes - pictures.base64Bytes + pictures.count * IMAGE_RESERVE_TOKENS;
  if (pictures.count && estimatedInput > MAX_IMAGE_REQUEST_INPUT_TOKENS) return null;
  const inputTokens = estimatedInput + FORMAT_OVERHEAD_TOKENS;
  const reservationMicrousd = Math.ceil(2 * (inputTokens * price.input + requested * price.output));
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
