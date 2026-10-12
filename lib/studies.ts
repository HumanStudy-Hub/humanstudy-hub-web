import { promises as fs } from "node:fs";
import path from "node:path";

export type Contributor = { name: string; github?: string; institution?: string };
export type StudyEntry = {
  study_id: string;
  title: string;
  authors: string[];
  year: number | null;
  description: string;
  contributors?: Contributor[];
};

const indexUrl = process.env.STUDIES_INDEX_URL
  || "https://raw.githubusercontent.com/HumanStudy-Hub/HumanStudy-Bench/main/co_website/data/studies_index.json";

function studiesFrom(value: unknown): StudyEntry[] {
  if (!value || typeof value !== "object" || !("studies" in value)) return [];
  const studies = (value as { studies?: unknown }).studies;
  return Array.isArray(studies) ? studies as StudyEntry[] : [];
}

export async function getStudies(): Promise<StudyEntry[]> {
  try {
    const response = await fetch(indexUrl, { next: { revalidate: 60 } });
    if (response.ok) return studiesFrom(await response.json());
  } catch {
    // Local development can continue from the bundled snapshot while offline.
  }
  const local = await fs.readFile(path.join(process.cwd(), "data/studies_index.json"), "utf8");
  return studiesFrom(JSON.parse(local));
}

export type CommunityPaper = { paperKey: string; paper: Record<string, unknown> | null; contributions: Record<string, unknown>[] };

// The index's `community` array lives on whichever Bench branch carries the community layout
// until it reaches main; COMMUNITY_INDEX_BRANCH points at that branch.
function communityIndexUrl(): string {
  const branch = process.env.COMMUNITY_INDEX_BRANCH;
  if (!branch) return indexUrl;
  return indexUrl.replace(/\/HumanStudy-Bench\/[^/]+\/co_website\//, `/HumanStudy-Bench/${branch}/co_website/`);
}

export async function getCommunityPapers(): Promise<CommunityPaper[]> {
  try {
    const response = await fetch(communityIndexUrl(), { next: { revalidate: 60 } });
    if (!response.ok) return [];
    const value = (await response.json()) as { community?: unknown };
    return Array.isArray(value.community) ? (value.community as CommunityPaper[]) : [];
  } catch {
    return [];
  }
}
