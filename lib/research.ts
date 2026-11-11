import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import development from "../data/studies-in-development.json";

type ResearchPublication = { kind: "user-submitted" | "maintainer-reviewed-protocol"; revision: string };

export type ResearchPaper = {
  id: string; title: string; authors: string[]; year: number | null; description?: string;
  aliases: string[]; legacyStudyId?: string; currentRevision: string | null;
  assetRoot?: string; assetFiles?: { path: string; sha256: string; bytes: number }[];
  conceptIds: string[]; capabilities: Record<string, boolean>; coverage: string;
  searchText: string; studies: { id: string; title: string; searchText?: string; evidenceIds?: string[] }[];
  resources: { id: string; kind: string; url?: string; access: string; license?: string }[];
  /** v0.8 protocol summary (Bench catalog, B3). Absent on papers without a protocol.json revision. */
  protocol?: unknown;
  publication?: ResearchPublication;
  developmentStage?: "draft" | "preparation";
  [key: string]: unknown;
};

/**
 * What the study page shows of a v0.8 protocol: metadata only, never protocol content.
 * Bench writes `paper.protocol` in research_index.json from `hsenv study sync`; the shape
 * is read tolerantly (unknown fields ignored, malformed fields dropped), so a newer
 * schema never breaks the page.
 */
export type ResearchProtocol = {
  slug: string;
  schemaVersion: string;
  /** False when the index carries a schema this site was not written for (shown, not hidden). */
  schemaKnown: boolean;
  /** Protocol v1 (hsenv engine schema): the only schema a protocol run is dispatched for. */
  schemaRunnable: boolean;
  hsenv?: string;
  fidelity: { verdict: string | null; signedBy: string[] };
  /** `label` is what the page shows: the index's label, else the id with underscores as spaces. */
  arms: { id: string; label: string; runnable: boolean; nPaper: number | null }[];
  runExcluded: { what: string; reason?: string }[];
  effects: number | null;
  revision: string | null;
  /**
   * Participant view, screen by screen per arm. Protocols are private by policy, so this is
   * set only when the entry explicitly marks the preview public (`previewPublic: true` or
   * `preview_public: true`) and the URL is https. Otherwise null and the page shows no link.
   */
  preview: string | null;
};

/** "1" = protocol v1, what Bench catalog.py writes (engine schema_version). "0.8" = early entries, read only. */
export const PROTOCOL_SCHEMA_RUNNABLE = "1";
const PROTOCOL_SCHEMA_LEGACY = "0.8";
const sameMajor = (version: string, major: string) => version === major || version.startsWith(`${major}.`);

const str = (v: unknown, max = 200) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const httpsUrl = (v: unknown) => {
  try { const url = new URL(String(v ?? "")); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; }
  catch { return null; }
};

export function readProtocol(paper: Pick<ResearchPaper, "protocol">): ResearchProtocol | null {
  const raw = paper.protocol;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const slug = str(p.slug, 200);
  // Same shape as hsenv study ids; no dots or slashes, so it is safe in a store path.
  if (!slug || slug.length > 80 || !/^[a-z0-9][a-z0-9_-]*$/.test(slug)) return null;
  const schemaVersion = str(p.schemaVersion ?? p.schema_version, 20) ?? "unknown";
  const fid = p.fidelity && typeof p.fidelity === "object" ? p.fidelity as Record<string, unknown> : {};
  const signed = fid.signedBy ?? fid.signed_by;
  const arms = (Array.isArray(p.arms) ? p.arms : []).flatMap((a): ResearchProtocol["arms"] => {
    if (!a || typeof a !== "object") return [];
    const arm = a as Record<string, unknown>, id = str(arm.id, 80);
    const n = Number(arm.nPaper ?? arm.n_paper);
    const label = str(arm.label, 120) ?? id?.replace(/_+/g, " ");
    return id && label ? [{ id, label, runnable: arm.runnable === true, nPaper: Number.isInteger(n) && n > 0 ? n : null }] : [];
  }).slice(0, 50);
  const runExcluded = (Array.isArray(p.runExcluded) ? p.runExcluded : []).flatMap((x): ResearchProtocol["runExcluded"] => {
    if (typeof x === "string") return x.trim() ? [{ what: x.trim().slice(0, 200) }] : [];
    if (!x || typeof x !== "object") return [];
    const e = x as Record<string, unknown>, what = str(e.what ?? e.id);
    return what ? [{ what, reason: str(e.reason, 400) ?? undefined }] : [];
  }).slice(0, 50);
  const effects = Number(p.effects);
  const revision = str(p.revision, 64);
  return {
    slug, schemaVersion,
    schemaKnown: sameMajor(schemaVersion, PROTOCOL_SCHEMA_RUNNABLE) || sameMajor(schemaVersion, PROTOCOL_SCHEMA_LEGACY),
    schemaRunnable: sameMajor(schemaVersion, PROTOCOL_SCHEMA_RUNNABLE),
    hsenv: str(p.hsenv, 40) ?? undefined,
    fidelity: {
      // "high_fidelity", "HIGH FIDELITY" and "high fidelity" are one verdict.
      verdict: str(fid.verdict, 80)?.replace(/[_\s]+/g, " ").toLowerCase() ?? null,
      signedBy: (Array.isArray(signed) ? signed : [signed]).map(s => str(s, 80)).filter((s): s is string => Boolean(s)),
    },
    arms, runExcluded,
    effects: Number.isInteger(effects) && effects >= 0 ? effects : null,
    revision: revision && /^[a-f0-9]{64}$/.test(revision) ? revision : null,
    preview: (p.previewPublic ?? p.preview_public) === true ? httpsUrl(p.preview) : null,
  };
}
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
  const index = value as ResearchIndex & { publications?: Record<string, unknown> };
  if (index?.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(index.snapshot) || !Array.isArray(index.papers)
      || !Array.isArray(index.taxonomy?.concepts)) throw new Error("Invalid research index.");
  const ids = new Set<string>();
  const papers = index.papers.map(paper => {
    if (!/^paper_[a-f0-9]{24}$/.test(paper.id) || !paper.title || !Array.isArray(paper.aliases) || ids.has(paper.id))
      throw new Error("Invalid or duplicate paper identity.");
    ids.add(paper.id);
    // Paper records may contain contributor metadata. Only the catalog-level publication index is authoritative.
    const record = index.publications?.[paper.id] as Partial<ResearchPublication> | undefined;
    const revision = record?.revision;
    const kind = record?.kind;
    const publication = revision && /^[a-f0-9]{64}$/.test(revision) && revision === paper.currentRevision
      && (kind === "user-submitted" || kind === "maintainer-reviewed-protocol")
      ? { kind, revision } : undefined;
    return { ...paper, publication };
  });
  return { ...index, papers };
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

