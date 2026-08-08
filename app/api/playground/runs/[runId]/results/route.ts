import { NextResponse } from "next/server";
import { readResults } from "@/lib/playground-runs";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    const { runId } = await context.params;
    const results = await readResults(runId);
    if (!results.analysis) {
      return NextResponse.json({ error: "This run has no results yet." }, { status: 404 });
    }
    return NextResponse.json(results);
  } catch {
    return NextResponse.json({ error: "Results not found." }, { status: 404 });
  }
}
