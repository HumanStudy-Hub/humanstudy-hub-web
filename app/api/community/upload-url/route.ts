import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireHubUser } from "@/lib/community-auth";
import { MAX_ZIP_BYTES } from "@/lib/community";

export const runtime = "nodejs";

// Contribution zips go straight to Vercel Blob (a function body caps out at 4.5 MB). The
// bearer token is checked here, and the pathname is pinned to the caller's own prefix so
// /api/community/publish can later tell the upload belongs to them.
export async function POST(request: Request) {
  const user = await requireHubUser(request);
  if (user instanceof NextResponse) return user;
  try {
    const body = (await request.json()) as HandleUploadBody;
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith(`community/${user.id}/`) || pathname.includes("..")) throw new Error(`Upload the zip under community/${user.id}/.`);
        return {
          allowedContentTypes: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
          maximumSizeInBytes: MAX_ZIP_BYTES,
          addRandomSuffix: true,
        };
      },
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: "upload_refused", message: error instanceof Error ? error.message : "Could not prepare the upload." }, { status: 400 });
  }
}
