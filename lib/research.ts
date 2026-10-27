import { promises as fs } from "node:fs";
import path from "node:path";

export type ResearchPaper = {
  id: string; title: string; authors: string[]; year: number | null; description?: string;
  aliases: string[]; legacyStudyId?: string; currentRevision: string | null;
  assetRoot?: string; assetFiles?: { path: string; sha256: string; bytes: number }[];
  conceptIds: string[]; capabilities: Record<string, boolean>; coverage: string;
  searchText: string; studies: { id: string; title: string; searchText?: string; evidenceIds?: string[] }[];
  resources: { id: string; kind: string; url?: string; access: string; license?: string }[];
  [key: string]: unknown;
};
export type ResearchIndex = {
  schemaVersion: 1; snapshot: string; taxonomyVersion: string; papers: ResearchPaper[];
  taxonomy: { concepts: { id: string; label: string; aliases: string[]; status: string }[] };
};
export type ResearchQuery = { query?: string; concept?: string; capability?: string; offset?: number; limit?: number };
const CAPABILITIES = new Set(["discoverable", "traceable", "reanalyzable", "replayable", "humanBenchmark"]);
export const normalise = (s: string) => s.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim();

export function validateResearchQuery(input: URLSearchParams): ResearchQuery {
  const query = input.get("q")?.trim() || "", concept = input.get("concept") || undefined;
  const capability = input.get("capability") || undefined;
  const number = (key: string, fallback: number) => {
    const raw = input.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`Invalid ${key}.`);
    return Number(raw);
  };
  const offset = number("offset", 0), limit = number("limit", 30);
  if (query.length > 500 || concept && !/^[a-z][a-z0-9-]*:[a-z0-9-]+$/.test(concept)) throw new Error("Invalid search.");
  if (capability && !CAPABILITIES.has(capability)) throw new Error("Unknown research capability.");
  if (limit < 1 || limit > 100) throw new Error("Limit must be between 1 and 100.");
  return { query, concept, capability, offset, limit };
}

function asIndex(value: unknown): ResearchIndex {
  const index = value as ResearchIndex;
  if (index?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(index.snapshot) || !Array.isArray(index.papers)
      || !Array.isArray(index.taxonomy?.concepts)) throw new Error("Invalid research index.");
  const ids = new Set<string>();
  for (const paper of index.papers) {
    if (!/^paper_[a-f0-9]{24}$/.test(paper.id) || !paper.title || !Array.isArray(paper.aliases) || ids.has(paper.id))
      throw new Error("Invalid or duplicate paper identity.");
    ids.add(paper.id);
  }
  return index;
}

export async function getResearchIndex(): Promise<ResearchIndex> {
  const url = process.env.RESEARCH_INDEX_URL || "https://raw.githubusercontent.com/HumanStudy-Hub/HumanStudy-Bench/main/co_website/data/research_index.json";
  try {
    const response = await fetch(url, { next: { revalidate: 60 }, signal: AbortSignal.timeout(8000) });
    if (response.ok) return asIndex(await response.json());
  } catch { /* A bundled snapshot keeps the catalog available while offline or during rollout. */ }
  return asIndex(JSON.parse(await fs.readFile(path.join(process.cwd(), "data/research_index.json"), "utf8")));
}

export function searchSnapshot(index: ResearchIndex, input: ResearchQuery) {
  const { query = "", concept, capability, offset = 0, limit = 30 } = input;
  const q = normalise(query), words = q.split(" ").filter(Boolean);
  const matchingConcepts = index.taxonomy.concepts.filter(c => c.status === "reviewed"
    && [c.label, ...c.aliases].some(s => normalise(s) === q));
  const concepts = matchingConcepts.map(c => c.id);
  const matched = index.papers.filter(p => (!concept || p.conceptIds.includes(concept))
      && (!capability || p.capabilities[capability] === true))
    .map(p => {
      const conceptMatch = p.conceptIds.some(id => concepts.includes(id));
      const title = normalise(p.title), body = normalise([p.description, p.searchText, ...p.authors].join("\n"));
      const identity = p.id === query || p.aliases.includes(query);
      const aliasContent = matchingConcepts.some(c => normalise(c.label).split(' ').every(w => title.includes(w) || body.includes(w)));
      const textMatch = words.every(w => title.includes(w) || body.includes(w));
      return { paper: p, matches: !q || identity || conceptMatch || textMatch || aliasContent,
        rank: identity ? 100 : conceptMatch ? 20 : title.includes(q) ? 10 : 1,
        matchedBy: identity ? "identity" : conceptMatch ? "reviewed-concept" : aliasContent ? "concept-alias-content" : "indexed-content" };
    }).filter(p => p.matches).sort((a, b) => b.rank - a.rank || a.paper.id.localeCompare(b.paper.id));
  return { items: matched.slice(offset, offset + limit).map(({ paper, matchedBy }) => ({ ...paper, matchedBy })),
    total: matched.length, snapshot: index.snapshot, taxonomyVersion: index.taxonomyVersion };
}

function databaseConfig() {
  // Public, read-only search runs with the publishable key so RLS applies; never the service role.
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    || process.env.SUPABASE_ANON_KEY;
  return url && key ? { url, key } : null;
}

export async function searchResearch(input: ResearchQuery) {
  const { query = "", concept, capability, offset = 0, limit = 30 } = input;
  const config = databaseConfig();
  if (config) {
    try {
      const response = await fetch(`${config.url}/rest/v1/rpc/search_research_catalog`, {
        method: "POST", cache: "no-store", signal: AbortSignal.timeout(5000),
        headers: { apikey: config.key, "Content-Type": "application/json" },
        body: JSON.stringify({ query_text: query, concept_filter: concept ? [concept] : [],
          capability_filter: capability || null, page_offset: offset, page_size: limit }),
      });
      if (!response.ok) throw new Error("Research database unavailable.");
      const result = await response.json();
      if (!result.snapshot || !Array.isArray(result.items) || typeof result.total !== "number") throw new Error("Catalog not initialized.");
      return { ...result, source: "database" as const, scope: "indexed-corpus" as const, offset, limit,
        nextOffset: offset + limit < result.total ? offset + limit : null };
    } catch { /* The migration and first sync may not have reached this environment yet. */ }
  }
  const result = searchSnapshot(await getResearchIndex(), input);
  return { ...result, source: "snapshot" as const, scope: "indexed-corpus" as const, offset, limit,
    nextOffset: offset + limit < result.total ? offset + limit : null };
}

/** Papers we have extracted: a community Human Program or a benchmark study package. */
export const isExtracted = (p: Pick<ResearchPaper, "currentRevision" | "legacyStudyId">) => Boolean(p.currentRevision || p.legacyStudyId);

/** Library listing split into extracted papers and indexed papers not yet extracted. */
export async function searchLibrary(input: ResearchQuery, pool: "extracted" | "pending") {
  const index = await getResearchIndex();
  const papers = index.papers.filter(p => isExtracted(p) === (pool === "extracted"));
  const other = index.papers.length - papers.length;
  const { offset = 0, limit = 30 } = input;
  const result = searchSnapshot({ ...index, papers }, input);
  return { ...result, other, offset, limit, nextOffset: offset + limit < result.total ? offset + limit : null };
}

export async function getResearchPaper(identity: string): Promise<ResearchPaper | null> {
  const result = await searchResearch({ query: identity, limit: 100 });
  const matches = result.items.filter((paper: ResearchPaper) => paper.id === identity || paper.aliases.includes(identity));
  return matches.length === 1 ? matches[0] : null;
}
