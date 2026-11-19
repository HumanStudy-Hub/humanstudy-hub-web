"use client";

import { useRef, useState } from "react";
import styles from "./discipline-map.module.css";

export type MapPaper = {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  discipline: string;
};

type Props = {
  papers: MapPaper[];
  selectedId: string;
  onSelect: (id: string) => void;
  showFields: boolean;
  onShowFields: (show: boolean) => void;
};

const perMap = 8;
const hub = { x: 50, y: 44 };

function nodePosition(index: number, total: number) {
  const right = index % 2 === 1 || total === 1;
  const count = right ? Math.max(1, Math.floor(total / 2)) : Math.ceil(total / 2);
  const row = Math.floor(index / 2);
  const offset = count > 1 ? (row / (count - 1)) * 2 - 1 : 0;
  const spread = count > 2 ? 35 : 24;
  const x = 17 + 15 * offset ** 2;
  return { x: right ? 100 - x : x, y: hub.y + offset * spread + (right ? 4 : -1) };
}

function paperLabel(paper: MapPaper) {
  const author = paper.authors[0]?.trim();
  if (!author) return paper.title;
  const surname = author.includes(",") ? author.split(",")[0] : author.split(/\s+/).at(-1);
  return [surname, paper.year].filter(Boolean).join(" · ");
}

export default function DisciplineMap({ papers, selectedId, onSelect, showFields, onShowFields }: Props) {
  const [fieldPage, setFieldPage] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const branches = new Map<string, MapPaper[]>();
  for (const paper of papers) {
    const name = paper.discipline || "Unclassified";
    if (!branches.has(name)) branches.set(name, []);
    branches.get(name)!.push(paper);
  }
  const selected = papers.find(paper => paper.id === selectedId) ?? papers[0];
  if (!selected) return <p className={styles.empty}>No papers to map in this view.</p>;

  const discipline = selected.discipline || "Unclassified";
  const branch = branches.get(discipline)!;
  const overview = showFields && branches.size > 1;
  const fields = [...branches].sort(([nameA, a], [nameB, b]) => b.length - a.length || nameA.localeCompare(nameB));
  const total = overview ? fields.length : branch.length;
  const page = overview ? Math.min(fieldPage, Math.ceil(total / perMap) - 1) : Math.floor(branch.indexOf(selected) / perMap);
  const start = page * perMap;
  const items = overview
    ? fields.slice(start, start + perMap).map(([name, members]) => ({
        id: members[0].id, label: name, count: members.length, title: `Explore ${name} · ${members.length} ${members.length === 1 ? "paper" : "papers"}`,
      }))
    : branch.slice(start, start + perMap).map(paper => ({
        id: paper.id, label: paperLabel(paper), title: paper.title, count: null,
      }));
  const nodes = items.map((item, index) => ({ ...item, ...nodePosition(index, items.length) }));

  function changePage(delta: number) {
    if (overview) setFieldPage(page + delta);
    else onSelect(branch[(page + delta) * perMap].id);
  }

  function selectNode(id: string) {
    if (overview) {
      onShowFields(false);
      heading.current?.focus({ preventScroll: true });
    }
    onSelect(id);
  }

  return (
    <section className={styles.map} aria-label="Map of papers by discipline">
      <div className={styles.header}>
        <h2 ref={heading} tabIndex={-1}>Discipline map</h2>
        {!overview && branches.size > 1 && (
          <button className={styles.back} type="button" onClick={() => {
            onShowFields(true);
            heading.current?.focus({ preventScroll: true });
          }}><span aria-hidden="true">← </span>All disciplines</button>
        )}
      </div>
      <div className={styles.canvas}>
        <svg className={styles.paths} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {nodes.map(({ id, x, y }) => (
            <path
              key={id}
              d={`M ${hub.x} ${hub.y} C ${hub.x + (x - hub.x) * .45} ${hub.y}, ${x - (x - hub.x) * .32} ${y}, ${x} ${y}`}
              className={!overview && id === selectedId ? styles.activePath : undefined}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
        <div className={styles.hub} style={{ left: hub.x + "%", top: hub.y + "%" }}>
          <span className={styles.hubDot} />
          <strong>{overview ? "Research fields" : discipline}</strong>
        </div>
        {nodes.map(({ id, x, y, title, label, count }) => (
          <button
            type="button"
            className={styles.node}
            style={{ left: x + "%", top: y + "%" }}
            key={id}
            title={title}
            aria-label={overview ? title : `Select paper: ${title}`}
            aria-pressed={overview ? undefined : id === selectedId}
            onClick={() => selectNode(id)}
          >
            {overview ? <span className={styles.fieldDot}>{count}</span> : <span className={styles.dot} />}
            <span className={styles.nodeLabel}>{label}</span>
          </button>
        ))}
      </div>
      <div className={styles.caption}>
        <span>
          {overview
            ? `${papers.length} papers across ${total} disciplines on this page`
            : `${total} ${total === 1 ? "paper" : "papers"} in this branch on this page`}
          {total > perMap && ` · Showing ${start + 1}–${start + nodes.length}`}
        </span>
        {total > perMap && (
          <div className={styles.controls}>
            <button type="button" aria-label={overview ? "Previous disciplines" : "Previous papers in this branch"}
              disabled={start === 0} onClick={() => changePage(-1)}>‹</button>
            <button type="button" aria-label={overview ? "Next disciplines" : "Next papers in this branch"}
              disabled={start + perMap >= total} onClick={() => changePage(1)}>›</button>
          </div>
        )}
      </div>
    </section>
  );
}
