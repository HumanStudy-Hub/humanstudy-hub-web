import { createHash } from "node:crypto";
import type { ResearchPaper } from "@/lib/research";
import { validateHumanProgram, type HumanProgram } from "@/lib/studio/human-program";

const rawBench = "https://raw.githubusercontent.com/HumanStudy-Hub/HumanStudy-Bench/main/";

function revisionRoot(paper: ResearchPaper) {
  if (!/^paper_[a-f0-9]{24}$/.test(paper.id) || !/^[a-f0-9]{64}$/.test(paper.currentRevision ?? "")) return null;
  const root = `community/${paper.id}/revisions/${paper.currentRevision}`;
  return paper.assetRoot === root && Array.isArray(paper.assetFiles) ? root : null;
}

export function publishedAssetUrl(paper: ResearchPaper, path: string) {
  const root = revisionRoot(paper);
  const segments = path.split("/");
  if (!root || segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes("\\"))) return null;
  if (!paper.assetFiles?.some(file => file.path === path)) return null;
  return rawBench + root + "/" + segments.map(encodeURIComponent).join("/");
}

export async function getPublishedProgram(paper: ResearchPaper): Promise<HumanProgram | null> {
  const url = publishedAssetUrl(paper, "program.json");
  if (!url) return null;
  const entry = paper.assetFiles?.find(file => file.path === "program.json");
  if (!entry || !/^[a-f0-9]{64}$/.test(entry.sha256)) return null;
  try {
    const response = await fetch(url, { next: { revalidate: 300 }, signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return null;
    // Bench releases can exceed the interactive studio's editing and graph limits.
    return validateHumanProgram(JSON.parse(bytes.toString("utf8")), { published: true });
  } catch {
    return null;
  }
}
