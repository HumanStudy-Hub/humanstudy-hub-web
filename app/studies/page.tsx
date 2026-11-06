import Link from "next/link";
import ArrowRight from "@/components/ArrowRight";
import { searchLibrary, validateResearchQuery, type ResearchPaper } from "@/lib/research";
import styles from "./page.module.css";

type SearchParams = { q?: string; offset?: string };

export default async function StudiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const raw = new URLSearchParams();
  if (typeof params.q === "string") raw.set("q", params.q);
  if (typeof params.offset === "string") raw.set("offset", params.offset);

  let input;
  let error = "";
  let result: Awaited<ReturnType<typeof searchLibrary>> | null = null;

  try {
    input = validateResearchQuery(raw);
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Invalid search.";
  }
  if (input) {
    try {
      result = await searchLibrary(input, "extracted");
    } catch {
      error = "The research library could not be loaded. Try again shortly.";
    }
  }

  const link = (extra: Record<string, string>) => `/studies?${new URLSearchParams({
    ...(params.q ? { q: params.q } : {}),
    ...extra,
  })}`;

  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <h1>Study Library</h1>
        <p>Search published human studies and their research files.</p>
      </header>

      <form action="/studies" className={styles.search} role="search">
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
          <div className={styles.studyList}>
            {result.items.map((paper: ResearchPaper) => (
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
                    <span>{paper.currentRevision ? "Human Program" : "Study materials"}</span>
                    <ArrowRight />
                  </p>
                </Link>
              </article>
            ))}
          </div>

          {result.total === 0 && <p className={styles.empty}>No matching papers.</p>}

          <nav aria-label="Research pages" className={styles.pagination}>
            {result.offset > 0 ? (
              <Link href={link({ offset: String(Math.max(0, result.offset - result.limit)) })}>← Previous</Link>
            ) : <span />}
            {result.nextOffset !== null && <Link href={link({ offset: String(result.nextOffset) })}>Next →</Link>}
          </nav>
        </>
      )}
    </div>
  );
}
