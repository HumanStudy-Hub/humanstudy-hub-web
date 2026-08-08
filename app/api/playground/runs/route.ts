import { NextResponse } from "next/server";
import { createRun } from "@/lib/playground-runs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const run = await createRun({
      studyId: String(body.studyId || ""),
      model: String(body.model || ""),
      preset: String(body.preset || "v3_human_plus_demo"),
      systemPrompt: String(body.systemPrompt || ""),
      demographics: body.demographics,
      personaGroup: body.personaGroup ?? undefined,
      participantsPerScenario: Number(body.participantsPerScenario) || 8,
      temperature: Number(body.temperature ?? 1),
      seed: Number(body.seed ?? 42),
      researcherName: String(body.researcherName || ""),
      apiKey: String(body.apiKey || ""),
    });
    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not start this run." },
      { status: 400 },
    );
  }
}
