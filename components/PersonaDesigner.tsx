"use client";

import { useMemo, useRef, useState } from "react";
import {
  blankGroup,
  describeMix,
  MAX_SEGMENTS,
  normaliseGroup,
  summariseSegment,
  type PersonaGroup,
  type PersonaSegment,
} from "@/lib/persona-groups";

type ChatTurn = { role: "user" | "assistant"; content: string };

const EXAMPLES = [
  "Half hospital nurses in their thirties and forties, half undergraduates.",
  "A nationally representative adult sample: age 18 to 75, balanced gender.",
  "Three groups of equal size: first-year students, final-year students, and their professors.",
];

function ageText(segment: PersonaSegment) {
  if (!segment.age) return "";
  return segment.age.min === segment.age.max ? String(segment.age.min) : `${segment.age.min}-${segment.age.max}`;
}

function parseAge(value: string): PersonaSegment["age"] {
  const cleaned = value.trim();
  if (!cleaned) return null;
  const range = cleaned.match(/^(\d{1,3})\s*[-–—to]+\s*(\d{1,3})$/i);
  if (range) return { min: Number(range[1]), max: Number(range[2]) };
  const single = cleaned.match(/^(\d{1,3})$/);
  return single ? { min: Number(single[1]), max: Number(single[1]) } : null;
}

function genderText(segment: PersonaSegment) {
  if (!segment.gender) return "";
  const entries = Object.entries(segment.gender);
  if (entries.length === 1) return entries[0][0];
  return entries.map(([name, weight]) => `${name} ${Math.round(weight * 100)}`).join(", ");
}

function parseGender(value: string): PersonaSegment["gender"] {
  const cleaned = value.trim();
  if (!cleaned) return null;
  if (!cleaned.includes(",") && !/\d/.test(cleaned)) return { [cleaned]: 1 };
  const weights: Record<string, number> = {};
  for (const part of cleaned.split(",")) {
    const match = part.trim().match(/^(.+?)\s+(\d+(?:\.\d+)?)%?$/);
    if (match) weights[match[1].trim()] = Number(match[2]);
  }
  return Object.keys(weights).length > 0 ? weights : { [cleaned]: 1 };
}

