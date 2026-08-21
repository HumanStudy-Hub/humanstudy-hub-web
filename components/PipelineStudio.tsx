"use client";

import { useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import Link from "next/link";
import { upload } from "@vercel/blob/client";
import JSZip from "jszip";

const MAX_PAPER_BYTES = 50 * 1024 * 1024;
const MAX_MATERIALS_BYTES = 100 * 1024 * 1024;
// A dispatched run normally reports back within a minute. Longer than this and
// GitHub most likely never gave the job a runner.
const STALL_MS = 5 * 60 * 1000;
// Browsers expose a folder picker through the non-standard webkitdirectory
// attribute; TypeScript's DOM types do not include it, hence the cast.
const directoryInputProps = { webkitdirectory: "", directory: "" } as unknown as InputHTMLAttributes<HTMLInputElement>;

type JobStatus = "queued" | "running" | "review" | "complete" | "failed";
type PipelineProgress = {
  phase: "building_package" | "validating_package" | "ready_for_review" | "timed_out" | "failed";
  completedRequired: number;
  totalRequired: number;
  totalFiles: number;
  missing: string[];
  updatedAt: string;
};
type Job = {
  id: string;
  experimentId: string;
  paperName: string;
  osfUrl?: string;
  createdAt?: string;
  currentStage: number;
  status: JobStatus;
  message: string;
  error?: string;
  packageReady?: boolean;
  progress?: PipelineProgress;
  source?: "build" | "import";
  updatedAt: string;
};
export type ReviewFile = { path: string; content: string };
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const TECHNICAL_KEYS = new Set(["source_trace", "readiness", "coverage_ledger", "derivation_contract", "audit", "selection", "verification"]);

function label(key: string) {
  return key.replaceAll("_", " ");
}

function isPlaceholder(raw: string) {
  // "missing" is the evidence label the agent writes when it could not determine
  // a value from the paper, so it is just as much an open question as an empty
  // field or an explicit [填写] marker. All of these turn the field amber.
  return /^\s*(\[填写\]|\[missing\]|missing|tbd|unknown|not available|n\/a)?\s*$/i.test(raw);
}

// A reviewer being asked to fill something in needs to know what is being asked
// for. Keys are matched by their last segment, which is how study files name
// the same concept at every level.
const FIELD_HELP: Array<[RegExp, string]> = [
  [/^n$|^sample_size$|^n_participants$/, "How many people took part."],
  [/^n_per_(condition|group|cell)$/, "How many people were in each condition."],
  [/^age_(range|mean|sd)$/, "The ages of the people recruited, as the paper reports them."],
  [/^gender(_distribution)?$/, "How the sample split by gender, as the paper reports it."],
  [/^population$|^recruitment_source$/, "Who was recruited and from where — students, online panel, a specific community."],
  [/^exclusions?$|^attrition$/, "Participants dropped from the analysis, and why."],
  [/^design$/, "How the experiment was arranged: what was manipulated, and whether people saw one condition or several."],
  [/^conditions?$/, "The distinct treatments a participant could be assigned to."],
  [/^independent_variable|^iv$|^manipulation$/, "What the experimenters changed between conditions."],
  [/^dependent_variable|^dv$|^outcomes?$|^measures?$/, "What was measured as the result."],
  [/^procedure$|^steps?$|^protocol$/, "What a participant actually did, in order."],
  [/^instructions?$/, "The words shown to participants. This must be the paper's own wording, not a rewrite."],
  [/^items?$|^stimuli$|^questions?$|^scenarios?$/, "The material participants responded to. Should be the paper's exact text where the paper prints it."],
  [/^response_(format|scale|options)$|^scale$|^options$/, "How participants answered: the scale, its endpoints, or the choices offered."],
  [/^hypothesis|^prediction/, "What the paper expected to find."],
  [/^finding|^result/, "What the paper reported finding."],
  [/^reported_statistics?$|^statistical_tests?$/, "The test statistic exactly as printed in the paper, such as F(1, 312) = 49.1, p < .001."],
  [/^effect_size|^cohens_d$|^eta|^^partial_eta/, "How large the effect was, in the paper's own units."],
  [/^p_value$|^significance_level$/, "The probability threshold or reported p-value."],
  [/^expected_direction$/, "Which way the effect should point if it replicates."],
  [/^evidence_label$|^label$/, "Where this came from: verbatim from the paper, reported, derived, or missing."],
  [/^source|^page|^location|^citation/, "Where in the paper this was found."],
  [/^title$/, "The title of the paper or study."],
  [/^authors?$/, "Who wrote the paper."],
  [/^year$|^publication_year$/, "When it was published."],
  [/^abstract$|^summary$|^description$/, "A short description of the study."],
  [/^doi$|^url$/, "A link to the source."],
  [/^reason$/, "Why this could not be determined from the paper."],
  [/^impact$/, "What stays unreliable in the run while this is unfilled."],
  [/^suggested_action$/, "What the reviewer should do to resolve it."],
  [/^study$|^study_id$|^sub_study_id$/, "Which study within the paper this belongs to."],
  [/^role|^participant_role$/, "What part this participant plays in the experiment."],
  [/^order|^sequence/, "The order participants act in."],
];

function fieldHelp(key: string): string | null {
  const leaf = key.split(".").pop() || key;
  const normalised = leaf.toLowerCase().trim();
  for (const [pattern, help] of FIELD_HELP) {
    if (pattern.test(normalised)) return help;
  }
  return null;
}

// What the reviewer is actually here to do is fill in what the agent could not
// determine, so every section reports how much of that it still holds.
function needsInputCount(value: JsonValue): number {
  if (value !== null && typeof value === "object") {
    return Object.values(value).reduce<number>((total, child) => total + needsInputCount(child as JsonValue), 0);
  }
  return isPlaceholder(value === null ? "" : String(value)) ? 1 : 0;
}

// audit/missing_information.json is the checklist of gaps the paper could not
// answer. Each of its `entries` is one unresolved researcher decision even when
// its prose is filled in, so a checklist with entries is never "settled" — it
// still owes the researcher N decisions. Only that file is treated as a
// checklist; other files (e.g. evidence.json, which also has an `entries` array)
// are counted by the leaf values that are actually missing-labelled.
function filePendingCount(path: string, content: string): number {
  try {
    const parsed = JSON.parse(content);
    if (path.endsWith("missing_information.json") && parsed && Array.isArray(parsed.entries)) return parsed.entries.length;
    return needsInputCount(parsed);
  } catch {
    return 0;
  }
}

function LeafField({ value, onChange }: { value: JsonValue; onChange: (value: JsonValue) => void }) {
  const raw = value === null ? "" : String(value);
  const placeholder = isPlaceholder(raw);
  const border = placeholder ? "border-amber-400 bg-amber-50/40" : "border-gray-300 bg-white";
  const commit = (next: string) => onChange(typeof value === "number" ? (next === "" ? 0 : Number(next)) : typeof value === "boolean" ? next === "true" : next);
  // Long prose in a single-line input is unreadable and unrepairable, and study
  // material is full of it.
  const long = raw.length > 80 || raw.includes("\n");
  return (
    <div className="min-w-0">
      {long ? (
        <textarea
          value={raw}
          onChange={(event) => commit(event.target.value)}
          rows={Math.min(10, Math.max(3, raw.split("\n").length + Math.floor(raw.length / 90)))}
          className={`w-full resize-y border px-3 py-2 text-sm leading-6 text-gray-800 outline-none focus:border-cyan-700 ${border}`}
        />
      ) : (
        <input
          value={raw}
          onChange={(event) => commit(event.target.value)}
          className={`w-full border px-3 py-2 text-sm text-gray-800 outline-none focus:border-cyan-700 ${border}`}
        />
      )}
      {placeholder && <p className="mt-1 text-[11px] font-semibold text-amber-700">Needs researcher input</p>}
    </div>
  );
}

function renameKey(source: Record<string, JsonValue>, from: string, to: string) {
  // Rebuilt rather than reassigned so the field keeps its position in the file.
  return Object.fromEntries(Object.entries(source).map(([key, value]) => (key === from ? [to, value] : [key, value])));
}

function JsonNode({ value, onChange, path = "", depth = 1, onlyMissing = false }: { value: JsonValue; onChange: (value: JsonValue) => void; path?: string; depth?: number; onlyMissing?: boolean }) {
  const [renaming, setRenaming] = useState("");
  const [draftKey, setDraftKey] = useState("");

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, JsonValue>;
    const entries = Object.entries(value);
    const visible = entries.filter(([key]) => !TECHNICAL_KEYS.has(key));
    const technical = entries.filter(([key]) => TECHNICAL_KEYS.has(key));
    const field = ([key, child]: [string, JsonValue]) => {
      const missing = needsInputCount(child);
      // In review-what-is-left mode a settled field is not the reviewer's problem.
      if (onlyMissing && missing === 0) return null;
      const help = fieldHelp(key);
      const isRenaming = renaming === key;
      return (
        <div key={key} className="group min-w-0">
          <div className="mb-1 flex items-start justify-between gap-2">
            {isRenaming ? (
              <span className="flex min-w-0 flex-wrap items-center gap-1">
                <input
                  value={draftKey}
                  autoFocus
                  onChange={(event) => setDraftKey(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && draftKey.trim() && draftKey !== key) { onChange(renameKey(record, key, draftKey.trim())); setRenaming(""); }
                    if (event.key === "Escape") setRenaming("");
                  }}
                  className="h-7 border border-cyan-700 px-2 font-mono text-xs outline-none"
                />
                <button type="button" onClick={() => { if (draftKey.trim() && draftKey !== key) onChange(renameKey(record, key, draftKey.trim())); setRenaming(""); }} className="text-[11px] font-semibold text-cyan-700">Save</button>
                <button type="button" onClick={() => setRenaming("")} className="text-[11px] text-gray-500">Cancel</button>
              </span>
            ) : (
              <p className="flex min-w-0 items-center gap-2 text-xs font-semibold text-gray-700">
                <span className="break-words">{label(key)}</span>
                {missing > 0 && <span className="shrink-0 bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">{missing}</span>}
              </p>
            )}
            {!isRenaming && (
              <span className="flex shrink-0 gap-2 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <button type="button" onClick={() => { setRenaming(key); setDraftKey(key); }} className="text-[11px] text-gray-400 hover:text-cyan-700">Rename</button>
                {/* The agent sometimes extracts a field the paper never had. */}
                <button type="button" onClick={() => onChange(Object.fromEntries(entries.filter(([other]) => other !== key)))} className="text-[11px] text-gray-400 hover:text-red-700">Remove</button>
              </span>
            )}
          </div>
          {help && <p className="mb-1.5 text-[11px] leading-4 text-gray-500">{help}</p>}
          <div className={depth < 3 ? "border-l-2 border-gray-100 pl-3" : ""}>
            <JsonNode value={child} path={`${path}.${key}`} depth={depth + 1} onlyMissing={onlyMissing} onChange={(next) => onChange({ ...record, [key]: next })} />
          </div>
        </div>
      );
    };
    return (
      <div className="min-w-0 space-y-3">
        {visible.map(field)}
        {technical.length > 0 && (
          <details className="border-t border-gray-200 pt-2">
            <summary className="cursor-pointer text-xs font-semibold text-gray-500">Technical extraction details</summary>
            <div className="mt-3 space-y-3">{technical.map(field)}</div>
          </details>
        )}
      </div>
    );
  }

  if (Array.isArray(value)) {
    const update = (index: number, next: JsonValue) => onChange(value.map((item, at) => (at === index ? next : item)));
    // A long list of expanded items is where the panel turns into a wall, so
    // past a few they start folded with their own count of what is unfilled.
    if (value.length > 3) {
      return (
        <div className="min-w-0 space-y-1">
          {value.map((child, index) => {
            const missing = needsInputCount(child);
            if (onlyMissing && missing === 0) return null;
            return (
              <details key={`${path}.${index}`} className="border border-gray-200 bg-white">
                <summary className="group flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50">
                  <span className="truncate">Item {index + 1}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    {missing > 0 && <span className="bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800">{missing} to fill</span>}
                    <button type="button" onClick={(event) => { event.preventDefault(); onChange(value.filter((_, at) => at !== index)); }} className="text-[11px] text-gray-400 opacity-0 transition-opacity hover:text-red-700 group-hover:opacity-100">Remove</button>
                  </span>
                </summary>
                <div className="border-t border-gray-100 p-3">
                  <JsonNode value={child} path={`${path}.${index}`} depth={depth + 1} onlyMissing={onlyMissing} onChange={(next) => update(index, next)} />
                </div>
              </details>
            );
          })}
        </div>
      );
    }
    return (
      <div className="min-w-0 space-y-2">
        {value.map((child, index) => (
          <div key={`${path}.${index}`} className="group min-w-0">
            <p className="mb-1 flex items-center justify-between text-[11px] text-gray-500">
              <span>Item {index + 1}</span>
              <button type="button" onClick={() => onChange(value.filter((_, at) => at !== index))} className="text-[11px] text-gray-400 opacity-0 transition-opacity hover:text-red-700 group-hover:opacity-100">Remove</button>
            </p>
            <JsonNode value={child} path={`${path}.${index}`} depth={depth + 1} onlyMissing={onlyMissing} onChange={(next) => update(index, next)} />
          </div>
        ))}
      </div>
    );
  }

  return <LeafField value={value} onChange={onChange} />;
}

