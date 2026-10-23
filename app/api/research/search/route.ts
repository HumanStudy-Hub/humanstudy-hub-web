import { NextResponse } from "next/server";
import { searchResearch, validateResearchQuery } from "@/lib/research";

export const runtime = "nodejs";
export async function GET(request: Request) {
  let input;
  try { input = validateResearchQuery(new URL(request.url).searchParams); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid search." }, { status: 400 }); }
  try {
    return NextResponse.json(await searchResearch(input), { headers: { "Cache-Control": "public, max-age=30" } });
  } catch {
    return NextResponse.json({ error: "The research catalog could not be loaded. Try again shortly." }, { status: 503 });
  }
}
