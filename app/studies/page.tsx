import Link from "next/link";
import { searchLibrary, validateResearchQuery, type ResearchPaper } from "@/lib/research";

export default async function StudiesPage({ searchParams }: { searchParams: Promise<{ q?: string; offset?: string; pool?: string }> }) {
  const params = await searchParams;
  const pending = params.pool === "pending";
  const raw = new URLSearchParams();
  if (typeof params.q === "string") raw.set("q", params.q);
  if (typeof params.offset === "string") raw.set("offset", params.offset);
  let input, error = "";
  try { input = validateResearchQuery(raw); }
  catch (e) { error = e instanceof Error ? e.message : "Invalid search."; }
  let result: Awaited<ReturnType<typeof searchLibrary>> | null = null;
  if (input) {
    try { result = await searchLibrary(input, pending ? "pending" : "extracted"); }
    catch { error = "The research library could not be loaded. Try again shortly."; }
  }
  const link = (extra: Record<string, string>) => `/studies?${new URLSearchParams({ ...(params.q ? { q: params.q } : {}), ...(pending ? { pool: "pending" } : {}), ...extra })}`;
  const otherPool = `/studies?${new URLSearchParams({ ...(params.q ? { q: params.q } : {}), ...(pending ? {} : { pool: "pending" }) })}`;
  return (
    <div className="bg-white min-h-screen border-t border-gray-100">
      <div className="mx-auto max-w-5xl px-6 py-12 lg:px-8">
        {pending && <Link href={otherPool} className="text-sm text-cyan-800">← Research library</Link>}
        <h1 className="text-2xl font-bold font-serif text-gray-900">{pending ? "Not yet extracted" : "Research library"}</h1>
        {pending && <p className="mt-2 text-sm text-gray-600">Papers we have indexed but not yet turned into a Human Program. They have no materials or artifacts yet.</p>}
        <form action="/studies" className="my-6 flex gap-2" role="search">
          {pending && <input type="hidden" name="pool" value="pending" />}
          <input name="q" defaultValue={params.q || ""} aria-label="Search research" placeholder="Search a topic, paper or author" className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-cyan-500" />
          <button className="rounded-lg bg-cyan-700 px-4 py-2 text-sm text-white">Search</button>
        </form>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {result && <>
          <p className="mb-4 text-xs text-gray-500">{result.total} {result.total === 1 ? "paper" : "papers"}</p>
          <div className="grid gap-3 lg:grid-cols-2">
            {result.items.map((paper: ResearchPaper) => <Link key={paper.id} href={`/studies/${paper.id}`} className="rounded-xl border border-gray-200 p-4 hover:border-cyan-300 transition-colors">
              <p className="text-sm font-semibold text-gray-900">{paper.title}</p>
              {((paper.authors ?? []).length > 0 || paper.year) && <p className="mt-1 text-xs text-gray-500">{[(paper.authors ?? []).join(", "), paper.year].filter(Boolean).join(" · ")}</p>}
              <p className="mt-2 text-xs text-cyan-800">{paper.currentRevision ? "Human Program" : paper.legacyStudyId ? "Study materials" : "Not yet extracted"}</p>
            </Link>)}
          </div>
          {result.total === 0 && <p className="py-8 text-sm text-gray-600">No matching papers.</p>}
          <nav aria-label="Research pages" className="mt-6 flex justify-between text-sm text-cyan-800">
            {result.offset > 0 ? <Link href={link({ offset: String(Math.max(0, result.offset - result.limit)) })}>← Previous</Link> : <span />}
            {result.nextOffset !== null && <Link href={link({ offset: String(result.nextOffset) })}>Next →</Link>}
          </nav>
          {!pending && result.other > 0 && <p className="mt-10 border-t border-gray-100 pt-6 text-sm text-gray-600">
            <Link href={otherPool} className="text-cyan-800">{result.other} indexed papers not yet extracted →</Link>
          </p>}
        </>}
      </div>
    </div>
  );
}
