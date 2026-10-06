import JSZip from "jszip";
import type { StudioContext } from "./auth";
import { studioConfig, studioFetch, upstreamJson, StudioError } from "./http";
import { MAX_PAPER_BYTES, MAX_PIPELINE_RESOURCE_BYTES, sourceSpec, sourceStoragePath, validStoredSource } from "./resources";
import type { StudioWorkspace } from "./types";

const encoded = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export async function signPrivateSource(ctx: StudioContext, path: string, expiresIn = 86400): Promise<string> {
  const safePath = encoded(path);
  const signed = await upstreamJson<{ signedURL?: string; signedUrl?: string }>(await studioFetch(
    `/storage/v1/object/sign/studio-sources/${safePath}`,
    { method: "POST", token: ctx.accessToken, body: { expiresIn } },
  ));
  const raw = signed.signedURL || signed.signedUrl;
  if (!raw) throw new StudioError(502, "invalid_service_response");
  const { url } = studioConfig();
  let signedUrl: URL;
  try { signedUrl = new URL(raw.startsWith("/object/") ? `${url}/storage/v1${raw}` : raw, `${url}/storage/v1/`); }
  catch { throw new StudioError(502, "invalid_service_response"); }
  if (signedUrl.origin !== url || signedUrl.pathname !== `/storage/v1/object/sign/studio-sources/${safePath}`) {
    throw new StudioError(502, "invalid_service_response");
  }
  return signedUrl.href;
}

async function readPrivateSource(ctx: StudioContext, path: string, maximum: number): Promise<Uint8Array> {
  const response = await studioFetch(`/storage/v1/object/authenticated/studio-sources/${encoded(path)}`, { token: ctx.accessToken });
  if (!response.ok || !response.body) throw new StudioError(502, "resource_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) throw new StudioError(413, "resources_too_large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function uploadPrivateArchive(ctx: StudioContext, path: string, bytes: Uint8Array): Promise<void> {
  const safePath = encoded(path);
  const signed = await upstreamJson<{ url?: string }>(await studioFetch(
    `/storage/v1/object/upload/sign/studio-sources/${safePath}`,
    { method: "POST", token: ctx.accessToken, body: {} },
  ));
  if (typeof signed.url !== "string") throw new StudioError(502, "invalid_service_response");
  const { url } = studioConfig();
  let token: string | null;
  try { token = new URL(signed.url, `${url}/storage/v1/`).searchParams.get("token"); }
  catch { throw new StudioError(502, "invalid_service_response"); }
  if (!token) throw new StudioError(502, "invalid_service_response");
  let response: Response;
  try {
    response = await fetch(`${url}/storage/v1/object/upload/sign/studio-sources/${safePath}?token=${encodeURIComponent(token)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/zip" },
      body: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/zip" }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch { throw new StudioError(502, "resource_upload_failed"); }
  if (!response.ok) throw new StudioError(response.status === 413 ? 413 : 502, "resource_upload_failed");
}

/** Freeze auxiliary inputs in one private archive consumed by the original Bench worker. */
export async function prepareStudioResourceArchive(ctx: StudioContext, workspace: StudioWorkspace, primarySourceId: string): Promise<{ path: string; url: string; sourceIds: string[] } | null> {
  const sources = workspace.document.sources.filter((source) => source.id !== primarySourceId && source.includeInBuild !== false);
  if (!sources.length) return null;
  const total = sources.reduce((sum, source) => sum + source.size, 0);
  if (total > MAX_PIPELINE_RESOURCE_BYTES) throw new StudioError(413, "resources_too_large");
  const zip = new JSZip();
  const manifest: Array<{ id: string; name: string; mimeType: string; size: number; path: string }> = [];
  let actualTotal = 0;
  for (const source of sources) {
    if (!validStoredSource(source, ctx.user.id, workspace.id)) throw new StudioError(400, "invalid_source");
    const bytes = await readPrivateSource(ctx, source.path, Math.min(source.size + 1024, MAX_PIPELINE_RESOURCE_BYTES - actualTotal));
    actualTotal += bytes.byteLength;
    if (actualTotal > MAX_PIPELINE_RESOURCE_BYTES) throw new StudioError(413, "resources_too_large");
    const name = sourceSpec(source.name) ? source.name : `${source.id}.bin`;
    const filePath = `resources/${source.id}/${name}`;
    zip.file(filePath, bytes);
    manifest.push({ id: source.id, name: source.name, mimeType: source.mimeType, size: bytes.byteLength, path: filePath });
  }
  zip.file("resource-manifest.json", JSON.stringify({ version: 1, primarySourceId, files: manifest }, null, 2));
  const archive = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
  if (archive.byteLength > MAX_PAPER_BYTES) throw new StudioError(413, "resources_too_large");
  const path = sourceStoragePath(ctx.user.id, workspace.id, crypto.randomUUID(), "zip");
  await uploadPrivateArchive(ctx, path, archive);
  return { path, url: await signPrivateSource(ctx, path), sourceIds: sources.map((source) => source.id) };
}

export function isOwnedResourceArchivePath(path: string, ctx: StudioContext, workspaceId: string): boolean {
  return new RegExp(`^${ctx.user.id}/${workspaceId}/[0-9a-f-]{36}\\.zip$`, "i").test(path);
}
