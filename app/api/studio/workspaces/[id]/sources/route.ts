import { NextResponse } from "next/server";
import { requireStudioUser } from "@/lib/studio/auth";
import { assertSameOrigin, readJsonBody, routeError, studioConfig, studioFetch, upstreamJson, StudioError } from "@/lib/studio/http";
import { getWorkspace } from "@/lib/studio/store";
import type { StudioSource } from "@/lib/studio/types";
import { MAX_PAPER_BYTES, MAX_RESOURCE_BYTES, sourceSpec, sourceStoragePath } from "@/lib/studio/resources";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context) {
  try {
    assertSameOrigin(request);
    const ctx = await requireStudioUser();
    const { id } = await context.params;
    if (!await getWorkspace(ctx, id)) throw new StudioError(404, "not_found");
    const body = await readJsonBody(request, 4_096);
    if (!body || typeof body !== "object") throw new StudioError(400, "invalid_source");
    const { name, mimeType, size } = body as Record<string, unknown>;
    const filename = typeof name === "string" ? name : "";
    const spec = sourceSpec(filename);
    if (!spec || mimeType !== spec.mimeType || !Number.isInteger(size) || (size as number) < 1 ||
        (size as number) > (spec.kind === "paper" ? MAX_PAPER_BYTES : MAX_RESOURCE_BYTES)) {
      throw new StudioError(400, "invalid_source");
    }
    const sourceId = crypto.randomUUID();
    const path = sourceStoragePath(ctx.user.id, id, sourceId, spec.extension);
    const response = await studioFetch(`/storage/v1/object/upload/sign/studio-sources/${path}`, {
      method: "POST", token: ctx.accessToken, body: {},
    });
    const signed = await upstreamJson<{ url?: string }>(response);
    if (typeof signed.url !== "string") throw new StudioError(502, "invalid_service_response");
    const { url } = studioConfig();
    let token: string | null;
    try { token = new URL(signed.url, `${url}/storage/v1/`).searchParams.get("token"); }
    catch { throw new StudioError(502, "invalid_service_response"); }
    if (!token) throw new StudioError(502, "invalid_service_response");
    const uploadUrl = `${url}/storage/v1/object/upload/sign/studio-sources/${path}?token=${encodeURIComponent(token)}`;
    const source: StudioSource = { id: sourceId, name: filename, path, mimeType: spec.mimeType, size: size as number, kind: spec.kind };
    return NextResponse.json({ source, uploadUrl, method: "PUT", headers: { "Content-Type": spec.mimeType } }, { status: 201 });
  } catch (error) { return routeError(error); }
}
