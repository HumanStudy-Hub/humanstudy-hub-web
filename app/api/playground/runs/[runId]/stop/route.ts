import { NextResponse } from "next/server";
import { stopRun } from "@/lib/playground-runs";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await context.params;
    return NextResponse.json({ run: await stopRun(runId) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not stop this run." },
      { status: 400 },
    );
  }
}
