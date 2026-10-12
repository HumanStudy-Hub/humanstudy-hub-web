import { NextResponse } from "next/server";
import { blobUpload, signedBlobUrl } from "@/lib/blob-paper";
import { MAX_ZIP_BYTES } from "@/lib/community";
import { fail, requireHubUser } from "@/lib/community-auth";
import { publishContribution, type PublishBody } from "@/lib/community-publish";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Pathname inside the Blob store for an upload URL (or a bare pathname). */
function pathnameOf(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  try {
    return decodeURIComponent(new URL(value).pathname.replace(/^\/+/, ""));
  } catch {
    return value.replace(/^\/+/, "");
  }
}

export async function POST(request: Request) {
  const user = await requireHubUser(request);
  if (user instanceof NextResponse) return user;

  const body = (await request.json().catch(() => null)) as (PublishBody & { blobUrl?: unknown; blobPathname?: unknown }) | null;
  if (!body || typeof body !== "object") return fail(400, "bad_request", "The publish request was not understood.");

  const pathname = pathnameOf(body.blobPathname ?? body.blobUrl);
  if (!pathname || pathname.includes("..") || !pathname.startsWith(`community/${user.id}/`)) {
    return fail(400, "bad_upload", "Upload the contribution zip first, then publish it.");
  }
  if (!(await blobUpload(pathname))) return fail(400, "bad_upload", "The uploaded zip was not found. Upload it again and retry.");

  let zip: Buffer;
  try {
    const download = await fetch(await signedBlobUrl(pathname), { cache: "no-store" });
    if (!download.ok) throw new Error("download failed");
    const declared = Number(download.headers.get("content-length") || 0);
    if (declared > MAX_ZIP_BYTES) return fail(400, "zip_too_large", "The contribution is over the 40 MB limit. Leave out large simulation outputs and try again.");
    zip = Buffer.from(await download.arrayBuffer());
  } catch {
    return fail(502, "blob_unavailable", "The Hub could not read your upload. Try publishing again.");
  }

  const result = await publishContribution({ userId: user.id, zip, body });
  if (!result.ok) return fail(result.status, result.error, result.message);
  return NextResponse.json({ id: result.id, prUrl: result.prUrl, status: result.status });
}
