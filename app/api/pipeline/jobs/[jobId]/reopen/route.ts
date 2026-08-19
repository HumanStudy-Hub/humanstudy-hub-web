import { NextResponse } from "next/server";
import { reopenReview } from "@/lib/github-jobs";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const job = await reopenReview(jobId);
    return NextResponse.json({ job });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not reopen the review." },
      { status: 400 },
    );
  }
}