// The top level of a study file is its table of contents. Presenting it as
// collapsible sections with a jump list is what keeps a large file navigable;
// everything below is ordinary nesting.

type MapNode = { label: string; kind: "section" | "leaf"; detail?: string; children?: MapNode[]; target?: string };

// A compact, expandable mind-map of the study's structure, drawn from the same
// study.json the reviewer is editing. It is intentionally built from a small set
// of well-known keys (with graceful fallbacks) rather than the whole file, so a
// reviewer can see each study, its arms/conditions, outcomes, and analyses as
// branches without wading through the raw JSON. Every node links to the matching
// section in the editor below.
function buildStudyMap(value: JsonValue): MapNode {
  const obj = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, JsonValue>;
  const get = (key: string): JsonValue | undefined => obj[key];
  const asArray = (v: JsonValue | undefined): JsonValue[] => (Array.isArray(v) ? v : []);
  const str = (v: JsonValue | undefined): string => (typeof v === "string" ? v : String(v ?? ""));

  const paperTitle = (() => {
    const sp = get("source_paper");
    if (sp && typeof sp === "object" && !Array.isArray(sp)) {
      const t = (sp as Record<string, JsonValue>).title;
      if (typeof t === "string") return t;
    }
    return str(get("package_id")) || "Study";
  })();

  const studies: MapNode[] = asArray(get("empirical_studies_identified_in_paper")).map((s) => {
    const so = (s && typeof s === "object" && !Array.isArray(s) ? s : {}) as Record<string, JsonValue>;
    const name = str(so.name) || str(so.id) || "Study";
    const children: MapNode[] = [];
    const purpose = str(so.purpose); if (purpose) children.push({ label: "Purpose", kind: "leaf", detail: purpose });
    const participants = str(so.participants); if (participants) children.push({ label: "Participants", kind: "leaf", detail: participants });
    const design = str(so.design); if (design) children.push({ label: "Design", kind: "leaf", detail: design });
    return { label: name, kind: "section", target: "empirical_studies_identified_in_paper", children: children.length ? children : undefined };
  });

  const conditionBranches: MapNode[] = [];
  const cond = get("conditions");
  if (cond && typeof cond === "object" && !Array.isArray(cond)) {
    for (const [studyKey, cv] of Object.entries(cond as Record<string, JsonValue>)) {
      if (cv && typeof cv === "object" && !Array.isArray(cv)) {
        const factors = Object.entries(cv as Record<string, JsonValue>).map(([factor, values]) => {
          const vals = asArray(values);
          return { label: label(factor), kind: "leaf" as const, detail: vals.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" · ") || undefined };
        });
        if (factors.length) conditionBranches.push({ label: label(studyKey), kind: "section", target: "conditions", children: factors });
      }
    }
  }

  const outcomes = asArray(get("primary_outcomes")).map((o) => ({ label: str(o), kind: "leaf" as const }));
  const analyses = get("planned_analyses");
  const analysisChildren: MapNode[] = [];
  if (analyses && typeof analyses === "object" && !Array.isArray(analyses)) {
    for (const [k, v] of Object.entries(analyses as Record<string, JsonValue>)) {
      if (typeof v === "string" && v) analysisChildren.push({ label: label(k), kind: "leaf", detail: v });
    }
  }

  const branches: MapNode[] = [];
  if (studies.length) branches.push({ label: "Studies", kind: "section", target: "empirical_studies_identified_in_paper", children: studies });
  if (conditionBranches.length) branches.push({ label: "Conditions / arms", kind: "section", target: "conditions", children: conditionBranches });
  if (outcomes.length) branches.push({ label: "Outcomes", kind: "section", target: "primary_outcomes", children: outcomes });
  if (analysisChildren.length) branches.push({ label: "Planned analyses", kind: "section", target: "planned_analyses", children: analysisChildren });

  return { label: paperTitle, kind: "section", children: branches };
}

