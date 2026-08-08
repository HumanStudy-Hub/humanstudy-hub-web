import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

export const runtime = "nodejs";

const MAX_PAPER_BYTES = 50 * 1024 * 1024;

// The browser sends the PDF straight to Vercel Blob and only posts the resulting
// URL to /api/pipeline/jobs. Vercel rejects any function request body over
// 4.5 MB, so routing the paper through the server fails for most journal PDFs.
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as HandleUploadBody;
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ["application/pdf"],
        maximumSizeInBytes: MAX_PAPER_BYTES,
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
