import { NextResponse } from "next/server";
import { listBenchmarkMaterials } from "@/lib/github-jobs";

export const runtime = "nodejs";

// Preview a benchmark study's experiment materials and items before running, so
// the researcher can scope a run to one material instead of the whole study.
export async function GET(_request: Request, context: { params: Promise<{ studyId: string }> }) {
  try {
    const { studyId } = await context.params;
    return NextResponse.json(
      { materials: await listBenchmarkMaterials(studyId) },
      { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } },
    );
  } catch (error) {
    console.error("material catalog error", error);
    return NextResponse.json({ error: "Study materials could not be loaded." }, { status: 502 });
  }
}
