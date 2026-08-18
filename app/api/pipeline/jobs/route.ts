import { NextResponse } from "next/server";
import { createJob } from "@/lib/github-jobs";

export const runtime = "nodejs";

// The body carries only the Blob pathname of the already-uploaded paper.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const paperPathname = String(body.paperPathname || "");
    const paperName = String(body.paperName || "");
    if (!paperPathname || !paperName) {
      return NextResponse.json({ error: "Paper PDF is required." }, { status: 400 });
    }
    const job = await createJob({
      paperPathname,
      paperName,
      contributorName: String(body.contributorName || ""),
      contributorGithub: String(body.contributorGithub || ""),
      osfUrl: String(body.osfUrl || ""),
      openMaterialsPathname: String(body.openMaterialsPathname || ""),
      openMaterialsName: String(body.openMaterialsName || ""),
    });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create job." },
      { status: 400 },
    );
  }
}
