import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

export const runtime = "nodejs";

const MAX_ZIP_BYTES = 50 * 1024 * 1024;

// Study ZIPs go straight to Vercel Blob for the same reason papers do: a Vercel
// function request body caps out at 4.5 MB.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as HandleUploadBody;
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
        maximumSizeInBytes: MAX_ZIP_BYTES,
        addRandomSuffix: true,
      }),
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not prepare the upload." },
      { status: 400 },
    );
  }
}
