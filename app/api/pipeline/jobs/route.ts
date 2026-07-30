import { NextResponse } from "next/server";
import { createJob } from "@/lib/github-jobs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const paper = form.get("paper");
    if (!(paper instanceof File)) {
      return NextResponse.json({ error: "Paper PDF is required." }, { status: 400 });
    }
    const job = await createJob({
      paper,
      experimentId: String(form.get("experimentId") || ""),
      contributorName: String(form.get("contributorName") || ""),
      contributorGithub: String(form.get("contributorGithub") || ""),
      osfUrl: String(form.get("osfUrl") || ""),
    });
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not create job." },
      { status: 400 },
    );
  }
}
