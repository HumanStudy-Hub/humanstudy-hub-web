import { NextResponse } from "next/server";
import { importStudy } from "@/lib/github-jobs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const job = await importStudy({
      studyId: String(body.studyId || ""),
      contributorName: String(body.contributorName || ""),
      contributorGithub: body.contributorGithub ? String(body.contributorGithub) : undefined,
    });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not import the study." },
      { status: 400 },
    );
  }
}
