import { NextResponse } from "next/server";
import { approveStage } from "@/lib/pipeline-jobs";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await context.params;
    const body = (await request.json()) as { decision?: string; note?: string };
    if (body.decision !== "approved" && body.decision !== "changes_requested") {
      return NextResponse.json({ error: "Invalid review decision." }, { status: 400 });
    }
    const job = await approveStage(jobId, {
      decision: body.decision,
      note: body.note?.trim() || undefined,
    });
    return NextResponse.json({ job });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Review could not be saved." },
      { status: 400 },
    );
  }
}
