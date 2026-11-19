import Link from "next/link";
import { paperWorkspace, paperWorkspacePath } from "@/lib/paper-workspace";
import { libraryFilters, libraryAvailability, researchContributorNames, searchLibrary, validateResearchQuery, type LibraryFilter } from "@/lib/research";
import LibrarySearch from "./LibrarySearch";
import PaperExplorer, { type ExplorerPaper } from "./PaperExplorer";
import ValidatedFilter from "./ValidatedFilter";
import styles from "./page.module.css";

type SearchParams = { q?: string; author?: string; discipline?: string; offset?: string; pool?: string; status?: string; validated?: string };
export default async function StudiesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const filter = libraryFilters.find(key => key === params.status)
    ?? (params.pool === "pending" ? "indexed" : "all");
  const validatedOnly = params.validated === "1";
  const author = typeof params.author === "string" ? params.author.trim() : "";
  const discipline = typeof params.discipline === "string" ? params.discipline : "";
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const raw = new URLSearchParams({ q: query });
  if (typeof params.offset === "string") raw.set("offset", params.offset);

  let error = "";
  let result: Awaited<ReturnType<typeof searchLibrary>> | null = null;
  try {
    const input = validateResearchQuery(raw);
    try {
      result = await searchLibrary({ ...input, author, discipline }, filter, validatedOnly);
    } catch {
      error = "The research library could not be loaded. Try again shortly.";
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Invalid search.";
  }

  const link = (status: LibraryFilter, offset?: number) => {
    const next = new URLSearchParams();
    if (query) next.set("q", query);
    next.set("status", status);
    if (author) next.set("author", author);
    if (discipline) next.set("discipline", discipline);
    if (validatedOnly) next.set("validated", "1");
    if (offset !== undefined) next.set("offset", String(offset));
    return `/studies?${next}`;
  };

  const papers: ExplorerPaper[] = (result?.items ?? []).map(paper => {
    const status = libraryAvailability(paper);
    const workspace = paperWorkspace({ paper: paper.id, revision: paper.currentRevision });
    return {
      id: paper.id, title: paper.title, authors: paper.authors ?? [], year: paper.year,
      description: paper.description ?? "", discipline: paper.discipline.label,
      programHref: status.program && workspace ? paperWorkspacePath(workspace) : null,
      canRun: status.program || status.publicProtocol, validated: status.validated,
      userSubmitted: status.userSubmitted, contributors: researchContributorNames(paper),
    };
  });

  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <h1>Study Library</h1>
        <Link href="/contribute">Contribute a study</Link>
      </header>
      <LibrarySearch key={JSON.stringify([query, author, discipline, filter])} query={query} author={author}
        discipline={discipline} status={filter} disciplines={result?.disciplines ?? []} />
      {error && <p role="alert" className={styles.error}>{error}</p>}
      {result && (
        <>
          <div className={styles.toolbar}>
            {filter !== "all" && <Link className={styles.allPapers} href={link("all")}>Search all papers</Link>}
            <ValidatedFilter checked={validatedOnly} />
            <p className={styles.count}>{result.total} {result.total === 1 ? "paper" : "papers"}</p>
          </div>
          {papers.length > 0 && <PaperExplorer key={link(filter, result.offset)} papers={papers}
            previousHref={result.offset > 0 ? link(filter, Math.max(0, result.offset - result.limit)) : null}
            nextHref={result.nextOffset !== null ? link(filter, result.nextOffset) : null} />}
          {papers.length === 0 && <div className={styles.empty}>
            <p>No papers match this view.</p>
            <Link href={`/studies?status=${filter}`}>Reset filters</Link>
            {result.offset > 0 && <Link href={link(filter, 0)}>Back to first page</Link>}
          </div>}
        </>
      )}
    </div>
  );
}
