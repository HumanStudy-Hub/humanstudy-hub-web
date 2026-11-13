"use client";

import styles from "./published-reading.module.css";

type Entry = { id: string; title: string };

export default function ReadingContents({ overview, experiments }: { overview: Entry[]; experiments: Entry[] }) {
  if (!overview.length && !experiments.length) return null;

  const links = (entries: Entry[]) => <ul>
    {entries.map(({ id, title }) => <li key={id}>
      <a href={`#${id}`} onClick={event => {
        const target = document.getElementById(id);
        if (target instanceof HTMLDetailsElement) target.open = true;
        const disclosure = event.currentTarget.closest("details");
        if (disclosure) disclosure.open = false;
        const focus = target instanceof HTMLDetailsElement ? target.querySelector("summary") : target;
        focus?.focus({ preventScroll: true });
      }}>{title}</a>
    </li>)}
  </ul>;

  const contents = <>
    {overview.length > 0 && <div><strong>Overview</strong>{links(overview)}</div>}
    {experiments.length > 0 && <div><strong>Experiments and analyses</strong>{links(experiments)}</div>}
  </>;

  return <nav className={styles.contents} aria-label="Study contents">
    <div className={styles.rail}>{contents}</div>
    <details className={styles.compact}><summary>Contents</summary>{contents}</details>
  </nav>;
}
