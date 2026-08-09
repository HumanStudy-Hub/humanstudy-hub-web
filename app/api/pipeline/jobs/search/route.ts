import { NextResponse } from "next/server";
import { findJobsByContributor } from "@/lib/github-jobs";

export const runtime = "nodejs";

// Lets a researcher find a job again from their own name after closing the tab.
export async function GET(request: Request) {
  const name = new URL(request.url).searchParams.get("contributor") || "";
  if (name.trim().length < 2) {
    return NextResponse.json({ error: "Enter the name you submitted the paper under." }, { status: 400 });
  }
  try {
    const jobs = await findJobsByContributor(name);
    return NextResponse.json({
      jobs: jobs.map((job) => ({
        id: job.id,
        paperName: job.paperName,
        status: job.status,
        message: job.message,
        createdAt: job.createdAt,
        contributorName: job.contributorName,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not search jobs." }, { status: 500 });
  }
}
