import { NextResponse } from "next/server";
import { readJob, readReviewFiles, saveReviewFile } from "@/lib/github-jobs";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const job = await readJob(jobId);
    return NextResponse.json({ files: await readReviewFiles(jobId, job.currentStage) });
  } catch {
    return NextResponse.json({ error: "Review files not found." }, { status: 404 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await context.params;
    const body = await request.json() as { path?: string; content?: string };
    if (!body.path || typeof body.content !== "string") return NextResponse.json({ error: "File path and content are required." }, { status: 400 });
    await saveReviewFile(jobId, body.path, body.content);
    return NextResponse.json({ saved: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not save file." }, { status: 400 });
  }
}