const mapGoTo = (target?: string) => {
  if (!target) return;
  const id = `section-${target.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: "smooth" }));
};

// A "locate" affordance that is separate from expand/collapse so the two
// interactions never fight each other. Clicking it scrolls the JSON editor to
// the section a node describes.
function LocateLink({ target, onGoTo }: { target?: string; onGoTo?: (target: string) => void }) {
  if (!target) return null;
  return (
    <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); (onGoTo ?? mapGoTo)(target); }} className="shrink-0 text-[10px] font-semibold text-cyan-600 hover:text-cyan-800" title="Jump to this section in the editor">Locate</button>
  );
}

function MapNodeView({ node, depth, activeTarget, onGoTo }: { node: MapNode; depth: number; activeTarget?: string; onGoTo?: (target: string) => void }) {
  const isActive = Boolean(node.target && node.target === activeTarget);
  // A leaf carries a single labelled fact (e.g. an outcome, a condition factor).
  if (node.kind === "leaf") {
    return (
      <div className={`min-w-0 ${isActive ? "rounded bg-cyan-50 px-1 -mx-1" : ""}`}>
        <p className="text-[11px] font-semibold text-gray-700">{node.label}</p>
        {node.detail && <p className="text-[11px] leading-5 text-gray-500">{node.detail}</p>}
      </div>
    );
  }

  const hasChildren = Boolean(node.children && node.children.length > 0);
  const label = (
    <span className={`${depth === 0 ? "text-sm font-bold text-gray-950" : "text-xs font-semibold text-gray-800"} ${isActive ? "text-cyan-800" : ""}`}>{node.label}</span>
  );

  if (!hasChildren) {
    // A section with no recognised children still lets you jump to it.
    return (
      <div className={`flex items-center gap-1.5 ${isActive ? "rounded bg-cyan-50 px-1 -mx-1" : ""}`}>
        {label}
        <LocateLink target={node.target} onGoTo={onGoTo} />
      </div>
    );
  }

  return (
    <details open={depth < 2}>
      <summary className={`flex cursor-pointer list-none items-center gap-1.5 ${isActive ? "rounded bg-cyan-50 px-1" : ""}`}>
        <span className={`text-[10px] ${isActive ? "text-cyan-600" : "text-gray-400"}`}>▸</span>
        {label}
        <LocateLink target={node.target} onGoTo={onGoTo} />
      </summary>
      <div className="mt-1 space-y-1 border-l border-gray-200 pl-3">
        {node.children!.map((child, i) => <MapNodeView key={i} node={child} depth={depth + 1} activeTarget={activeTarget} onGoTo={onGoTo} />)}
      </div>
    </details>
  );
}

function StructureMap({ value, activeTarget, onGoTo }: { value: JsonValue; activeTarget?: string; onGoTo?: (target: string) => void }) {
  const root = buildStudyMap(value);
  if (!root.children || root.children.length === 0) return null;
  return (
    <div className="border border-gray-200 bg-white">
      <div className="border-b border-gray-100 bg-gray-50 px-4 py-2">
        <p className="text-[10px] font-bold uppercase text-cyan-800">Study map</p>
        <p className="mt-0.5 text-[10px] leading-4 text-gray-400">Minimap — highlights the section you are viewing.</p>
      </div>
      <div className="space-y-3 p-4">
        <MapNodeView node={root} depth={0} activeTarget={activeTarget} onGoTo={onGoTo} />
      </div>
    </div>
  );
}

export function JsonEditor({ value, onChange, path = "" }: { value: JsonValue; onChange: (value: JsonValue) => void; path?: string }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [onlyMissing, setOnlyMissing] = useState(false);

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return <JsonNode value={value} onChange={onChange} />;
  }

  const entries = Object.entries(value);
  const visible = entries.filter(([key]) => !TECHNICAL_KEYS.has(key));
  const technical = entries.filter(([key]) => TECHNICAL_KEYS.has(key));
  const sectionId = (key: string) => `section-${key.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const isChecklist = path.endsWith("missing_information.json");
  const totalMissing = isChecklist ? (Array.isArray((value as { entries?: JsonValue }).entries) ? ((value as { entries: JsonValue[] }).entries.length) : needsInputCount(value)) : needsInputCount(value);

  function jump(key: string) {
    setCollapsed((current) => ({ ...current, [key]: false }));
    // The section has to be open before it can be scrolled to.
    window.requestAnimationFrame(() => document.getElementById(sectionId(key))?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }

  const section = ([key, child]: [string, JsonValue]) => {
    const missing = needsInputCount(child);
    if (onlyMissing && missing === 0) return null;
    const isOpen = !collapsed[key];
    return (
      <section key={key} id={sectionId(key)} className="scroll-mt-2 border border-gray-200 bg-white">
        <button
          type="button"
          onClick={() => setCollapsed((current) => ({ ...current, [key]: isOpen }))}
          className="flex w-full items-center justify-between gap-3 bg-gray-50 px-4 py-3 text-left hover:bg-gray-100"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className={`shrink-0 text-gray-400 transition-transform ${isOpen ? "rotate-90" : ""}`}>›</span>
            <span className="truncate text-sm font-semibold text-gray-900">{label(key)}</span>
          </span>
          {missing > 0 && <span className="shrink-0 bg-amber-100 px-2 py-0.5 text-[11px] font-bold text-amber-800">{missing} to fill</span>}
        </button>
        {isOpen && (
          <div className="min-w-0 border-t border-gray-100 p-4">
            <JsonNode value={child} path={key} depth={1} onlyMissing={onlyMissing} onChange={(next) => onChange({ ...(value as Record<string, JsonValue>), [key]: next })} />
          </div>
        )}
      </section>
    );
  };

  return (
    <div className="space-y-3">
      <div className="border border-gray-200 bg-white p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[11px] font-bold uppercase text-gray-500">Sections in this file</p>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => setCollapsed(Object.fromEntries(visible.map(([key]) => [key, true])))} className="text-[11px] font-semibold text-gray-500 hover:text-gray-900">Collapse all</button>
            <button type="button" onClick={() => setCollapsed({})} className="text-[11px] font-semibold text-gray-500 hover:text-gray-900">Expand all</button>
          </div>
        </div>
        {/* The fastest way through a large file is to stop looking at the parts
            that are already settled. */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-2">
          <p className={`text-xs font-semibold ${totalMissing > 0 ? "text-amber-700" : "text-emerald-700"}`}>
            {totalMissing > 0
              ? isChecklist
                ? `${totalMissing} researcher decision${totalMissing === 1 ? "" : "s"} still need input`
                : `${totalMissing} field${totalMissing === 1 ? "" : "s"} still need your input`
              : "Nothing in this file is waiting on you"}
          </p>
          {totalMissing > 0 && (
            <button
              type="button"
              onClick={() => { setOnlyMissing((current) => !current); setCollapsed({}); }}
              className={`border px-3 py-1.5 text-[11px] font-semibold ${onlyMissing ? "border-amber-500 bg-amber-100 text-amber-900" : "border-gray-300 bg-white text-gray-700 hover:border-amber-400"}`}
            >
              {onlyMissing ? "Showing only what needs input · show everything" : "Show only what needs input"}
            </button>
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {visible.map(([key, child]) => {
            const missing = needsInputCount(child);
            if (onlyMissing && missing === 0) return null;
            return (
              <button
                key={key}
                type="button"
                onClick={() => jump(key)}
                className={`border px-2 py-1 text-[11px] font-semibold ${missing > 0 ? "border-amber-300 bg-amber-50 text-amber-900" : "border-gray-200 bg-white text-gray-600 hover:border-cyan-300"}`}
              >
                {label(key)}{missing > 0 ? ` · ${missing}` : ""}
              </button>
            );
          })}
        </div>
      </div>

      {visible.map(section)}

      {technical.length > 0 && (
        <details className="border border-gray-200 bg-white">
          <summary className="cursor-pointer bg-gray-50 px-4 py-3 text-sm font-semibold text-gray-500">Technical extraction details</summary>
          <div className="space-y-3 border-t border-gray-100 p-4">{technical.map(([key, child]) => (
            <div key={key} className="min-w-0">
              <p className="mb-1 text-xs font-semibold text-gray-700">{label(key)}</p>
              <JsonNode value={child} path={key} depth={2} onChange={(next) => onChange({ ...(value as Record<string, JsonValue>), [key]: next })} />
            </div>
          ))}</div>
        </details>
      )}
    </div>
  );
}

function fileGuide(path: string) {
  if (path.endsWith("/study.json")) return "Study overview, participant flow, conditions, and outcomes";
  if (path.endsWith("/materials/materials.json")) return "Questionnaires, stimuli, instructions, and response formats";
  if (path.endsWith("/task/task.json")) return "Runnable agent interaction and condition assignment";
  if (path.endsWith("/audit/missing_information.json")) return "Decisions or source material that still need researcher input";
  if (path.endsWith("/source/evidence.json")) return "Evidence supporting the extracted study content";
  if (path.endsWith("/source/open_materials.json")) return "OSF, supplementary files, and other sources searched";
  if (path.endsWith("/audit/agent_report.md")) return "Agent summary and recommended review order";
  if (path.endsWith("README.md")) return "Human-readable package documentation";
  return "Supporting study file";
}

const agentTasks = [
  ["Read the paper", "Identify studies, samples, procedures, and reported findings"],
  ["Find open materials", "Search OSF, supplements, repositories, and author pages"],
  ["Build the study", "Organize materials and create the runnable agent task"],
  ["Check the package", "Validate files and flag everything requiring researcher input"],
] as const;

const progressLabels: Record<PipelineProgress["phase"], string> = {
  building_package: "Building study files",
  validating_package: "Checking the runnable package",
  ready_for_review: "Preparing researcher review",
  timed_out: "Agent time limit reached",
  failed: "Package build stopped",
};

export default function PipelineStudio() {
  const STORAGE_KEY = "humanstudy-hub-active-job";
  const fileInput = useRef<HTMLInputElement>(null);
  const [paper, setPaper] = useState<File | null>(null);
  const [osf, setOsf] = useState("");
  const [contributorName, setContributorName] = useState("");
  const [contributorId, setContributorId] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [reviewFiles, setReviewFiles] = useState<ReviewFile[]>([]);
  const [selectedFile, setSelectedFile] = useState("");
  const [editedContent, setEditedContent] = useState("");
  const [editedJson, setEditedJson] = useState<JsonValue | null>(null);
  const [saved, setSaved] = useState(true);
  const [activeSection, setActiveSection] = useState("");
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [stalled, setStalled] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [lookupName, setLookupName] = useState("");
  const [foundJobs, setFoundJobs] = useState<Array<{ id: string; paperName: string; status: JobStatus; createdAt?: string }> | null>(null);
  const [searching, setSearching] = useState(false);
  const [importStudyId, setImportStudyId] = useState("study_001");
  const [openMaterialsFiles, setOpenMaterialsFiles] = useState<File[] | null>(null);
  const [openMaterialsName, setOpenMaterialsName] = useState("");
  const openMaterialsZipInput = useRef<HTMLInputElement>(null);
  const openMaterialsFolderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const requestedJobId = new URLSearchParams(window.location.search).get("job");
    const savedJobId = requestedJobId || window.localStorage.getItem(STORAGE_KEY);
    if (!savedJobId) return;
    window.localStorage.setItem(STORAGE_KEY, savedJobId);
    fetch(`/api/pipeline/jobs/${savedJobId}`, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { if (data?.job) { setJob(data.job); setLog(data.log || ""); } else window.localStorage.removeItem(STORAGE_KEY); })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (job) window.localStorage.setItem(STORAGE_KEY, job.id);
  }, [job]);

  useEffect(() => {
    if (!job || (job.status !== "queued" && job.status !== "running")) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/pipeline/jobs/${job.id}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as { job: Job; log: string };
        setJob(data.job);
        setLog(data.log);
        if (data.job.status === "review") {
          const filesResponse = await fetch(`/api/pipeline/jobs/${data.job.id}/files`, { cache: "no-store" });
          if (filesResponse.ok) setReviewFiles((await filesResponse.json()).files);
        }
      } catch {
        // A transient local-server or network interruption is retried on the next poll.
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [job]);

  useEffect(() => {
    if (!job || job.status !== "review") return;
    const url = job.source === "import"
      ? `/api/pipeline/study-files?study=${job.experimentId}`
      : `/api/pipeline/jobs/${job.id}/files`;
    fetch(url, { cache: "no-store" })
      .then((response) => response.ok ? response.json() : null)
      .then((data) => { if (data?.files) setReviewFiles(data.files); })
      .catch(() => undefined);
  }, [job]);

  // A job that never leaves "queued" means no runner picked up the dispatched run.
  useEffect(() => {
    setStalled(false);
    if (!job || job.status !== "queued" || !job.createdAt) return;
    const since = Date.parse(job.createdAt);
    if (Number.isNaN(since)) return;
    const remaining = since + STALL_MS - Date.now();
    if (remaining <= 0) {
      setStalled(true);
      return;
    }
    const timer = window.setTimeout(() => setStalled(true), remaining);
    return () => window.clearTimeout(timer);
  }, [job]);

  // Highlight the map node for the section currently in view. When study.json is
  // selected its top-level keys render as `section-<key>` anchors, so a
  // scroll-tracking observer keeps the minimap in step with the editor.
  useEffect(() => {
    if (!selectedFile.endsWith("study.json")) { setActiveSection(""); return; }
    const sections = Array.from(document.querySelectorAll<HTMLElement>("section[id^='section-']"));
    if (sections.length === 0) { setActiveSection(""); return; }
    const observer = new IntersectionObserver((entries) => {
      // Prefer the entry nearest the top of the scroll container.
      const visible = entries.filter((entry) => entry.isIntersecting);
      if (visible.length === 0) return;
      const topmost = visible.reduce((a, b) => (a.boundingClientRect.top <= b.boundingClientRect.top ? a : b));
      const key = topmost.target.id.replace(/^section-/, "");
      setActiveSection(key);
    }, { root: null, rootMargin: "0px 0px -70% 0px", threshold: 0 });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [selectedFile, editedJson]);

  function chooseFile(file?: File) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setError("Please choose a PDF.");
      return;
    }
    if (file.size > MAX_PAPER_BYTES) {
      setError(`This PDF is ${(file.size / 1024 / 1024).toFixed(1)} MB. Please upload a PDF up to 50 MB.`);
      return;
    }
    setError("");
    setPaper(file);
  }

  function chooseOpenMaterialsZip(file?: File) {
    if (!file) return;
    if (file.size > MAX_MATERIALS_BYTES) {
      setError(`This file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Open materials are capped at 100 MB.`);
      return;
    }
    setError("");
    setOpenMaterialsFiles([file]);
    setOpenMaterialsName(file.name);
  }

  function chooseOpenMaterialsFolder(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > MAX_MATERIALS_BYTES) {
      setError(`This folder is ${(total / 1024 / 1024).toFixed(1)} MB. Open materials are capped at 100 MB.`);
      return;
    }
    const root = (files[0].webkitRelativePath || "materials").split("/")[0] || "materials";
    setError("");
    setOpenMaterialsFiles(files);
    setOpenMaterialsName(`${root}.zip`);
  }

  function clearOpenMaterials() {
    setOpenMaterialsFiles(null);
    setOpenMaterialsName("");
    if (openMaterialsZipInput.current) openMaterialsZipInput.current.value = "";
    if (openMaterialsFolderInput.current) openMaterialsFolderInput.current.value = "";
  }

  async function start() {
    if (!paper) return;
    setBusy(true);
    setError("");
    setUploadPercent(0);
    try {
      // Upload straight to Vercel Blob; a function request body caps out at 4.5 MB.
      const blob = await upload(paper.name, paper, {
        access: "private",
        handleUploadUrl: "/api/pipeline/upload",
        contentType: "application/pdf",
        // Large papers upload in parallel parts, and failed parts are retried.
        multipart: paper.size > 8 * 1024 * 1024,
        onUploadProgress: ({ percentage }) => setUploadPercent(percentage),
      });
      // Open materials are optional. A single .zip uploads as-is; a chosen
      // folder is zipped here in the browser so it travels as one blob.
      let openMaterialsPathname: string | undefined;
      if (openMaterialsFiles && openMaterialsFiles.length > 0) {
        const singleZip = openMaterialsFiles.length === 1 && openMaterialsFiles[0].name.toLowerCase().endsWith(".zip");
        let materialsBlob: Blob;
        if (singleZip) {
          materialsBlob = openMaterialsFiles[0];
        } else {
          const zip = new JSZip();
          for (const file of openMaterialsFiles) zip.file(file.webkitRelativePath || file.name, file);
          materialsBlob = await zip.generateAsync({ type: "blob" });
        }
        const materials = await upload(openMaterialsName || "open-materials.zip", materialsBlob, {
          access: "private",
          handleUploadUrl: "/api/pipeline/upload-materials",
          contentType: "application/zip",
          multipart: materialsBlob.size > 8 * 1024 * 1024,
          onUploadProgress: ({ percentage }) => setUploadPercent(percentage),
        });
        openMaterialsPathname = materials.pathname;
      }
      setUploadPercent(null);
      const response = await fetch("/api/pipeline/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperPathname: blob.pathname, paperName: paper.name, osfUrl: osf, openMaterialsPathname, openMaterialsName: openMaterialsPathname ? openMaterialsName : undefined, contributorName, contributorGithub: contributorId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not start conversion.");
      setJob(data.job);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start conversion.");
    } finally {
      setUploadPercent(null);
      setBusy(false);
    }
  }

  async function importExisting() {
    if (!importStudyId) return;
    setBusy(true);
    setError("");
    setReviewFiles([]);
    setSelectedFile("");
    setSaved(true);
    setNote("");
    // A demo import never writes to the private jobs repository: the review and
    // ship flow runs against the study's real files in the public benchmark,
    // while the job itself exists only in this tab.
    const now = new Date().toISOString();
    setJob({
      id: `import:${importStudyId}`,
      experimentId: importStudyId,
      paperName: importStudyId,
      currentStage: 1,
      status: "review",
      message: "Imported study ready for review",
      packageReady: true,
      source: "import",
      createdAt: now,
      updatedAt: now,
    });
    setBusy(false);
  }

  async function retry() {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/pipeline/jobs/${job.id}/retry`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not restart this job.");
      setJob(data.job);
      setStalled(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not restart this job.");
    } finally {
      setBusy(false);
    }
  }

  async function review(decision: "approved" | "changes_requested") {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      if (job.source === "import") {
        // Demo imports have no job branch to record a review against. Approving
        // completes the flow locally; requesting changes has nothing to write.
        if (decision === "changes_requested") {
          setError("Changes cannot be requested on an imported study.");
          return;
        }
        setReviewFiles([]);
        setNote("");
        setJob({ ...job, status: "complete", packageReady: true, message: "Study package is approved and ready", updatedAt: new Date().toISOString() });
        return;
      }
      const response = await fetch(`/api/pipeline/jobs/${job.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, note }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Review could not be saved.");
      setJob(data.job);
      if (decision === "approved") setReviewFiles([]);
      if (decision === "approved") setNote("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Review could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  async function saveFile() {
    if (!job || !selectedFile) return;
    setBusy(true); setError("");
    try {
      const content = selectedFile.endsWith(".json") ? JSON.stringify(editedJson, null, 2) + "\n" : editedContent;
      if (job.source === "import") {
        // Demo imports have no job branch; edits live only in this tab.
        setEditedContent(content);
        setReviewFiles((files) => files.map((file) => file.path === selectedFile ? { ...file, content } : file));
        setSaved(true);
        return;
      }
      const response = await fetch(`/api/pipeline/jobs/${job.id}/files`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: selectedFile, content }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save file.");
      setEditedContent(content);
      setReviewFiles((files) => files.map((file) => file.path === selectedFile ? { ...file, content } : file));
      setSaved(true);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not save file."); }
    finally { setBusy(false); }
  }

  // Called by the minimap: jump to a study.json section, first switching to
  // study.json if another file is currently selected.
  function goToStudySection(target: string) {
    const studyFile = reviewFiles.find((file) => file.path.endsWith("study.json"));
    if (!studyFile) return;
    if (!selectedFile.endsWith("study.json")) {
      setSelectedFile(studyFile.path);
      setEditedContent(studyFile.content);
      setEditedJson(JSON.parse(studyFile.content));
      setSaved(true);
    }
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      const id = `section-${target.replace(/[^a-zA-Z0-9_-]/g, "")}`;
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
    }));
  }

  async function publish() {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/pipeline/jobs/${job.id}/publish`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save to GitHub.");
      setPrUrl(data.prUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save to GitHub.");
    } finally {
      setBusy(false);
    }
  }

  async function findMyJobs() {
    setSearching(true);
    setError("");
    try {
      const response = await fetch(`/api/pipeline/jobs/search?contributor=${encodeURIComponent(lookupName.trim())}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not search for your studies.");
      setFoundJobs(data.jobs);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not search for your studies.");
      setFoundJobs(null);
    } finally {
      setSearching(false);
    }
  }

  async function openJob(id: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/pipeline/jobs/${id}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not open that study.");
      window.localStorage.setItem(STORAGE_KEY, id);
      setJob(data.job);
      setLog(data.log || "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not open that study.");
    } finally {
      setBusy(false);
    }
  }

  // Send an already-approved job back to review so its files can be re-inspected
  // and re-approved. Does not re-run the build.
  async function reopenReview() {
    if (!job) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/pipeline/jobs/${job.id}/reopen`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not reopen the review.");
      setJob(data.job);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not reopen the review.");
    } finally {
      setBusy(false);
    }
  }

  function leaveJob() {
    window.localStorage.removeItem(STORAGE_KEY);
    setJob(null);
    setLog("");
    setReviewFiles([]);
    setSelectedFile("");
    window.history.replaceState({}, "", "/pipeline");
  }

  if (!job) {
    return (
      <div className="min-h-[calc(100vh-4rem)] bg-[#f7f9fa]">
        <header className="border-b border-gray-200 bg-white">
          <div className="mx-auto max-w-6xl px-5 py-9 sm:px-8">
            <p className="text-xs font-semibold uppercase text-cyan-700">Build an existing study</p>
            <h1 className="mt-2 max-w-3xl font-serif text-3xl font-bold text-gray-950">Start with the paper</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">Upload the study. Our agent builds the runnable files; you review them before anything is published.</p>
          </div>
        </header>

        <main className="mx-auto grid max-w-6xl gap-8 px-5 py-9 sm:px-8 lg:grid-cols-[minmax(0,1fr)_300px]">
          <section className="border border-gray-200 bg-white p-6 shadow-sm">
            <div className="border-b border-gray-100 pb-5">
              <p className="text-sm font-semibold text-gray-950">1. Add the paper</p>
              <p className="mt-1 text-xs text-gray-500">PDF required · up to 50 MB</p>
            </div>

            <button type="button" onClick={() => fileInput.current?.click()} className={`mt-5 flex min-h-40 w-full flex-col items-center justify-center border border-dashed px-6 text-center transition-colors ${paper ? "border-emerald-400 bg-emerald-50" : "border-cyan-300 bg-cyan-50 hover:border-cyan-600 hover:bg-cyan-100"}`}>
              <span className={`flex h-10 w-10 items-center justify-center rounded-full text-xl font-light ${paper ? "bg-emerald-600 text-white" : "bg-cyan-700 text-white"}`}>{paper ? "✓" : "+"}</span>
              <span className="mt-3 text-sm font-semibold text-gray-950">{paper?.name || "Choose a paper PDF"}</span>
              {paper && <span className="mt-1 text-xs text-emerald-700">{(paper.size / 1024 / 1024).toFixed(1)} MB · ready</span>}
            </button>
            <input ref={fileInput} type="file" accept=".pdf,application/pdf" className="hidden" onChange={(event) => chooseFile(event.target.files?.[0])} />

            <div className="mt-6 rounded border border-dashed border-gray-300 bg-gray-50 p-4">
              <p className="text-xs font-semibold text-gray-700">Or import an existing study <span className="font-normal text-gray-400">(demo)</span></p>
              <p className="mt-1 text-[11px] text-gray-500">Skip extraction and walk the review + ship flow with a benchmark study.</p>
              <div className="mt-3 flex gap-2">
                <select value={importStudyId} onChange={(event) => setImportStudyId(event.target.value)} className="h-9 flex-1 border border-gray-300 px-2 text-sm outline-none focus:border-cyan-700">
                  {Array.from({ length: 16 }, (_, i) => `study_${String(i + 1).padStart(3, "0")}`).map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
                <button type="button" disabled={busy} onClick={importExisting} className="h-9 shrink-0 bg-emerald-700 px-3 text-xs font-semibold text-white hover:bg-emerald-600 disabled:bg-gray-300">{busy ? "Importing…" : "Import"}</button>
              </div>
            </div>

            <div className="mt-6 border-b border-gray-100 pb-3"><p className="text-sm font-semibold text-gray-950">2. Add study details</p></div>
            <label className="mt-5 block text-sm font-semibold text-gray-900" htmlFor="osf-url">Open materials <span className="font-normal text-gray-400">optional</span></label>
            <input id="osf-url" value={osf} onChange={(event) => setOsf(event.target.value)} placeholder="https://osf.io/... or another materials URL" className="mt-2 h-10 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input ref={openMaterialsZipInput} type="file" accept=".zip,application/zip,application/x-zip-compressed" className="hidden" onChange={(event) => chooseOpenMaterialsZip(event.target.files?.[0])} />
              <input ref={openMaterialsFolderInput} type="file" multiple className="hidden" {...directoryInputProps} onChange={(event) => chooseOpenMaterialsFolder(event.target.files)} />
              <button type="button" disabled={busy} onClick={() => openMaterialsZipInput.current?.click()} className="h-9 border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:border-cyan-400 disabled:bg-gray-100">Upload a ZIP</button>
              <button type="button" disabled={busy} onClick={() => openMaterialsFolderInput.current?.click()} className="h-9 border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:border-cyan-400 disabled:bg-gray-100">Upload a folder</button>
              {openMaterialsFiles && openMaterialsFiles.length > 0 && (
                <span className="flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs text-emerald-800">
                  <span className="font-semibold">{openMaterialsFiles.length === 1 && openMaterialsFiles[0].name.toLowerCase().endsWith(".zip") ? openMaterialsFiles[0].name : `${(openMaterialsFiles[0].webkitRelativePath || "materials").split("/")[0]}/ · ${openMaterialsFiles.length} files`}</span>
                  <button type="button" onClick={clearOpenMaterials} className="font-bold text-emerald-600 hover:text-red-700">✕</button>
                </span>
              )}
            </div>
            <p className="mt-2 text-[11px] text-gray-500">Questionnaires, stimuli, or data. A URL is followed online; a ZIP or folder is extracted for the agent (folders are zipped in your browser, up to 100 MB).</p>

            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-semibold text-gray-900" htmlFor="contributor-name">Contributor name</label>
                <input id="contributor-name" value={contributorName} onChange={(event) => setContributorName(event.target.value)} className="mt-2 h-10 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />
              </div>
              <div>
                <label className="block text-sm font-semibold text-gray-900" htmlFor="contributor-id">GitHub ID <span className="font-normal text-gray-400">optional</span></label>
                <input id="contributor-id" value={contributorId} onChange={(event) => setContributorId(event.target.value.replace(/^@/, ""))} className="mt-2 h-10 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />
              </div>
            </div>

            {error && <p className="mt-5 border-l-2 border-red-600 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
            {uploadPercent !== null && (
              <div className="mt-5">
                <div className="flex items-center justify-between text-xs text-gray-600"><span>Uploading {paper?.name}</span><span className="font-mono font-semibold text-cyan-800">{Math.round(uploadPercent)}%</span></div>
                <div className="mt-2 h-2 overflow-hidden bg-gray-100"><div className="h-full bg-cyan-700 transition-[width] duration-300" style={{ width: `${uploadPercent}%` }} /></div>
              </div>
            )}
            <div className="mt-7 flex justify-end border-t border-gray-100 pt-5">
              <div className="flex flex-col items-end gap-3 sm:flex-row sm:items-center">
                <button type="button" disabled={!paper || !contributorName.trim() || busy} onClick={start} className="h-10 bg-cyan-700 px-5 text-sm font-semibold text-white hover:bg-cyan-600 disabled:cursor-not-allowed disabled:bg-gray-300">
                  {busy ? (uploadPercent !== null ? `Uploading ${Math.round(uploadPercent)}%` : "Starting...") : "Build this study"}
                </button>
              </div>
            </div>
          </section>

          <aside className="space-y-5">
            <section className="border border-cyan-200 bg-cyan-50 p-4">
              <p className="text-sm font-semibold text-cyan-950">Is this study a good fit?</p>
              <ul className="mt-3 space-y-2 text-xs leading-5 text-cyan-950">
                <li><span className="mr-2 text-emerald-600">✓</span>Human results are reported</li>
                <li><span className="mr-2 text-emerald-600">✓</span>Instructions and stimuli are available</li>
                <li><span className="mr-2 text-amber-600">!</span>Safe and appropriate to simulate</li>
              </ul>
            </section>

            <section className="border border-gray-200 bg-white p-4">
              <p className="text-sm font-semibold text-gray-900">Open a previous study</p>
              <div className="mt-3 flex">
                <input value={lookupName} onChange={(event) => setLookupName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") findMyJobs(); }} placeholder="Contributor name" className="h-9 min-w-0 flex-1 border border-gray-300 px-3 text-xs outline-none focus:border-cyan-700" />
                <button type="button" title="Search studies" disabled={searching || lookupName.trim().length < 2} onClick={findMyJobs} className="h-9 w-10 shrink-0 bg-gray-900 text-sm text-white hover:bg-cyan-700 disabled:bg-gray-300">→</button>
              </div>
              {foundJobs && foundJobs.length === 0 && <p className="mt-3 text-xs text-gray-500">No studies found.</p>}
              {foundJobs && foundJobs.length > 0 && <ul className="mt-3 divide-y divide-gray-200">{foundJobs.map((entry) => <li key={entry.id}><button type="button" onClick={() => openJob(entry.id)} className="flex w-full items-center justify-between gap-2 py-2 text-left"><span className="truncate text-xs font-semibold text-gray-800">{entry.paperName}</span><span className={`shrink-0 px-1.5 py-0.5 text-[9px] font-semibold ${entry.status === "review" ? "bg-amber-100 text-amber-800" : entry.status === "complete" ? "bg-emerald-100 text-emerald-800" : entry.status === "failed" ? "bg-red-100 text-red-800" : "bg-cyan-100 text-cyan-800"}`}>{entry.status}</span></button></li>)}</ul>}
            </section>

            <section className="px-2">
            <p className="text-xs font-semibold uppercase text-gray-500">What happens next</p>
            <ol className="mt-4 border-l border-gray-300">
              {agentTasks.map(([label, detail], index) => (
                <li key={label} className="relative pb-5 pl-6">
                  <span className="absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full border border-cyan-200 bg-cyan-50 text-[11px] font-bold text-cyan-800">{index + 1}</span>
                  <p className="text-sm font-semibold text-gray-800">{label}</p>
                  <p className="mt-0.5 text-[11px] leading-4 text-gray-500">{detail}</p>
                </li>
              ))}
            </ol>
            </section>
          </aside>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#f7f9fa]">
      <header className="border-b border-gray-200 bg-white px-5 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-gray-950">{job.paperName}</p>
            <p className="mt-1 font-mono text-xs text-gray-500">{job.experimentId.startsWith("draft_") ? "Draft study" : `studies/${job.experimentId}/`}</p>
          </div>
          <div className="flex items-center gap-3"><Link href="/" className="text-xs font-semibold text-gray-500 hover:text-gray-950">Back to Hub</Link><button type="button" onClick={() => setLeaving(true)} className="text-xs font-semibold text-cyan-700 hover:text-cyan-900">Start another study</button><span className={`px-2 py-1 text-xs font-semibold ${job.status === "failed" ? "bg-red-100 text-red-800" : job.status === "complete" ? "bg-emerald-100 text-emerald-800" : job.status === "review" ? "bg-amber-100 text-amber-800" : "bg-cyan-100 text-cyan-800"}`}>{job.status}</span></div>
        </div>
      </header>

      {leaving && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/40 p-4">
          <div className="w-full max-w-md border border-gray-300 bg-white p-6 shadow-xl">
            <p className="font-serif text-lg font-bold text-gray-950">Leave this study?</p>
            <p className="mt-2 text-sm leading-6 text-gray-600">
              {job.status === "review"
                ? "This package is waiting for your review. Saved edits are kept, but unsaved ones are not."
                : "This job keeps running whether or not you stay on the page."}
            </p>
            <p className="mt-3 border-l-2 border-cyan-700 bg-cyan-50 p-3 text-xs leading-5 text-cyan-950">
              You can come back to it. Keep this job id, or find it again from the name you submitted it under.
              <span className="mt-1 block break-all font-mono font-semibold">{job.id}</span>
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setLeaving(false)} className="h-10 border border-gray-300 px-4 text-sm font-semibold text-gray-700 hover:border-gray-400">Keep reviewing</button>
              <button type="button" onClick={() => { setLeaving(false); leaveJob(); }} className="h-10 bg-cyan-700 px-4 text-sm font-semibold text-white hover:bg-cyan-600">Start another study</button>
            </div>
          </div>
        </div>
      )}

      <main className="mx-auto grid max-w-7xl gap-6 px-5 py-8 lg:grid-cols-[240px_minmax(0,1fr)]">
        <nav className="border border-gray-200 bg-white p-3">
          <p className="px-3 pb-2 pt-1 text-[10px] font-bold uppercase text-gray-500">Agent workflow</p>
          {agentTasks.map(([label, detail]) => (
            <div key={label} className="flex gap-3 p-3">
              <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${job.status === "failed" ? "bg-gray-300" : job.status === "review" || job.status === "complete" ? "bg-emerald-600" : "animate-pulse bg-cyan-700"}`} />
              <div><p className="text-xs font-semibold">{label}</p><p className="mt-1 text-[11px] leading-4 text-gray-500">{detail}</p></div>
            </div>
          ))}
        </nav>

        <section className="min-w-0 border border-gray-200 bg-white">
          <div className="border-b border-gray-200 p-6">
            <p className="text-xs font-semibold uppercase text-cyan-700">Agent study builder</p>
            <h1 className="mt-2 font-serif text-2xl font-bold">{job.message.replace("Claude Code", "Our agent")}</h1>
            <p className="mt-2 text-sm text-gray-500">Progress and review decisions are saved under job {job.id}.</p>
          </div>

          {(job.status === "running" || job.status === "queued") && (
            <div className="p-6">
              {stalled && (
                <div className="mb-5 border-l-2 border-amber-500 bg-amber-50 p-4">
                  <p className="text-sm font-semibold text-amber-950">The build has not started yet</p>
                  <p className="mt-1 text-sm leading-6 text-amber-900">GitHub Actions has not given this job a runner. Your paper is saved, so restarting does not require another upload.</p>
                  <button type="button" disabled={busy} onClick={retry} className="mt-3 h-9 bg-amber-700 px-4 text-xs font-semibold text-white hover:bg-amber-600 disabled:bg-gray-300">{busy ? "Restarting..." : "Restart the build"}</button>
                </div>
              )}
              {error && <p className="mb-5 border-l-2 border-red-600 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
              {job.progress ? <>
                <div className="flex items-end justify-between gap-4">
                  <div><p className="text-sm font-semibold text-gray-950">{progressLabels[job.progress.phase]}</p><p className="mt-1 text-xs text-gray-500">{job.progress.completedRequired} of {job.progress.totalRequired} required files · {job.progress.totalFiles} total files</p></div>
                  <p className="font-mono text-sm font-semibold text-cyan-800">{Math.round((job.progress.completedRequired / Math.max(1, job.progress.totalRequired)) * 100)}%</p>
                </div>
                <div className="mt-3 h-2 overflow-hidden bg-gray-100"><div className="h-full bg-cyan-700 transition-[width] duration-500" style={{ width: `${Math.min(100, (job.progress.completedRequired / Math.max(1, job.progress.totalRequired)) * 100)}%` }} /></div>
                {job.progress.missing.length > 0 && <details className="mt-4 border-t border-gray-200 pt-3"><summary className="cursor-pointer text-xs font-semibold text-gray-600">Remaining required files ({job.progress.missing.length})</summary><ul className="mt-2 grid gap-1 sm:grid-cols-2">{job.progress.missing.map((file) => <li key={file} className="break-all font-mono text-[11px] text-gray-500">{file}</li>)}</ul></details>}
              </> : <div className="h-1.5 overflow-hidden bg-gray-100"><div className="h-full w-1/2 animate-pulse bg-cyan-700" /></div>}
              <p className="mt-4 text-sm leading-6 text-gray-600">The agent is reading the paper, {job.osfUrl ? "processing the supplied open materials, " : ""}building the study files, and running package checks. You can leave this page and return to the same job.</p>
              {log && <pre className="mt-5 max-h-80 overflow-auto bg-gray-950 p-4 text-xs leading-5 text-gray-200">{log}</pre>}
            </div>
          )}

          {job.status === "review" && (
            <div className="p-6">
              <div className="border-l-2 border-amber-500 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
                Correct anything the agent got wrong and fill amber-highlighted gaps, then save and approve.
              </div>
              <div className="mt-6 space-y-4">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Final study package review</p>
                  <p className="mt-1 text-sm text-gray-500">Pick a file on the left, edit what needs input, save, then approve below.</p>
                </div>
                {(() => {
                  const studyFile = reviewFiles.find((file) => file.path.endsWith("study.json"));
                  if (!studyFile) return null;
                  let json: JsonValue | null = null;
                  try { json = JSON.parse(studyFile.content); } catch { json = null; }
                  if (!json) return null;
                  const map = buildStudyMap(json);
                  const decisions = filePendingCount("/audit/missing_information.json", reviewFiles.find((f) => f.path.endsWith("missing_information.json"))?.content || "{}");
                  return (
                    <div className="border border-gray-200 bg-white p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-gray-900">Where to start</p>
                        <span className="text-[11px] text-gray-400">{map.children?.length ?? 0} sections · {decisions} decisions to confirm</span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {map.children?.map((branch) => {
                          const target = branch.target;
                          return target ? (
                            <button key={target} type="button" onClick={() => goToStudySection(target)} className="border border-gray-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-gray-700 hover:border-cyan-500 hover:text-cyan-800">{label(branch.label)}{branch.children?.length ? ` (${branch.children.length})` : ""}</button>
                          ) : null;
                        })}
                      </div>
                    </div>
                  );
                })()}
                {reviewFiles.length === 0 ? <p className="border border-gray-200 bg-gray-50 p-4 text-sm text-gray-500">Loading generated files...</p> : <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
                  <div className="space-y-4">
                    <div className="border border-gray-200 bg-gray-50 p-2">
                      {(() => {
                        const priorityPaths = ["/study.json", "/materials/materials.json", "/task/task.json", "/audit/missing_information.json", "/audit/agent_report.md"];
                        const priority = reviewFiles.filter((file) => priorityPaths.some((suffix) => file.path.endsWith(suffix)));
                        const additional = reviewFiles.filter((file) => !priority.includes(file));
                        // What a file contains is what a reviewer is choosing between;
                        // its path only matters once they need to find it on disk.
                        const fileButton = (file: ReviewFile) => <button key={file.path} onClick={() => { setSelectedFile(file.path); setEditedContent(file.content); setEditedJson(file.path.endsWith(".json") ? JSON.parse(file.content) : null); setSaved(true); }} className={`block w-full border-l-2 px-3 py-2 text-left ${selectedFile === file.path ? "border-cyan-700 bg-white" : "border-transparent hover:bg-white"}`}><span className="flex items-center gap-1.5"><span className={`block text-xs font-semibold leading-5 ${selectedFile === file.path ? "text-cyan-800" : "text-gray-800"}`}>{fileGuide(file.path)}</span>{(() => { const pending = filePendingCount(file.path, file.content); return pending > 0 ? <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${file.path.endsWith("missing_information.json") ? "bg-amber-200 text-amber-900" : "bg-amber-100 text-amber-800"}`}>{pending}</span> : null; })()}</span><span className="mt-1 block break-all font-mono text-[10px] leading-4 text-gray-400">{file.path.split("/").slice(1).join("/") || file.path}</span></button>;
                        return <><p className="px-3 pb-2 pt-1 text-[10px] font-bold uppercase tracking-wide text-cyan-800">Review first</p>{priority.map(fileButton)}<details className="mt-2 border-t border-gray-200 pt-2"><summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-gray-600">Additional files ({additional.length})</summary>{additional.map(fileButton)}</details></>;
                      })()}
                    </div>
                    {(() => {
                      const studyFile = reviewFiles.find((file) => file.path.endsWith("study.json"));
                      if (!studyFile) return null;
                      let json: JsonValue | null = null;
                      try { json = JSON.parse(studyFile.content); } catch { json = null; }
                      return json ? <StructureMap value={json} activeTarget={activeSection} onGoTo={goToStudySection} /> : null;
                    })()}
                  </div>
                  <div className="min-w-0 border border-gray-200">
                    {selectedFile ? <>
                      {/* min-w-0 and a truncated path are what stop a long file
                          name from pushing the save button out of the header. */}
                      <div className="flex items-center justify-between gap-3 border-b border-gray-200 bg-gray-50 px-4 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold text-gray-800">{fileGuide(selectedFile)}</p>
                          <p className="truncate font-mono text-[10px] text-gray-400" title={selectedFile}>{selectedFile}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-3">
                          {!saved && <span className="text-xs text-amber-700">Unsaved changes</span>}
                          <button disabled={busy || saved} onClick={saveFile} className="h-8 shrink-0 bg-cyan-700 px-3 text-xs font-semibold text-white disabled:bg-gray-300">{busy ? "Saving..." : saved ? "Saved" : "Save changes"}</button>
                        </div>
                      </div>
                      {selectedFile.endsWith(".json") && editedJson !== null ? <div className="min-w-0"><div className="max-h-[calc(100vh-13rem)] overflow-auto bg-gray-50"><div className="p-4"><JsonEditor value={editedJson} path={selectedFile} onChange={(next) => { setEditedJson(next); setSaved(false); }} /></div></div></div> : <textarea value={editedContent} onChange={(event) => { setEditedContent(event.target.value); setSaved(false); }} spellCheck={false} className="min-h-[calc(100vh-18rem)] w-full resize-y p-4 font-mono text-xs leading-5 text-gray-700 outline-none focus:ring-2 focus:ring-cyan-700" />}
                    </> : <p className="p-6 text-sm text-gray-500">Select a file to inspect and edit.</p>}
                  </div>
                </div>}
              </div>
              <label htmlFor="review-note" className="mt-6 block text-sm font-semibold">Review note</label>
              <textarea id="review-note" value={note} onChange={(event) => setNote(event.target.value)} className="mt-2 h-32 w-full border border-gray-300 p-3 text-sm outline-none focus:border-cyan-700" placeholder="Corrections, missing evidence, or approval rationale" />
              <div className="mt-4 flex justify-end gap-2">
                <button disabled={busy || !note.trim()} onClick={() => review("changes_requested")} className="h-10 border border-gray-300 px-4 text-sm font-semibold text-gray-700 disabled:text-gray-300">Request changes</button>
                <button disabled={busy || !saved} onClick={() => review("approved")} className="h-10 bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-600 disabled:bg-gray-300">Approve package</button>
              </div>
            </div>
          )}

          {job.status === "failed" && (
            <div className="p-6">
              <p className="border-l-2 border-red-600 bg-red-50 p-4 text-sm text-red-900">{job.error || "The pipeline failed."}</p>
              <pre className="mt-5 max-h-80 overflow-auto bg-gray-950 p-4 text-xs leading-5 text-gray-200">{log}</pre>
            </div>
          )}

          {job.status === "complete" && (
            <div className="p-6">
              {job.packageReady ? <><div className="border-l-2 border-emerald-600 bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">The reviewed HumanStudy-Bench package is ready for download and can be used by the Run Experiment workspace.</div><div className="mt-5 flex flex-wrap gap-2"><Link href={job.source === "import" ? `/playground?mode=reproduce&study=${job.experimentId}` : `/playground?mode=reproduce&job=${job.id}`} className="inline-flex h-10 items-center bg-emerald-700 px-5 text-sm font-semibold text-white hover:bg-emerald-600">Ship to playground</Link>{job.source !== "import" && <><button disabled={busy} onClick={reopenReview} className="h-10 border border-gray-300 bg-white px-5 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:text-gray-400">{busy ? "Opening..." : "Reopen review"}</button><a href={`/api/pipeline/jobs/${job.id}/download`} className="inline-flex h-10 items-center bg-cyan-700 px-5 text-sm font-semibold text-white hover:bg-cyan-600">Download experiment ZIP</a><button disabled={busy || Boolean(prUrl)} onClick={publish} className="h-10 border border-gray-300 bg-white px-5 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:text-gray-400">{busy ? "Saving..." : prUrl ? "Contributed to benchmark" : "Contribute this study to benchmark"}</button></>}</div>{prUrl && <a href={prUrl} target="_blank" rel="noreferrer" className="mt-4 block text-sm font-semibold text-cyan-700 hover:underline">Open pull request</a>}</> : <div className="border-l-2 border-cyan-700 bg-cyan-50 p-4 text-sm leading-6 text-cyan-950">The extraction is saved, but the study is not yet a runnable package.</div>}
            </div>
          )}

          {error && <p className="mx-6 mb-6 border-l-2 border-red-600 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        </section>
      </main>
    </div>
  );
}
