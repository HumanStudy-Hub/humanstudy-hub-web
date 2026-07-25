import { NextResponse } from "next/server";
import { readJob, readLog } from "@/lib/pipeline-jobs";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const job = await readJob(jobId);
    return NextResponse.json({ job, log: await readLog(jobId) });
  } catch {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
}
