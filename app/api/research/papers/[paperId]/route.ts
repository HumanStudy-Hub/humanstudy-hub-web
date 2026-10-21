import { NextResponse } from "next/server";
import { getResearchPaper } from "@/lib/research";

export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ paperId: string }> }) {
  const { paperId } = await params;
  if (!/^paper_[a-f0-9]{24}$/.test(paperId)) return NextResponse.json({ error: "Invalid paper identity." }, { status: 400 });
  try {
    const paper = await getResearchPaper(paperId);
    return NextResponse.json(paper || { error: "Research not found." }, { status: paper ? 200 : 404 });
  } catch { return NextResponse.json({ error: "Catalog unavailable." }, { status: 503 }); }
}