export default function PersonaDesigner({
  studyId,
  studyTitle,
  participants,
  group,
  onChange,
}: {
  studyId: string;
  studyTitle: string;
  participants: number;
  group: PersonaGroup | null;
  onChange: (group: PersonaGroup | null) => void;
}) {
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [contributor, setContributor] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  // Studies decide their own participant count from their design, so the preview
  // falls back to proportions when the run size is not known yet.
  const mix = useMemo(() => (group ? describeMix(group, participants > 0 ? participants : 100) : []), [group, participants]);

  function update(next: Partial<PersonaGroup>) {
    if (!group) return;
    try {
      onChange(normaliseGroup({ ...group, ...next }));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That change cannot be applied.");
    }
  }

  function updateSegment(index: number, patch: Partial<PersonaSegment>) {
    if (!group) return;
    update({ segments: group.segments.map((segment, at) => (at === index ? { ...segment, ...patch } : segment)) });
  }

  async function send(message: string) {
    const text = message.trim();
    if (!text || busy) return;
    const history: ChatTurn[] = [...chat, { role: "user", content: text }];
    setChat(history);
    setDraft("");
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/playground/personas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history, group, studyId, studyTitle, participants }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "The persona designer failed.");
      onChange(normaliseGroup(data.group));
      setChat([...history, { role: "assistant", content: data.reply }]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The persona designer failed.");
      setChat(history);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (!group) return;
    const blob = new Blob([`${JSON.stringify(group, null, 2)}\n`], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(group.name || "personas").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function load(file?: File) {
    if (!file) return;
    try {
      onChange(normaliseGroup(JSON.parse(await file.text())));
      setError("");
      setChat([]);
    } catch (caught) {
      setError(caught instanceof Error ? `That file is not a usable persona group: ${caught.message}` : "That file could not be read.");
    }
  }

  async function contribute() {
    if (!group) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/playground/personas/contribute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group, studyId, contributor }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not contribute this group.");
      setPrUrl(data.prUrl);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not contribute this group.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4 border border-gray-200 bg-gray-50">
      <div className="border-b border-gray-200 bg-white px-4 py-3">
        <p className="text-sm font-semibold text-gray-950">Persona designer</p>
        <p className="mt-1 text-xs leading-5 text-gray-500">
          Describe the people you want and the designer writes the group, or build it by hand below. A group describes
          a population, so the same one fits a run of any size.
        </p>
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex min-h-[22rem] flex-col border border-gray-200 bg-white">
          <div className="flex-1 space-y-3 overflow-auto p-3">
            {chat.length === 0 && (
              <div className="text-xs leading-5 text-gray-500">
                <p className="font-semibold text-gray-700">Try describing your participants:</p>
                <ul className="mt-2 space-y-2">
                  {EXAMPLES.map((example) => (
                    <li key={example}>
                      <button type="button" onClick={() => send(example)} className="text-left text-cyan-700 hover:underline">“{example}”</button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {chat.map((turn, index) => (
              <div key={index} className={turn.role === "user" ? "ml-6 bg-cyan-50 p-3" : "mr-6 bg-gray-50 p-3"}>
                <p className="text-[10px] font-bold uppercase text-gray-500">{turn.role === "user" ? "You" : "Designer"}</p>
                <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-gray-800">{turn.content}</p>
              </div>
            ))}
            {busy && <p className="text-xs text-gray-500">Working…</p>}
          </div>
          <div className="border-t border-gray-200 p-2">
            <div className="flex gap-2">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(draft); } }}
                placeholder="Half nurses in their forties, half students…"
                className="h-9 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700"
              />
              <button type="button" disabled={busy || !draft.trim()} onClick={() => send(draft)} className="h-9 shrink-0 bg-cyan-700 px-4 text-xs font-semibold text-white hover:bg-cyan-600 disabled:bg-gray-300">Send</button>
            </div>
          </div>
        </div>

        <div className="space-y-3">
          {!group ? (
            <div className="border border-dashed border-gray-300 bg-white p-6 text-center">
              <p className="text-sm text-gray-600">No persona group yet.</p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <button type="button" onClick={() => onChange(blankGroup(studyId))} className="h-9 border border-gray-300 bg-white px-4 text-xs font-semibold text-gray-700 hover:border-cyan-700">Build one by hand</button>
                <button type="button" onClick={() => fileInput.current?.click()} className="h-9 border border-gray-300 bg-white px-4 text-xs font-semibold text-gray-700 hover:border-cyan-700">Load a saved group</button>
              </div>
            </div>
          ) : (
            <>
              <div className="border border-gray-200 bg-white p-3">
                <label className="block text-xs font-semibold text-gray-700" htmlFor="group-name">Group name</label>
                <input id="group-name" value={group.name} onChange={(event) => update({ name: event.target.value })} className="mt-1 h-9 w-full border border-gray-300 px-3 text-sm outline-none focus:border-cyan-700" />
                <p className="mt-3 text-xs font-semibold text-gray-700">The mix</p>
                <div className="mt-2 flex h-3 overflow-hidden">
                  {mix.map((entry, index) => (
                    <div key={entry.id} title={`${entry.label}: ${Math.round(entry.share * 100)}%`} style={{ width: `${entry.share * 100}%`, backgroundColor: ["#0e7490", "#0891b2", "#22d3ee", "#a5e5ea", "#334155", "#64748b"][index % 6] }} />
                  ))}
                </div>
                <ul className="mt-2 space-y-1">
                  {mix.map((entry) => (
                    <li key={entry.id} className="flex justify-between text-[11px] text-gray-600">
                      <span>{entry.label}</span>
                      <span className="font-mono">{Math.round(entry.share * 100)}%{participants > 0 ? ` · ${entry.count}` : ""}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11px] leading-4 text-gray-500">
                  {participants > 0
                    ? `Shown for ${participants} participants.`
                    : "How many participants a study creates depends on its design, so the exact counts are assigned when the run starts, in proportion to these shares."}
                </p>
              </div>

              {group.segments.map((segment, index) => (
                <details key={segment.id} className="border border-gray-200 bg-white" open={group.segments.length <= 2}>
                  <summary className="cursor-pointer px-3 py-2">
                    <span className="text-sm font-semibold text-gray-900">{segment.label}</span>
                    <span className="ml-2 text-[11px] text-gray-500">{summariseSegment(segment)}</span>
                  </summary>
                  <div className="grid gap-3 border-t border-gray-100 p-3 sm:grid-cols-2">
                    <div>
                      <label className="block text-[11px] font-semibold text-gray-600">Label</label>
                      <input value={segment.label} onChange={(event) => updateSegment(index, { label: event.target.value })} className="mt-1 h-8 w-full border border-gray-300 px-2 text-xs outline-none focus:border-cyan-700" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-gray-600">Share of participants</label>
                      <input type="number" min={1} max={100} value={Math.round(segment.share * 100)} onChange={(event) => updateSegment(index, { share: Math.max(1, Number(event.target.value) || 1) })} className="mt-1 h-8 w-full border border-gray-300 px-2 text-xs outline-none focus:border-cyan-700" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-gray-600">Age or age range</label>
                      <input defaultValue={ageText(segment)} onBlur={(event) => updateSegment(index, { age: parseAge(event.target.value) })} placeholder="28-55" className="mt-1 h-8 w-full border border-gray-300 px-2 text-xs outline-none focus:border-cyan-700" />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-gray-600">Gender or split</label>
                      <input defaultValue={genderText(segment)} onBlur={(event) => updateSegment(index, { gender: parseGender(event.target.value) })} placeholder="female 80, male 20" className="mt-1 h-8 w-full border border-gray-300 px-2 text-xs outline-none focus:border-cyan-700" />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-[11px] font-semibold text-gray-600">Background</label>
                      <input value={segment.background || ""} onChange={(event) => updateSegment(index, { background: event.target.value || null })} placeholder="works night shifts in an emergency department" className="mt-1 h-8 w-full border border-gray-300 px-2 text-xs outline-none focus:border-cyan-700" />
                    </div>
                    <div className="sm:col-span-2">
                      <label className="block text-[11px] font-semibold text-gray-600">What the agent is told it is</label>
                      <textarea value={segment.persona || ""} onChange={(event) => updateSegment(index, { persona: event.target.value || null })} rows={2} placeholder="You are a hospital nurse with twelve years on an emergency ward." className="mt-1 w-full border border-gray-300 p-2 text-xs outline-none focus:border-cyan-700" />
                    </div>
                    {group.segments.length > 1 && (
                      <div className="sm:col-span-2 flex justify-end">
                        <button type="button" onClick={() => update({ segments: group.segments.filter((_, at) => at !== index) })} className="text-[11px] font-semibold text-red-700 hover:underline">Remove this segment</button>
                      </div>
                    )}
                  </div>
                </details>
              ))}

              <div className="flex flex-wrap gap-2">
                {group.segments.length < MAX_SEGMENTS && (
                  <button type="button" onClick={() => update({ segments: [...group.segments, { id: `group_${group.segments.length + 1}`, label: `Group ${group.segments.length + 1}`, share: 1 / group.segments.length, age: null, gender: null, education: null, background: null, persona: null }] })} className="h-9 border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:border-cyan-700">Add a segment</button>
                )}
                <button type="button" onClick={download} className="h-9 border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:border-cyan-700">Download JSON</button>
                <button type="button" onClick={() => fileInput.current?.click()} className="h-9 border border-gray-300 bg-white px-3 text-xs font-semibold text-gray-700 hover:border-cyan-700">Load a saved group</button>
                <button type="button" onClick={() => { onChange(null); setChat([]); }} className="h-9 px-3 text-xs font-semibold text-gray-500 hover:text-gray-800">Clear</button>
              </div>

              <div className="border border-cyan-200 bg-cyan-50 p-3">
                <p className="text-xs font-semibold text-cyan-950">Keep this group in the benchmark</p>
                <p className="mt-1 text-[11px] leading-5 text-cyan-900">
                  Contributing opens a pull request adding it to the shared library, credited to you, so you and others
                  can reuse it. It is saved as {`${studyId}-<your name>-<n>`}, and the number rises each time you save
                  another, so nothing you saved before is replaced.
                </p>
                {prUrl ? (
                  <a href={prUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-semibold text-cyan-800 hover:underline">Open the pull request →</a>
                ) : (
                  <div className="mt-2 flex gap-2">
                    <input value={contributor} onChange={(event) => setContributor(event.target.value)} placeholder="Your name" className="h-8 w-full border border-cyan-300 px-2 text-xs outline-none focus:border-cyan-700" />
                    <button type="button" disabled={busy || !contributor.trim()} onClick={contribute} className="h-8 shrink-0 bg-cyan-700 px-3 text-xs font-semibold text-white hover:bg-cyan-600 disabled:bg-gray-300">Contribute</button>
                  </div>
                )}
              </div>
            </>
          )}
          <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" onChange={(event) => load(event.target.files?.[0])} />
        </div>
      </div>

      {error && <p className="mx-4 mb-4 border-l-2 border-red-600 bg-red-50 p-3 text-xs text-red-800">{error}</p>}
    </div>
  );
}
