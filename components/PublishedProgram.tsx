import { publishedAssetUrl } from "@/lib/published-program";
import type { ResearchPaper } from "@/lib/research";
import { programText, type HumanProgram, type ProgramNode } from "@/lib/studio/human-program";

function sourceUrl(url?: string) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : null;
  } catch {
    return null;
  }
}

export default function PublishedProgram({ paper, program }: { paper: ResearchPaper; program: HumanProgram }) {
  const evidence = new Map(program.evidence.map(item => [item.id, item]));
  const paperScope = (ids: string[]) => !ids.length || program.studies.every(study => ids.includes(study.id));
  const overview = program.nodes.filter(node => ["background", "finding"].includes(node.kind) && paperScope(node.studyIds)
    && node.fields.every(field => !field.studyIds?.length || paperScope(field.studyIds)));
  const remaining = program.nodes.filter(node => !overview.includes(node));
  const nodesFor = (studyId: string | null) => remaining.flatMap(node => {
    const fields = node.fields.filter(field => {
      const ids = field.studyIds?.length ? field.studyIds : node.studyIds;
      return studyId ? ids.includes(studyId) : ids.length === 0;
    });
    return fields.length ? [{ ...node, fields }] : [];
  });

  const renderNode = (node: ProgramNode) => (
    <section key={node.id} className="mt-5">
      <h3 className="text-base font-semibold">{node.title}</h3>
      {node.fields.map(field => {
        const sources = [...new Set(field.evidenceIds.length ? field.evidenceIds : node.evidenceIds)]
          .flatMap(id => {
            const item = evidence.get(id);
            return item ? [item] : [];
          });
        return <div key={field.id} className="mt-3 text-sm leading-relaxed">
          <p className="font-medium">{field.label}</p>
          {field.value !== null && <p className="whitespace-pre-wrap">{programText(field.value)}</p>}
          {field.state === "missing" && <p className="text-[var(--site-muted)]">{field.extensions?.gapReason === "source_unavailable" ? "Source needed" : "Not reported in the available source"}</p>}
          {field.origin === "derived" && field.derivation && <p className="text-[var(--site-muted)]">Interpretation · {field.derivation}</p>}
          {sources.length > 0 && <details className="mt-1">
            <summary className="cursor-pointer text-[var(--site-accent)]">Source evidence ({sources.length})</summary>
            <ul className="mt-2 space-y-2">
              {sources.map(item => {
                const file = item.path ? publishedAssetUrl(paper, item.path) : null;
                const url = sourceUrl(item.url) ?? (file && item.locator.page ? `${file}#page=${item.locator.page}` : file);
                const location = item.locator.page ? `Page ${item.locator.page}` : item.locator.pointer || item.locator.cell || "Original source";
                return <li key={item.id}>
                  {url ? <a className="underline" href={url} target="_blank" rel="noreferrer">{location} ↗</a> : <span>{location}</span>}
                  {item.quote && <blockquote className="mt-1 border-l-2 border-[var(--site-line)] pl-3">{item.quote}</blockquote>}
                </li>;
              })}
            </ul>
          </details>}
        </div>;
      })}
    </section>
  );
  const renderGroups = (nodes: ProgramNode[]) => {
    const results = nodes.filter(node => node.kind === "result");
    const details = nodes.filter(node => node.kind !== "result");
    return <>
      {results.length > 0 && <details className="mt-3"><summary className="cursor-pointer">Reported results</summary>{results.map(renderNode)}</details>}
      {details.length > 0 && <details className="mt-3"><summary className="cursor-pointer">Study details</summary>{details.map(renderNode)}</details>}
    </>;
  };
  return <section className="mt-9 border-t border-[var(--site-line)] pt-6">
    <h2 className="text-xl font-semibold font-serif">Human Program</h2>
    {overview.map(renderNode)}
    {program.studies.length > 0 && <section className="mt-7">
      <h3 className="font-semibold">Experiments and analyses</h3>
      {program.studies.map(study => <details key={study.id} className="mt-2 border-b border-[var(--site-line)] py-2">
        <summary className="cursor-pointer font-medium">{study.title}</summary>
        {study.description && <p className="mt-2 text-sm leading-relaxed">{study.description}</p>}
        {renderGroups(nodesFor(study.id))}
      </details>)}
    </section>}
    {renderGroups(nodesFor(null))}
  </section>;
}
