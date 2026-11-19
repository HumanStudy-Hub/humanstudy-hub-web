"use client";

import styles from "./page.module.css";

type Props = {
  query: string;
  author: string;
  discipline: string;
  status: string;
  disciplines: { id: string; label: string; count: number }[];
};

export default function LibrarySearch({ query, author, discipline, status, disciplines }: Props) {
  return (
    <form id="study-search" action="/studies" className={styles.search} role="search">
      <input type="hidden" name="status" value={status} />
      <div className={styles.searchBar}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" />
        </svg>
        <input name="q" defaultValue={query} aria-label="Search papers" placeholder="Paper title or keyword" maxLength={500} />
        <button type="submit">Search</button>
      </div>
      <div className={styles.facets}>
        <label><span id="study-discipline-label">Discipline</span>
          <select name="discipline" aria-labelledby="study-discipline-label" defaultValue={discipline}
            onChange={e => e.currentTarget.form?.requestSubmit()}>
            <option value="">All disciplines</option>
            {discipline && !disciplines.some(field => field.id === discipline) &&
              <option value={discipline}>{discipline.replaceAll("-", " ")} (0)</option>}
            {disciplines.map(field => <option key={field.id} value={field.id}>{field.label} ({field.count})</option>)}
          </select>
        </label>
        <label>Author
          <input name="author" defaultValue={author} placeholder="Any author" maxLength={160} />
        </label>
      </div>
    </form>
  );
}
