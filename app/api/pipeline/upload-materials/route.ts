import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

export const runtime = "nodejs";

// Open materials (questionnaires, stimuli, datasets) can be much larger than a
// paper, and arrive as a single zip whether the contributor chose a .zip file or
// a folder the browser zipped for them.
const MAX_MATERIALS_BYTES = 100 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as HandleUploadBody;
    const result = await handleUpload({
      request,
      body,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ["application/zip", "application/x-zip-compressed"],
        maximumSizeInBytes: MAX_MATERIALS_BYTES,
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
