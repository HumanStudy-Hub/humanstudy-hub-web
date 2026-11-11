import Link from "next/link";
import ArrowRight from "@/components/ArrowRight";
import { developmentUpdated, libraryAvailability, searchLibrary, validateResearchQuery, type LibraryFilter } from "@/lib/research";
import styles from "./page.module.css";

type SearchParams = { q?: string; offset?: string; pool?: string; status?: string };
const filters = [
  ["all", "All indexed"],
  ["program", "Human Study Programs"],
  ["runnable", "Runnable experiments"],
  ["protocol", "Public protocols"],
  ["development", "In development"],
  ["indexed", "Awaiting extraction"],
] as const satisfies readonly (readonly [LibraryFilter, string])[];

export default async function StudiesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const filter = filters.find(([key]) => key === params.status)?.[0]
    ?? (params.pool === "pending" ? "indexed" : "all");
  const raw = new URLSearchParams();
  if (typeof params.q === "string") raw.set("q", params.q);
  if (typeof params.offset === "string") raw.set("offset", params.offset);

  let error = "";
  let result: Awaited<ReturnType<typeof searchLibrary>> | null = null;
  try {
    const input = validateResearchQuery(raw);
    try {
      result = await searchLibrary(input, filter);
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
    if (offset !== undefined) query.set("offset", String(offset));
    return query.size ? `/studies?${query}` : "/studies";
  };

  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <h1>Study Library</h1>
        <p>Search papers and see what you can read or run.</p>
      </header>

      <form action="/studies" className={styles.search} role="search">
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
            aria-label="Search research"
            placeholder="Search a topic, paper or author"
          />
        </label>
        <button type="submit">Search <ArrowRight /></button>
      </form>

      {error && <p role="alert" className={styles.error}>{error}</p>}
      {result && (
        <>
          <nav aria-label="Filter studies by availability" className={styles.filters}>
            {filters.map(([key, label]) => (
              <Link key={key} href={link(key)} aria-current={filter === key ? "page" : undefined}>
                {label} <span>{result.counts[key]}</span>
              </Link>
            ))}
          </nav>
          <p className={styles.count}>
            {result.total} {result.total === 1 ? "record" : "records"}
            {filter === "development" && <> · Claude queue snapshot, {developmentUpdated}</>}
          </p>
          <div className={styles.studyList}>
            {result.items.map(paper => {
              const status = libraryAvailability(paper);
              const labels: string[] = [];
              if (status.program) labels.push("Human Study Program");
              if (status.runnable) labels.push(status.publicProtocol ? "Runnable" : "Runnable draft");
              if (status.publicProtocol) labels.push(status.validated ? "Validated protocol" : "Public protocol");
              if (status.inDevelopment) labels.push(paper.developmentStage === "draft" ? "Protocol draft in development" : "Materials in preparation");
              if (!labels.length) labels.push(paper.legacyStudyId ? "Study materials" : "Indexed");
              return (
                <article key={paper.id} className={styles.study}>
                  <Link href={`/studies/${paper.id}`} className={styles.studyLink}>
                    <div>
                      <h2>{paper.title}</h2>
                      {((paper.authors ?? []).length > 0 || paper.year) && (
                        <p className={styles.authors}>
                          {[(paper.authors ?? []).join(", "), paper.year].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                    <p className={styles.capability}>
                      <span>{labels.map(label => <span key={label}>{label}</span>)}</span>
                      <ArrowRight />
                    </p>
                  </Link>
                </article>
              );
            })}
          </div>

          {result.total === 0 && <p className={styles.empty}>No studies match this view.</p>}

          <nav aria-label="Research pages" className={styles.pagination}>
            {result.offset > 0 ? (
              <Link href={link(filter, Math.max(0, result.offset - result.limit))}>← Previous</Link>
            ) : <span />}
            {result.nextOffset !== null && <Link href={link(filter, result.nextOffset)}>Next →</Link>}
          </nav>
        </>
      )}
    </div>
  );
}
