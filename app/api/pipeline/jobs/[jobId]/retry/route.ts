import { NextResponse } from "next/server";
import { retryJob } from "@/lib/github-jobs";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    return NextResponse.json({ job: await retryJob(jobId) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not restart this job." },
      { status: 400 },
    );
  }
}
