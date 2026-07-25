"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

type Contributor = { name?: string; github?: string; institution?: string };
type Study = {
  study_id: string;
  title: string;
  authors: string[];
  year: number | null;
  contributors?: Contributor[];
};

const categoryById: Record<string, string> = {
  study_001: "Social Psychology",
  study_002: "Behavioral Decision-Making",
  study_003: "Behavioral Decision-Making",
  study_004: "Behavioral Decision-Making",
  study_005: "Social Psychology",
  study_006: "Social Psychology",
  study_007: "Social Psychology",
  study_008: "Social Psychology",
  study_009: "Behavioral Economics",
  study_010: "Behavioral Economics",
  study_011: "Behavioral Economics",
  study_012: "Behavioral Economics",
  study_013: "Entrepreneurship",
  study_014: "International Business & Markets",
  study_015: "Research Methods",
};

const categories = [
  "All fields",
  "Behavioral Decision-Making",
  "Social Psychology",
  "Behavioral Economics",
  "Entrepreneurship",
  "International Business & Markets",
  "Research Methods",
];

export default function DatasetCatalog({ studies }: { studies: Study[] }) {
  const [category, setCategory] = useState("All fields");
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => studies.filter((study) => {
    const matchesCategory = category === "All fields" || categoryById[study.study_id] === category;
    const text = `${study.study_id} ${study.title} ${study.authors.join(" ")}`.toLowerCase();
    return matchesCategory && text.includes(query.toLowerCase());
  }), [category, query, studies]);

  return (
    <>
      <div className="border-y border-gray-200 bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-6 py-5 sm:px-8 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {categories.map((item) => (
              <button key={item} onClick={() => setCategory(item)} className={`whitespace-nowrap border px-3 py-2 text-xs font-semibold ${category === item ? "border-cyan-700 bg-cyan-50 text-cyan-800" : "border-gray-200 bg-white text-gray-500 hover:border-gray-400"}`}>{item}</button>
            ))}
          </div>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ID, title, or author" className="h-9 w-full border border-gray-300 px-3 text-xs outline-none focus:border-cyan-700 lg:w-64" />
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-6 py-8 sm:px-8">
        <p className="mb-4 text-xs text-gray-500">{filtered.length} studies</p>
        <div className="overflow-x-auto border border-gray-200 bg-white">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead className="border-b border-gray-200 bg-gray-50 text-[11px] uppercase text-gray-500">
              <tr><th className="px-4 py-3">GitHub ID</th><th className="px-4 py-3">Paper</th><th className="px-4 py-3">Field</th><th className="px-4 py-3">Contributor</th></tr>
            </thead>
            <tbody>
              {filtered.map((study) => {
                const contributor = study.contributors?.[0];
                return (
                  <tr key={study.study_id} className="border-b border-gray-100 align-top last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-4"><Link href={`/studies/${study.study_id}`} className="font-mono text-xs font-bold text-cyan-800 hover:underline">{study.study_id}</Link><p className="mt-1 text-[11px] text-gray-400">{study.study_id <= "study_012" ? "Initial suite" : "Community"}</p></td>
                    <td className="max-w-xl px-4 py-4"><Link href={`/studies/${study.study_id}`} className="font-serif text-sm font-bold leading-5 text-gray-900 hover:text-cyan-800">{study.title}</Link><p className="mt-1 text-xs text-gray-500">{study.authors.join(", ")}{study.year ? ` · ${study.year}` : ""}</p></td>
                    <td className="px-4 py-4"><span className="inline-flex border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-600">{categoryById[study.study_id] || "Social Science"}</span></td>
                    <td className="px-4 py-4 text-xs text-gray-700">{contributor?.github ? <a href={contributor.github} target="_blank" rel="noopener noreferrer" className="font-semibold text-cyan-800 hover:underline">{contributor.name || contributor.github}</a> : <span>HumanStudy-Hub Team</span>}<p className="mt-1 text-[11px] text-gray-400">{contributor?.institution || "Foundational collection"}</p></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
