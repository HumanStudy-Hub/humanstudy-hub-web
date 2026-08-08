"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { StudyOption } from "@/components/PlaygroundStudio";

// Enough to choose from without turning the field into the old dropdown.
const MAX_MATCHES = 8;
// Study ids are always <something>_<something>: study_014, or
// <contributor>_<study-name> for a contributed one. Requiring the underscore
// keeps a title search like "consensus" from being offered as a literal id.
const STUDY_ID = /^[a-zA-Z0-9-]+_[a-zA-Z0-9_-]+$/;

function matches(studies: StudyOption[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return studies.slice(0, MAX_MATCHES);
  const scored = studies
    .map((study) => {
      const id = study.study_id.toLowerCase();
      const title = study.title.toLowerCase();
      // An exact or leading id match is almost always what someone typing
      // "study_014" wants, so it outranks a title that happens to contain it.
      if (id === needle) return { study, rank: 0 };
      if (id.startsWith(needle)) return { study, rank: 1 };
      if (title.startsWith(needle)) return { study, rank: 2 };
      if (id.includes(needle) || title.includes(needle)) return { study, rank: 3 };
      return null;
    })
    .filter((entry): entry is { study: StudyOption; rank: number } => entry !== null)
    .sort((a, b) => a.rank - b.rank);
  return scored.map((entry) => entry.study);
}

export default function StudyPicker({
  studies,
  value,
  onChange,
}: {
  studies: StudyOption[];
  value: string;
  onChange: (studyId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => studies.find((study) => study.study_id === value), [studies, value]);
  const found = useMemo(() => matches(studies, query), [studies, query]);
  const shown = found.slice(0, MAX_MATCHES);
  const hidden = found.length - shown.length;
  const typedId = query.trim();
  // A study can be merged and runnable before the catalog index catches up, so an
  // id-shaped entry is offered even when nothing matches it. Not while it is
  // still a prefix of real ids, though: someone typing "study_01" is on their way
  // to one of those, not asking for a study called study_01.
  const prefixOfKnown = studies.some((study) => study.study_id.toLowerCase().startsWith(typedId.toLowerCase()));
  const offerTyped = Boolean(typedId) && STUDY_ID.test(typedId) && !prefixOfKnown;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function choose(studyId: string) {
    onChange(studyId);
    setQuery("");
    setOpen(false);
  }

  const options = offerTyped ? [...shown.map((study) => study.study_id), typedId] : shown.map((study) => study.study_id);
  const highlighted = options.length === 0 ? 0 : Math.min(active, options.length - 1);

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (options.length === 0 ? 0 : (current + step + options.length) % options.length));
      return;
    }
    if (event.key === "Enter") {
      if (!open || options.length === 0) return;
      event.preventDefault();
      choose(options[highlighted]);
      return;
    }
    if (event.key === "Escape") {
      setOpen(false);
      setQuery("");
    }
  }

  return (
    <div ref={box} className="relative">
      <input
        id="study"
        role="combobox"
        aria-expanded={open}
        aria-controls="study-options"
        aria-autocomplete="list"
        autoComplete="off"
        value={open ? query : selected ? `${selected.study_id} — ${selected.title}` : value}
        onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }}
        onFocus={() => { setQuery(""); setActive(0); setOpen(true); }}
        onKeyDown={onKeyDown}
        placeholder="Type a study id or title, for example study_001 or consensus"
        className="h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-cyan-700"
      />

      {open && (
        <ul id="study-options" role="listbox" className="absolute z-20 mt-1 max-h-80 w-full overflow-auto border border-gray-300 bg-white shadow-lg">
          {options.length === 0 && (
            <li className="px-3 py-3 text-xs text-gray-500">
              Nothing matches “{typedId}”. Study ids look like <span className="font-mono">study_014</span>.
            </li>
          )}
          {shown.map((study, index) => (
            <li key={study.study_id} role="option" aria-selected={study.study_id === value}>
              <button
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(study.study_id)}
                className={`block w-full px-3 py-2 text-left ${index === highlighted ? "bg-cyan-50" : "bg-white"} ${study.study_id === value ? "border-l-2 border-cyan-700" : ""}`}
              >
                <span className="block font-mono text-xs font-semibold text-cyan-800">{study.study_id}</span>
                <span className="mt-0.5 block truncate text-xs text-gray-700">{study.title}</span>
              </button>
            </li>
          ))}
          {offerTyped && (
            <li role="option" aria-selected={false}>
              <button
                type="button"
                onMouseEnter={() => setActive(options.length - 1)}
                onClick={() => choose(typedId)}
                className={`block w-full border-t border-gray-200 px-3 py-2 text-left ${highlighted === options.length - 1 ? "bg-cyan-50" : "bg-white"}`}
              >
                <span className="block font-mono text-xs font-semibold text-cyan-800">{typedId}</span>
                <span className="mt-0.5 block text-xs text-gray-500">Not in the catalog. Use it anyway — a newly merged study can run before it is indexed.</span>
              </button>
            </li>
          )}
          {hidden > 0 && (
            <li className="border-t border-gray-200 px-3 py-2 text-[11px] text-gray-500">
              {hidden} more {hidden === 1 ? "match" : "matches"} — keep typing to narrow it down.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
