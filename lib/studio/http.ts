import { NextResponse } from "next/server";

export class StudioError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message || code);
  }
}

export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function studioConfig(): { url: string; key: string } {
  const rawUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!rawUrl || !key) throw new StudioError(503, "setup_required");
  try {
    const url = new URL(rawUrl);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) || url.username || url.password || url.search || url.hash) {
      throw new Error("Invalid Supabase URL");
    }
    return { url: url.origin, key };
  } catch {
    throw new StudioError(503, "setup_required");
  }
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") throw new StudioError(403, "invalid_origin");
  const expected = new Set([new URL(request.url).origin]);
  // Next may expose its internal request URL behind a reverse proxy. The browser
  // still sends the public Host/forwarded Host and Origin on mutations.
  const protocol = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.slice(0, -1);
  if (protocol === "http" || protocol === "https") {
    for (const host of [request.headers.get("host"), request.headers.get("x-forwarded-host")]) {
      if (!host || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) continue;
      try { expected.add(new URL(`${protocol}://${host}`).origin); }
      catch { /* Invalid proxy headers never authorize an origin. */ }
    }
  }
  if (!expected.has(origin)) throw new StudioError(403, "invalid_origin");
}

export async function readJsonBody(request: Request, maxBytes = 256_000): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") || "")) {
    throw new StudioError(415, "json_required");
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) throw new StudioError(413, "body_too_large");
  const reader = request.body?.getReader();
  if (!reader) throw new StudioError(400, "invalid_json");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new StudioError(413, "body_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof StudioError) throw error;
    throw new StudioError(400, "invalid_json");
  }
}

export async function studioFetch(path: string, options: {
  method?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}): Promise<Response> {
  const { url, key } = studioConfig();
  const headers: Record<string, string> = { apikey: key, ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  try {
    return await fetch(`${url}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new StudioError(502, "service_unavailable");
  }
}

export async function upstreamJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new StudioError(401, "unauthorized");
    if (response.status === 404) throw new StudioError(404, "not_found");
    if (response.status === 413) throw new StudioError(413, "body_too_large");
    throw new StudioError(response.status >= 500 ? 502 : 400, response.status >= 500 ? "service_unavailable" : "invalid_request");
  }
  try { return await response.json() as T; }
  catch { throw new StudioError(502, "invalid_service_response"); }
}

export function routeError(error: unknown): NextResponse {
  if (error instanceof StudioError) return NextResponse.json({ error: error.code }, { status: error.status });
  if (error && typeof error === "object" && "status" in error && (error as {status?: unknown}).status === 400) {
    return NextResponse.json({ error: "invalid_document" }, { status: 400 });
  }
  return NextResponse.json({ error: "internal_error" }, { status: 500 });
}
