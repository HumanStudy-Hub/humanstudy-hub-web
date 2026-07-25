import { NextResponse } from "next/server";
import AdmZip from "adm-zip";
import { readJob } from "@/lib/pipeline-jobs";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const job = await readJob(jobId);
    if (job.status !== "complete" || !job.packageDir) {
      return NextResponse.json({ error: "Package is not ready." }, { status: 409 });
    }
    const zip = new AdmZip();
    zip.addLocalFolder(job.packageDir, job.experimentId);
    return new NextResponse(new Uint8Array(zip.toBuffer()), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${job.experimentId}.zip"`,
      },
    });
  } catch {
    return NextResponse.json({ error: "Package not found." }, { status: 404 });
  }
}
