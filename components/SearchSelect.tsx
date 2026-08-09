"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type SelectOption = { id: string; label: string; note?: string };
export type CustomEntry = { id: string; hint: string };

function rank(option: SelectOption, needle: string) {
  const id = option.id.toLowerCase();
  const label = option.label.toLowerCase();
  // Someone typing an id already knows what they want, so it outranks a label
  // that happens to contain the same characters.
  if (id === needle) return 0;
  if (id.startsWith(needle)) return 1;
  if (label.toLowerCase().startsWith(needle)) return 2;
  if (id.includes(needle) || label.includes(needle) || (option.note || "").toLowerCase().includes(needle)) return 3;
  return -1;
}

export default function SearchSelect({
  id,
  options,
  value,
  onChange,
  placeholder,
  maxMatches = 8,
  display,
  customEntry,
}: {
  id: string;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  maxMatches?: number;
  display: (option: SelectOption | undefined, value: string) => string;
  customEntry?: (query: string, options: SelectOption[]) => CustomEntry | null;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => options.find((option) => option.id === value), [options, value]);
  const found = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return options.slice(0, maxMatches);
    return options
      .map((option) => ({ option, score: rank(option, needle) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => a.score - b.score)
      .map((entry) => entry.option);
  }, [options, query, maxMatches]);

  const shown = found.slice(0, maxMatches);
  const hidden = found.length - shown.length;
  const custom = customEntry?.(query.trim(), options) ?? null;
  const rows = custom ? [...shown.map((option) => option.id), custom.id] : shown.map((option) => option.id);
  const highlighted = rows.length === 0 ? 0 : Math.min(active, rows.length - 1);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  function choose(next: string) {
    onChange(next);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (rows.length === 0 ? 0 : (current + step + rows.length) % rows.length));
      return;
    }
    if (event.key === "Enter" && open && rows.length > 0) {
      event.preventDefault();
      choose(rows[highlighted]);
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
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-options`}
        aria-autocomplete="list"
        autoComplete="off"
        value={open ? query : display(selected, value)}
        onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }}
        onFocus={() => { setQuery(""); setActive(0); setOpen(true); }}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        className="h-10 w-full border border-gray-300 bg-white px-3 text-sm outline-none focus:border-cyan-700"
      />

      {open && (
        <ul id={`${id}-options`} role="listbox" className="absolute z-20 mt-1 max-h-80 w-full overflow-auto border border-gray-300 bg-white shadow-lg">
          {rows.length === 0 && <li className="px-3 py-3 text-xs text-gray-500">No match for “{query.trim()}”.</li>}
          {shown.map((option, index) => (
            <li key={option.id} role="option" aria-selected={option.id === value}>
              <button
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option.id)}
                className={`block w-full px-3 py-2 text-left ${index === highlighted ? "bg-cyan-50" : "bg-white"} ${option.id === value ? "border-l-2 border-cyan-700" : ""}`}
              >
                <span className="block font-mono text-xs font-semibold text-cyan-800">{option.id}</span>
                <span className="mt-0.5 block truncate text-xs text-gray-700">{option.label}{option.note ? ` · ${option.note}` : ""}</span>
              </button>
            </li>
          ))}
          {custom && (
            <li role="option" aria-selected={false}>
              <button
                type="button"
                onMouseEnter={() => setActive(rows.length - 1)}
                onClick={() => choose(custom.id)}
                className={`block w-full border-t border-gray-200 px-3 py-2 text-left ${highlighted === rows.length - 1 ? "bg-cyan-50" : "bg-white"}`}
              >
                <span className="block font-mono text-xs font-semibold text-cyan-800">{custom.id}</span>
                <span className="mt-0.5 block text-xs text-gray-500">{custom.hint}</span>
              </button>
            </li>
          )}
          {hidden > 0 && <li className="border-t border-gray-200 px-3 py-2 text-[11px] text-gray-500">{hidden} more — keep typing.</li>}
        </ul>
      )}
    </div>
  );
}
