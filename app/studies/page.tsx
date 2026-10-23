import Link from "next/link";
import { searchResearch, validateResearchQuery, type ResearchPaper } from "@/lib/research";

export default async function StudiesPage({ searchParams }: { searchParams: Promise<{ q?: string; offset?: string }> }) {
  const params = await searchParams;
  const raw = new URLSearchParams();
  if (typeof params.q === "string") raw.set("q", params.q);
  if (typeof params.offset === "string") raw.set("offset", params.offset);
  let input, error = "";
  try { input = validateResearchQuery(raw); }
  catch (e) { error = e instanceof Error ? e.message : "Invalid search."; }
  let result: Awaited<ReturnType<typeof searchResearch>> | null = null;
  if (input) {
    try { result = await searchResearch(input); }
    catch { error = "The research library could not be loaded. Try again shortly."; }
  }
  const pageUrl = (offset: number) => `/studies?${new URLSearchParams({ q: params.q || "", offset: String(offset) })}`;
  return (
    <div className="bg-white min-h-screen border-t border-gray-100">
      <div className="mx-auto max-w-5xl px-6 py-12 lg:px-8">
        <h1 className="text-2xl font-bold font-serif text-gray-900">Research library</h1>
        <form action="/studies" className="my-6 flex gap-2" role="search">
          <input name="q" defaultValue={params.q || ""} aria-label="Search research" placeholder="Search a topic, paper or author" className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500" />
          <button className="rounded-lg bg-cyan-700 px-4 py-2 text-sm text-white">Search</button>
        </form>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {result && <>
          <p className="mb-4 text-xs text-gray-500">{result.total} papers in the indexed collection{result.source === "snapshot" ? " · Catalog snapshot" : ""}</p>
          <div className="grid gap-3 lg:grid-cols-2">
            {result.items.map((paper: ResearchPaper) => <Link key={paper.id} href={`/studies/${paper.id}`} className="rounded-xl border border-gray-200 p-4 hover:border-cyan-300 transition-colors">
              <p className="text-sm font-semibold text-gray-900">{paper.title}</p>
              {(paper.authors.length > 0 || paper.year) && <p className="mt-1 text-xs text-gray-500">{[paper.authors.join(", "), paper.year].filter(Boolean).join(" · ")}</p>}
              <p className="mt-2 text-xs text-cyan-800">{paper.currentRevision ? "Human Program" : paper.legacyStudyId ? "Study materials" : "Source indexed"}</p>
            </Link>)}
          </div>
          {result.total === 0 && <p className="py-8 text-sm text-gray-600">No matching papers in this collection.</p>}
          <nav aria-label="Research pages" className="mt-6 flex justify-between text-sm text-cyan-800">
            {result.offset > 0 ? <Link href={pageUrl(Math.max(0,result.offset-result.limit))}>← Previous</Link> : <span />}
            {result.nextOffset !== null && <Link href={pageUrl(result.nextOffset)}>Next →</Link>}
          </nav>
        </>}
      </div>
    </div>
  );
}
