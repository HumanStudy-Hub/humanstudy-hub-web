import { NextResponse } from "next/server";
import { createJob } from "@/lib/github-jobs";

export const runtime = "nodejs";

// The body carries only the Vercel Blob URL of the already-uploaded paper.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const paperUrl = String(body.paperUrl || "");
    const paperName = String(body.paperName || "");
    if (!paperUrl || !paperName) {
      return NextResponse.json({ error: "Paper PDF is required." }, { status: 400 });
    }
    const job = await createJob({
      paperUrl,
      paperName,
      contributorName: String(body.contributorName || ""),
      contributorGithub: String(body.contributorGithub || ""),
      osfUrl: String(body.osfUrl || ""),
    });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create job." },
      { status: 400 },
    );
  }
}
