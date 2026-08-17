import { NextResponse } from "next/server";
import { listBenchmarkStudyFiles } from "@/lib/github-jobs";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const studyId = new URL(request.url).searchParams.get("study") || "";
    if (!studyId) return NextResponse.json({ files: [] });
    return NextResponse.json({ files: await listBenchmarkStudyFiles(studyId) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read the study." },
      { status: 500 },
    );
  }
}
