"use client";

import { useMemo, useState } from "react";
import PipelineStudio, { type PreparedReviewStudy, type ReviewFile } from "@/components/PipelineStudio";

type Study = {
  study_id: string;
  title: string;
  authors: string[];
  year: number | null;
};

export default function UsabilityTestStudio({ studies }: { studies: Study[] }) {
  const [studyId, setStudyId] = useState("");
  const [preparedStudy, setPreparedStudy] = useState<PreparedReviewStudy | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const study = useMemo(() => studies.find((entry) => entry.study_id === studyId), [studies, studyId]);

  async function openPreparedStudy() {
    if (!study) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/usability-test/studies/${study.study_id}`, { cache: "no-store" });
      const data = await response.json() as { files?: ReviewFile[]; error?: string };
      if (!response.ok || !data.files) throw new Error(data.error || "Could not load the prepared study.");
      setPreparedStudy({ studyId: study.study_id, title: study.title, files: data.files });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the prepared study.");
    } finally {
      setLoading(false);
    }
  }

  if (preparedStudy) {
    // This is the production Build Study component itself, initialized directly
    // at its Human Review state with the extraction that was prepared in advance.
    return <PipelineStudio preparedStudy={preparedStudy} />;
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#f7f9fa]">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-6xl px-5 py-9 sm:px-8">
          <p className="text-xs font-semibold uppercase tracking-wide text-cyan-700">Research session</p>
          <h1 className="mt-2 font-serif text-3xl font-bold text-gray-950">Usability Test</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600">Choose the paper assigned for this session. Its completed extraction will open directly in the regular Build Study Human Review.</p>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-5 py-8 sm:px-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section className="border border-gray-200 bg-white p-6 shadow-sm">
          <p className="text-sm font-semibold text-gray-950">Select the assigned paper</p>
          <p className="mt-1 text-sm leading-6 text-gray-500">Only the extraction wait is skipped. Human Review and Playground use the regular platform interfaces.</p>

          <label htmlFor="usability-paper" className="mt-6 block text-xs font-semibold uppercase tracking-wide text-gray-500">Assigned paper</label>
          <select id="usability-paper" value={studyId} onChange={(event) => setStudyId(event.target.value)} className="mt-2 w-full border border-gray-300 bg-white px-3 py-3 text-sm outline-none focus:border-cyan-700">
            <option value="">Choose one of the 12 benchmark papers</option>
            {studies.map((entry) => <option key={entry.study_id} value={entry.study_id}>{entry.study_id.replace("study_", "Study ")} — {entry.title}</option>)}
          </select>

          {study && (
            <div className="mt-4 border-l-2 border-cyan-700 bg-cyan-50 p-4">
              <p className="font-serif text-lg font-bold text-gray-950">{study.title}</p>
              <p className="mt-1 text-xs text-gray-600">{study.authors.join(", ")}{study.year ? ` · ${study.year}` : ""}</p>
            </div>
          )}
          {error && <p className="mt-4 border-l-2 border-red-600 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
          <div className="mt-6 flex justify-end border-t border-gray-100 pt-5">
            <button type="button" disabled={!study || loading} onClick={openPreparedStudy} className="h-10 bg-cyan-700 px-5 text-sm font-semibold text-white hover:bg-cyan-600 disabled:bg-gray-300">{loading ? "Loading prepared extraction…" : "Continue to Human Review"}</button>
          </div>
        </section>

        <aside className="space-y-5">
          <section className="border border-emerald-200 bg-emerald-50 p-5">
            <p className="text-sm font-semibold text-emerald-950">Prepared before the interview</p>
            <ul className="mt-3 space-y-2 text-xs leading-5 text-emerald-900">
              <li>✓ Paper extraction</li>
              <li>✓ Study structure</li>
              <li>✓ Published findings</li>
            </ul>
          </section>
          <section className="border border-gray-200 bg-white p-5">
            <p className="text-sm font-semibold text-gray-950">Participant workflow</p>
            <ol className="mt-3 space-y-3 text-xs leading-5 text-gray-600">
              <li><strong className="text-gray-900">1.</strong> Choose the assigned paper</li>
              <li><strong className="text-gray-900">2.</strong> Complete the regular Human Review</li>
              <li><strong className="text-gray-900">3.</strong> Continue to the regular Playground</li>
            </ol>
          </section>
        </aside>
      </main>
    </div>
  );
}
