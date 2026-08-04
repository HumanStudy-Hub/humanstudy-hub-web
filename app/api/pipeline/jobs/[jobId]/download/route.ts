import { NextResponse } from "next/server";
import { readJob, readPackageZip } from "@/lib/github-jobs";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const job = await readJob(jobId);
    if (job.status !== "complete") {
      return NextResponse.json({ error: "Package is not ready." }, { status: 409 });
    }
    const zip = await readPackageZip(jobId);
    return new NextResponse(new Uint8Array(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${job.paperName.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/\.pdf$/i, "")}.zip"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Package not found." }, { status: 404 });
  }
}
