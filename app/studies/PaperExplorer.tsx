"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import ArrowRight from "@/components/ArrowRight";
import DisciplineMap from "./DisciplineMap";
import styles from "./page.module.css";

export type ExplorerPaper = {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  discipline: string;
  description: string;
  programHref: string | null;
  canRun: boolean;
  userSubmitted: boolean;
  validated: boolean;
  contributors: string[];
};

type ExplorerProps = { papers: ExplorerPaper[]; previousHref: string | null; nextHref: string | null };

export default function PaperExplorer({ papers, previousHref, nextHref }: ExplorerProps) {
  const [selectedId, setSelectedId] = useState(papers[0].id);
  const [showFields, setShowFields] = useState(true);
  const [mobileView, setMobileView] = useState<"papers" | "map">("papers");
  const list = useRef<HTMLDivElement>(null);
  const mapPane = useRef<HTMLDivElement>(null);
  const selected = papers.find(p => p.id === selectedId) ?? papers[0];

  function showPaperOnMap(id: string) {
    setSelectedId(id);
    setShowFields(false);
    setMobileView("map");
    // On narrow screens the selected card is replaced by the map.
    requestAnimationFrame(() => {
      if (list.current?.clientHeight === 0) mapPane.current?.querySelector("h2")?.focus();
    });
  }

  function selectFromMap(id: string) {
    setSelectedId(id);
    const container = list.current;
    const card = container?.querySelector<HTMLElement>(`[data-paper-id="${id}"]`);
    if (!card || !container || !container.clientHeight) return;
    const offset = card.getBoundingClientRect().top - container.getBoundingClientRect().top;
    if (offset < 0 || offset + card.offsetHeight > container.clientHeight) container.scrollTop += offset;
  }

  return (
    <div className={styles.explorer} data-view={mobileView}>
      <div className={styles.switcher} role="group" aria-label="Explore results">
        <button type="button" aria-pressed={mobileView === "papers"} onClick={() => setMobileView("papers")}>Papers</button>
        <button type="button" aria-pressed={mobileView === "map"} onClick={() => setMobileView("map")}>Map</button>
      </div>
      <div className={styles.listPane}>
        <div className={styles.studyList} ref={list} aria-label="Matching papers">
          {papers.map(paper => {
            const href = `/studies/${paper.id}`;
            const label = paper.programHref ? "Interact with paper" : "View paper";
            return (
              <article key={paper.id} className={styles.study} data-paper-id={paper.id} data-selected={paper.id === selected.id}>
                <div className={styles.cardTop}>
                  <span>{paper.discipline}</span>
                  <button type="button" aria-label={`Show on map: ${paper.title}`} title="Show on map"
                    aria-pressed={selected.id === paper.id}
                    onClick={() => showPaperOnMap(paper.id)}>
                    <svg width="17" height="17" viewBox="0 0 20 20" stroke="currentColor" fill="none" strokeWidth="1.4" aria-hidden="true">
                      <circle cx="10" cy="10" r="5.5" /><circle cx="10" cy="10" r="1.8" />
                      <path d="M10 1v3m9 6h-3m-6 9v-3M1 10h3" />
                    </svg>
                  </button>
                </div>
                <h2><Link href={href}>{paper.title}</Link></h2>
                <p className={styles.authors}>{[paper.authors.join(", "), paper.year].filter(Boolean).join(" · ")}</p>
                {paper.validated && <p className={styles.metadata}>Validated protocol</p>}
                {paper.userSubmitted && <p className={styles.metadata}>User submitted</p>}
                <div className={styles.actions}>
                  <Link href={paper.programHref ?? href} aria-label={`${label}: ${paper.title}`}>{label} <ArrowRight /></Link>
                  {paper.canRun && <Link href={href + "#run-experiment"} aria-label={`Run experiment: ${paper.title}`}>Run experiment</Link>}
                  {paper.contributors.length > 0 && <p className={styles.attribution}>Contributed by {paper.contributors.join(", ")}</p>}
                </div>
              </article>
            );
          })}
        </div>
        {(previousHref || nextHref) && <nav aria-label="Research pages" className={styles.pagination}>
          {previousHref && <Link rel="prev" href={previousHref}>← Previous</Link>}
          {nextHref && <Link rel="next" href={nextHref}>Next →</Link>}
        </nav>}
      </div>
      <div className={styles.mapPane} ref={mapPane}>
        <DisciplineMap papers={papers} selectedId={selected.id} onSelect={selectFromMap}
          showFields={showFields} onShowFields={setShowFields} />
        <div className={styles.detail} aria-live="polite">
          <p className={styles.detailMeta}>{[selected.discipline, selected.year].filter(Boolean).join(" · ")}</p>
          <h3><Link href={`/studies/${selected.id}`}>{selected.title}</Link></h3>
          {selected.authors.length > 0 && <p className={styles.detailAuthors}>{selected.authors.join(", ")}</p>}
          {selected.description && <p className={styles.abstract}>{selected.description}</p>}
        </div>
      </div>
    </div>
  );
}
