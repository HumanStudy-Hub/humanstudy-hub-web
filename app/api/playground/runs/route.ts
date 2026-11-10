import { NextResponse } from "next/server";
import { createRun, listRunsByStudy } from "@/lib/playground-runs";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const studyId = new URL(request.url).searchParams.get("study") || "";
    if (!studyId) return NextResponse.json({ runs: [] });
    return NextResponse.json({ runs: await listRunsByStudy(studyId) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not list runs." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const run = await createRun({
      studyId: String(body.studyId || ""),
      jobId: body.jobId ? String(body.jobId) : undefined,
      packageSlug: body.packageSlug ? String(body.packageSlug) : undefined,
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
      selection: body.selection,
      // v0.8 protocol runs (off unless PROTOCOL_RUNS_ENABLED=1); validated in lib/playground-runs.
      kind: body.kind ? String(body.kind) : undefined,
      store: body.store ? String(body.store) : undefined,
      rendering: body.rendering ? String(body.rendering) : undefined,
      n: body.n,
      seeds: body.seeds,
      arms: body.arms,
    });
    return NextResponse.json({ run }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not start this run." },
      { status: 400 },
    );
  }
}
