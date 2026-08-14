import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

const ALLOWED_STUDIES = new Set(Array.from({ length: 12 }, (_, index) => `study_${String(index + 1).padStart(3, "0")}`));
const REPOSITORY_ROOT = "https://raw.githubusercontent.com/HumanStudy-Hub/HumanStudy-Bench/main/studies";

async function readPreparedJson(studyId: string, relativePath: string) {
  try {
    // The interview build normally lives beside HSBench-Community, so use the
    // curated files directly with no network or extraction delay.
    const localPath = path.join(process.cwd(), "..", "HSBench-Community", "studies", studyId, relativePath);
    return JSON.parse(await fs.readFile(localPath, "utf8")) as unknown;
  } catch {
    // Deployed builds fall back to the canonical prepared package.
    const response = await fetch(`${REPOSITORY_ROOT}/${studyId}/${relativePath}`, { next: { revalidate: 3600 } });
    if (!response.ok) throw new Error(`Could not load ${relativePath}`);
    return response.json() as Promise<unknown>;
  }
}

async function readPreparedMaterials(studyId: string, specification: unknown) {
  try {
    const materialDir = path.join(process.cwd(), "..", "HSBench-Community", "studies", studyId, "source", "materials");
    const names = (await fs.readdir(materialDir)).filter((name) => name.endsWith(".json")).sort();
    const entries = await Promise.all(names.map(async (name) => [
      name.replace(/\.json$/, ""),
      JSON.parse(await fs.readFile(path.join(materialDir, name), "utf8")) as unknown,
    ] as const));
    if (entries.length > 0) return Object.fromEntries(entries);
  } catch {
    // Some curated studies keep their participant-facing content directly in
    // the specification rather than separate material files.
  }
  return { extracted_from_specification: specification };
}

export async function GET(_request: Request, context: { params: Promise<{ studyId: string }> }) {
  const { studyId } = await context.params;
  if (!ALLOWED_STUDIES.has(studyId)) {
    return NextResponse.json({ error: "This study is not available in the usability test." }, { status: 404 });
  }

  try {
    const [metadata, specification, groundTruth] = await Promise.all([
      readPreparedJson(studyId, "source/metadata.json"),
      readPreparedJson(studyId, "source/specification.json"),
      readPreparedJson(studyId, "source/ground_truth.json"),
    ]);
    const materials = await readPreparedMaterials(studyId, specification);
    const jsonFile = (reviewPath: string, value: unknown) => ({
      path: `${studyId}/${reviewPath}`,
      content: `${JSON.stringify(value, null, 2)}\n`,
    });
    const files = [
      jsonFile("study.json", metadata),
      jsonFile("materials/materials.json", materials),
      jsonFile("task/task.json", specification),
      jsonFile("audit/missing_information.json", {
        status: "prepared benchmark",
        unresolved_items: [],
        note: "This curated benchmark package was prepared before the usability session. Reviewers should still record anything they find missing or ambiguous.",
      }),
      {
        path: `${studyId}/audit/agent_report.md`,
        content: `# Prepared extraction\n\nThe extraction for **${studyId}** was completed before this usability session. Review the study overview, participant-facing materials, runnable task, and published findings. Record any missing or ambiguous information in the review note.\n`,
      },
      jsonFile("analysis/ground_truth.json", groundTruth),
    ];
    return NextResponse.json({ studyId, files });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load the prepared extraction." },
      { status: 502 },
    );
  }
}
