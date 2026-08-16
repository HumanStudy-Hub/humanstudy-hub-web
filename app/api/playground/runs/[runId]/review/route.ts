import { NextResponse } from "next/server";
import { readReview, saveReview } from "@/lib/playground-runs";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await context.params;
    return NextResponse.json({ review: await readReview(runId) });
  } catch {
    return NextResponse.json({ error: "Review not found." }, { status: 404 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await context.params;
    return NextResponse.json({ review: await saveReview(runId, await request.json()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Review could not be saved." }, { status: 400 });
  }
}
