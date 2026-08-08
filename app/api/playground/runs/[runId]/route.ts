import { NextResponse } from "next/server";
import { readLog, readRun } from "@/lib/playground-runs";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  try {
    const { runId } = await context.params;
    const run = await readRun(runId);
    return NextResponse.json({ run, log: await readLog(runId) });
  } catch {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }
}
