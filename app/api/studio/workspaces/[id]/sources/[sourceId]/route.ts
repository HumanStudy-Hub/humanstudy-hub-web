import { NextResponse } from "next/server";
import { requireStudioUser } from "@/lib/studio/auth";
import { isUuid, routeError, studioConfig, studioFetch, upstreamJson, StudioError } from "@/lib/studio/http";
import { getWorkspace } from "@/lib/studio/store";
import { validStoredSource } from "@/lib/studio/resources";

type Context = { params: Promise<{ id: string; sourceId: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const ctx = await requireStudioUser();
    const { id, sourceId } = await context.params;
    if (!isUuid(sourceId)) throw new StudioError(404, "not_found");
    const workspace = await getWorkspace(ctx, id);
    if (!workspace) throw new StudioError(404, "not_found");
    const source = workspace.document.sources.find(item => item.id === sourceId);
    if (!source || !validStoredSource(source, ctx.user.id, id)) throw new StudioError(404, "not_found");
    const path = source.path.split("/").map(encodeURIComponent).join("/");
    const response = await studioFetch(`/storage/v1/object/sign/studio-sources/${path}`, {
      method: "POST", token: ctx.accessToken, body: { expiresIn: 3600 },
    });
    const signed = await upstreamJson<{ signedURL?: string; signedUrl?: string }>(response);
    const raw = signed.signedURL || signed.signedUrl;
    if (!raw) throw new StudioError(502, "invalid_service_response");
    const { url } = studioConfig();
    let signedUrl: URL;
    try { signedUrl = new URL(raw.startsWith("/object/") ? `${url}/storage/v1${raw}` : raw, `${url}/storage/v1/`); }
    catch { throw new StudioError(502, "invalid_service_response"); }
    if (signedUrl.origin !== url || signedUrl.pathname !== `/storage/v1/object/sign/studio-sources/${path}`) {
      throw new StudioError(502, "invalid_service_response");
    }
    return NextResponse.json({ url: signedUrl.toString(), expiresIn: 3600 }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return routeError(error); }
}
