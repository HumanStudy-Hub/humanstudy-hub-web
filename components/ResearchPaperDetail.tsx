import Link from "next/link";
import type { ResearchPaper } from "@/lib/research";

const label: Record<string, string> = { "original-data-link": "Original data", "transcription-code": "Transcription code", "metadata": "Source reference", "claim-metadata": "Claim and analysis metadata" };
const safeUrl = (value?: string) => { try { const url = new URL(value || ""); return url.protocol === "https:" && !url.username && !url.password ? url.href : null; } catch { return null; } };

export default function ResearchPaperDetail({ paper }: { paper: ResearchPaper }) {
  // Catalog documents from different sources omit empty lists.
  const authors = paper.authors ?? [], resources = paper.resources ?? [];
  const repository = paper.assetRoot && /^(studies\/study_\d+|community\/[A-Za-z0-9_.-]+\/revisions\/[a-f0-9]{64})$/.test(paper.assetRoot)
    ? `https://github.com/HumanStudy-Hub/HumanStudy-Bench/tree/main/${paper.assetRoot}` : null;
  return <div className="bg-white min-h-screen border-t border-gray-100">
    <div className="mx-auto max-w-4xl px-6 py-12 lg:px-8">
      <Link href="/studies" className="text-sm text-cyan-700">← Research library</Link>
      <h1 className="mt-8 text-3xl font-bold font-serif text-gray-900">{paper.title}</h1>
      <p className="mt-3 text-sm text-gray-500">{[authors.join(", "), paper.year].filter(Boolean).join(" · ")}</p>
      <p className="mt-6 whitespace-pre-wrap leading-7 text-gray-700">{paper.description}</p>
      <p className="mt-6 text-sm text-gray-600">{paper.currentRevision ? "The recommended Human Program is available in the desktop research library." : paper.legacyStudyId ? "Study materials are available. Source coverage and execution need to be checked for your research." : "This source is indexed. Its full Human Program and interactive execution have not been validated yet."}</p>
      <div className="mt-6 flex gap-4 text-sm text-cyan-700">
        <Link href="/build">HumanStudy desktop</Link>
        {repository && <a href={repository} target="_blank" rel="noopener noreferrer">Research files ↗</a>}
      </div>
      {resources.length > 0 && <section className="mt-10">
        <h2 className="text-lg font-semibold font-serif">Sources</h2>
        <ul className="mt-3 space-y-3 text-sm">
          {resources.map((resource, i) => {
            const url = safeUrl(resource.url);
            return <li key={`${resource.id}-${i}`}>
              {url ? <a href={url} target="_blank" rel="noopener noreferrer" className="text-cyan-700 underline">{label[resource.kind] || resource.kind} ↗</a> : <span>{label[resource.kind] || resource.kind}</span>}
              <span className="ml-2 text-gray-500">{resource.access === "unverified" ? "Availability not checked" : resource.access}</span>
            </li>;
          })}
        </ul>
      </section>}
    </div>
  </div>;
}