export const libraryFilters = ["all", "program", "runnable", "protocol", "development", "indexed"] as const;
export type LibraryFilter = (typeof libraryFilters)[number];

export function libraryAvailability(paper: ResearchPaper) {
  const files = paper.assetFiles ?? [];
  const program = Boolean(paper.currentRevision && files.some(file => file.path === "program.json"));
  const protocol = readProtocol(paper);
  const publicProtocol = Boolean(protocol && paper.currentRevision && protocol.revision === paper.currentRevision
    && files.some(file => file.path === "protocol.json"));
  const run = (paper.studyCapabilities as { run?: { status?: string } } | undefined)?.run?.status;
  const runnableDraft = program && paper.capabilities?.replayable === true && (run === "yes" || run === "partial")
    && files.some(file => /^package\/[^/]+\/task\/adapter\.py$/.test(file.path));
  const runnable = runnableDraft || Boolean(publicProtocol && protocol?.schemaRunnable && protocol.arms.some(arm => arm.runnable));
  const publication = paper.publication?.revision === paper.currentRevision ? paper.publication?.kind : undefined;
  const validated = Boolean(publication === "maintainer-reviewed-protocol" && publicProtocol && protocol?.schemaRunnable
    && protocol.fidelity.verdict === "high fidelity" && protocol.fidelity.signedBy.length
    && protocol.arms.some(arm => arm.runnable));
  return { program, runnable, publicProtocol, validated, userSubmitted: publication === "user-submitted", inDevelopment: Boolean(paper.developmentStage && !publicProtocol) };
}

export function includeDevelopment(index: ResearchIndex): ResearchIndex {
  const papers = new Map(index.papers.map(paper => [paper.id, paper]));
  const aliases = new Map<string, ResearchPaper[]>();
  for (const paper of index.papers) {
    const identities = [...paper.aliases, typeof paper.doi === "string" ? "doi:" + paper.doi : ""];
    for (const key of new Set(identities.map(alias => alias.toLowerCase()))) {
      if (!key.startsWith("doi:")) continue;
      const matches = aliases.get(key) ?? [];
      matches.push(paper);
      aliases.set(key, matches);
    }
  }
  for (const { doi, title, authors, year, stage } of development.papers) {
    const alias = "doi:" + doi;
    const matches = aliases.get(alias) ?? [];
    const id = "paper_" + createHash("sha256").update(alias).digest("hex").slice(0, 24);
    const developmentStage = stage === "draft" ? "draft" : "preparation";
    if (matches.length > 1) continue;
    const existing = matches[0] ?? papers.get(id);
    if (existing) {
      papers.set(existing.id, { ...existing, developmentStage });
      continue;
    }
    papers.set(id, {
      id, doi, title, authors, year, developmentStage, aliases: [alias], currentRevision: null,
      conceptIds: [], capabilities: { discoverable: true }, coverage: "indexed-metadata", searchText: doi, studies: [],
      resources: [{ id: alias, kind: "original-paper", url: "https://doi.org/" + doi, access: "Publisher" }],
    });
  }
  return { ...index, papers: [...papers.values()] };
}

export async function searchLibrary(input: ResearchQuery, filter: LibraryFilter, validatedOnly = false) {
  const index = includeDevelopment(await getResearchIndex());
  const buckets: Record<LibraryFilter, ResearchPaper[]> = {
    all: [], program: [], runnable: [], protocol: [], development: [], indexed: [],
  };
  for (const paper of index.papers) {
    const status = libraryAvailability(paper);
    if (status.program) buckets.program.push(paper);
    if (status.runnable) buckets.runnable.push(paper);
    if (status.publicProtocol) buckets.protocol.push(paper);
    if (status.inDevelopment) buckets.development.push(paper);
    if (!status.program && !status.publicProtocol && !status.inDevelopment) buckets.indexed.push(paper);
  }
  buckets.all = index.papers;
  const papers = validatedOnly ? buckets[filter].filter(paper => libraryAvailability(paper).validated) : buckets[filter];
  const counts = Object.fromEntries(libraryFilters.map(key => [key, buckets[key].length])) as Record<LibraryFilter, number>;
  const { offset = 0, limit = 30 } = input;
  const result = searchSnapshot({ ...index, papers }, input);
  return { ...result, counts, offset, limit, nextOffset: offset + limit < result.total ? offset + limit : null };
}

export async function getResearchPaper(identity: string): Promise<ResearchPaper | null> {
  // The library lists the live snapshot. Resolve its links from that same
  // catalog, rather than a database mirror that may not have synced a new paper.
  const index = includeDevelopment(await getResearchIndex());
  const matches = index.papers.filter((paper) => paper.id === identity || paper.aliases.includes(identity));
  return matches.length === 1 ? matches[0] : null;
}
