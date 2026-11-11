import Link from "next/link";
import ArrowRight from "@/components/ArrowRight";
import { searchLibrary, validateResearchQuery, type ResearchPaper } from "@/lib/research";
import styles from "./page.module.css";

type SearchParams = { q?: string; offset?: string; pool?: string };

export default async function StudiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const pending = params.pool === "pending";
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
      result = await searchLibrary(input, pending ? "pending" : "extracted");
    } catch {
      error = "The research library could not be loaded. Try again shortly.";
    }
  }

  const link = (extra: Record<string, string>) => `/studies?${new URLSearchParams({
    ...(params.q ? { q: params.q } : {}),
    ...(pending ? { pool: "pending" } : {}),
    ...extra,
  })}`;
  const otherPool = `/studies?${new URLSearchParams({
    ...(params.q ? { q: params.q } : {}),
    ...(pending ? {} : { pool: "pending" }),
  })}`;

  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        {pending && <Link href={otherPool} className={styles.back}>← Study Library</Link>}
        <h1>{pending ? "Not yet extracted" : "Study Library"}</h1>
        <p>{pending
          ? "Papers we have indexed but not yet turned into a Human Program. They have no materials or artifacts yet."
          : "Search published human studies and their research files."}</p>
      </header>

      <form action="/studies" className={styles.search} role="search">
        {pending && <input type="hidden" name="pool" value="pending" />}
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
          <p className={styles.count}>
            {result.total} {result.total === 1 ? "paper" : "papers"}
            {!pending && result.other > 0 && (
              <> · <Link href={otherPool}>{result.other} more indexed, not yet extracted →</Link></>
            )}
          </p>
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
                    <span>{paper.assetFiles?.some(file => file.path === "program.json") ? "Human Program" : paper.currentRevision || paper.legacyStudyId ? "Study materials" : "Indexed paper"}</span>
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
