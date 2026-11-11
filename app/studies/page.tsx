import Link from "next/link";
import ArrowRight from "@/components/ArrowRight";
import { libraryFilters, libraryAvailability, searchLibrary, validateResearchQuery, type LibraryFilter } from "@/lib/research";
import ValidatedFilter from "./ValidatedFilter";
import styles from "./page.module.css";

type SearchParams = { q?: string; offset?: string; pool?: string; status?: string; validated?: string };
const views = [
  ["all", "All papers"],
  ["program", "Interactive papers"],
] as const;

export default async function StudiesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const filter = libraryFilters.find(key => key === params.status)
    ?? (params.pool === "pending" ? "indexed" : "all");
  const validatedOnly = params.validated === "1";
  const raw = new URLSearchParams();
  if (typeof params.q === "string") raw.set("q", params.q);
  if (typeof params.offset === "string") raw.set("offset", params.offset);

  let error = "";
  let result: Awaited<ReturnType<typeof searchLibrary>> | null = null;
  try {
    const input = validateResearchQuery(raw);
    try {
      result = await searchLibrary(input, filter, validatedOnly);
    } catch {
      error = "The research library could not be loaded. Try again shortly.";
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Invalid search.";
  }

  const link = (status: LibraryFilter, offset?: number) => {
    const query = new URLSearchParams();
    if (params.q) query.set("q", params.q);
    if (status !== "all") query.set("status", status);
    if (validatedOnly) query.set("validated", "1");
    if (offset !== undefined) query.set("offset", String(offset));
    return query.size ? `/studies?${query}` : "/studies";
  };

  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <h1>Study Library</h1>
      </header>

      <form id="study-search" action="/studies" className={styles.search} role="search">
        {filter !== "all" && <input type="hidden" name="status" value={filter} />}
        <label className={styles.searchField}>
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
            focusable="false"
          >
            <circle cx="10.5" cy="10.5" r="6.5" />
            <path d="m16 16 5 5" />
          </svg>
          <input
            name="q"
            defaultValue={params.q || ""}
            aria-label="Search papers"
            placeholder="Search a topic, paper or author"
          />
        </label>
        <button type="submit">Search <ArrowRight /></button>
      </form>

      {error && <p role="alert" className={styles.error}>{error}</p>}
      {result && (
        <>
          <div className={styles.toolbar}>
            <nav aria-label="Paper views" className={styles.filters}>
              {views.map(([key, label]) => (
                <Link key={key} href={link(key)} aria-current={filter === key ? "page" : undefined}>
                  {label}
                </Link>
              ))}
            </nav>
            <ValidatedFilter checked={validatedOnly} />
          </div>
          <p className={styles.count}>{result.total} {result.total === 1 ? "paper" : "papers"}</p>
          <div className={styles.studyList}>
            {result.items.map(paper => {
              const status = libraryAvailability(paper);
              const href = `/studies/${paper.id}`;
              const label = status.program ? "Interact with paper" : "View paper";
              return (
                <article key={paper.id} className={styles.study}>
                  <div>
                    <h2><Link href={href}>{paper.title}</Link></h2>
                    {((paper.authors ?? []).length > 0 || paper.year) && (
                      <p className={styles.authors}>
                        {[(paper.authors ?? []).join(", "), paper.year].filter(Boolean).join(" · ")}
                      </p>
                    )}
                    {status.validated && <p className={styles.validated}>Validated protocol</p>}
                  </div>
                  <div className={styles.actions}>
                    <Link className={styles.primary} href={status.program ? `${href}#paper-program` : href} aria-label={`${label}: ${paper.title}`}>
                      {label} <ArrowRight />
                    </Link>
                    {(status.program || status.publicProtocol) && (
                      <Link href={`${href}#run-experiment`} aria-label={`Run experiment: ${paper.title}`}>Run experiment</Link>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          {result.total === 0 && <p className={styles.empty}>No papers match this view.</p>}

          {(result.offset > 0 || result.nextOffset !== null) && <nav aria-label="Research pages" className={styles.pagination}>
            {result.offset > 0 ? (
              <Link href={link(filter, Math.max(0, result.offset - result.limit))}>← Previous</Link>
            ) : <span />}
            {result.nextOffset !== null && <Link href={link(filter, result.nextOffset)}>Next →</Link>}
          </nav>}
        </>
      )}
    </div>
  );
}
