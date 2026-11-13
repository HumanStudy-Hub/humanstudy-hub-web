import ReadingContents from "./ReadingContents";
import reading from "./published-reading.module.css";
import { publishedAssetUrl } from "@/lib/published-program";
import type { ResearchPaper } from "@/lib/research";
import { programText, type JsonValue, type HumanProgram, type ProgramNode, type ProgramField, type ProgramStep } from "@/lib/studio/human-program";

function sourceUrl(url?: string) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.href : null;
  } catch {
    return null;
  }
}

function sourceObject(value?: JsonValue) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function reuseLink(value?: JsonValue) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function reuseSources(extensions: HumanProgram["extensions"]) {
  const sources = new Map<string, {
    url: string | null; title: string; attribution: string; license: string; licenseUrl: string | null; changes: string;
  }>();
  const value = (field?: JsonValue) => typeof field === "string" ? field.trim() : "";
  for (const section of [extensions?.publication, extensions?.communityExport]) {
    const entries = sourceObject(section)?.sources;
    if (!Array.isArray(entries)) continue;
    for (const raw of entries) {
      const entry = sourceObject(raw);
      if (!entry) continue;
      const url = reuseLink(entry.url);
      const title = value(entry.title);
      const attribution = value(entry.attribution) || value(entry.authors);
      const license = value(entry.license);
      const licenseUrl = reuseLink(entry.licenseUrl);
      const changes = value(entry.changes);
      if (!url && !attribution && !license && !licenseUrl && !changes) continue;
      const key = url ?? JSON.stringify([title, attribution, license, licenseUrl, changes]);
      const previous = sources.get(key);
      sources.set(key, {
        url,
        title: title || previous?.title || "",
        attribution: attribution || previous?.attribution || "",
        license: license || previous?.license || "",
        licenseUrl: licenseUrl || previous?.licenseUrl || null,
        changes: changes || previous?.changes || "",
      });
    }
  }
  return [...sources.values()];
}

const overviewGroups = [
  { title: "Research question and motivation", kinds: ["background", "question", "research-question", "motivation"] },
  { title: "Paper summary", kinds: ["overview"] },
  { title: "Hypotheses", kinds: ["hypothesis"] },
  { title: "Main findings", kinds: ["finding"] },
];

const detailGroups = [
  { title: "Design and conditions", kinds: ["design", "participants", "condition"] },
  { title: "Materials and procedure", kinds: ["material", "procedure"] },
  { title: "Variables and analysis", kinds: ["variable", "record", "analysis"] },
  { title: "Reported results", kinds: ["result"] },
  { title: "Limitations", kinds: ["limitation"] },
];

export default function PublishedProgram({ paper, program }: { paper: ResearchPaper; program: HumanProgram }) {
  const evidence = new Map(program.evidence.map(item => [item.id, item]));
  const studiesById = new Map(program.studies.map(study => [study.id, study]));
  const overviewKinds = new Set(overviewGroups.flatMap(group => group.kinds));
  const studyNames = (ids: string[]) => ids.map(id => studiesById.get(id)?.title ?? id).join(", ");
  const nodesFor = (studyId: string | null) => program.nodes.flatMap(node => {
    const matches = (ids: string[]) => studyId === null ? ids.length !== 1 : ids.length === 1 && ids[0] === studyId;
    const fields = node.fields.filter(field => matches(field.studyIds?.length ? field.studyIds : node.studyIds));
    const nodeHere = matches(node.studyIds);
    if (!fields.length && !(nodeHere && (!node.fields.length || node.summary || node.description))) return [];
    return [{ ...node, fields, summary: nodeHere ? node.summary : undefined, description: nodeHere ? node.description : undefined }];
  });
  const stepsById = new Map(program.steps.map(step => [step.id, step]));
  const nodesById = new Map(program.nodes.map(node => [node.id, node]));
  const nodeNames = (ids: string[]) => ids.map(id => nodesById.get(id)?.title ?? id).join(", ");
  const paperNodes = nodesFor(null);
  const renderEvidence = (ids: string[]) => {
    const sources = [...new Set(ids)].flatMap(id => {
      const item = evidence.get(id);
      return item ? [item] : [];
    });
    return sources.length > 0 && <details className="mt-1 text-sm">
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
    </details>;
  };
  const renderField = (field: ProgramField, fallbackEvidence: string[], showLabel = true, scope?: string) =>
    <div key={field.id} className="mt-2 text-sm leading-relaxed">
      {showLabel && <p className="font-medium">{field.label}</p>}
      {scope && <p className="text-[var(--site-muted)]">Applies to {scope}</p>}
      {field.value !== null && <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{programText(field.value)}</p>}
      {field.state === "missing" && <p className="text-[var(--site-muted)]">{field.extensions?.gapReason === "source_unavailable" ? "Source needed" : "Not reported in the available source"}</p>}
      {field.origin === "derived" && field.derivation && <p className="text-[var(--site-muted)]">Interpretation · {field.derivation}</p>}
      {renderEvidence(field.evidenceIds.length ? field.evidenceIds : fallbackEvidence)}
    </div>;

  const renderNode = (node: ProgramNode, showScope: boolean) => {
    const sharedScope = showScope && node.studyIds.length > 1
      && (!node.fields.length || node.summary || node.description || node.fields.every(field => !field.studyIds?.length));
    const fieldSourceIds = new Set(node.fields.flatMap(field => field.evidenceIds.length ? field.evidenceIds : node.evidenceIds));
    const noteSourceIds = node.evidenceIds.filter(id => !fieldSourceIds.has(id));
    return <section key={node.id} className="mt-3">
      <h5 className="text-sm font-semibold">{node.title}</h5>
      {sharedScope && <p className="text-sm text-[var(--site-muted)]">Applies to {studyNames(node.studyIds)}</p>}
      {node.summary && <p className="mt-1 text-sm">{node.summary}</p>}
      {node.description && node.description !== node.summary && <p className="mt-1 whitespace-pre-wrap text-sm">{node.description}</p>}
      {node.fields.map(field => {
        const ids = field.studyIds?.length ? field.studyIds : node.studyIds;
        return renderField(field, node.evidenceIds, node.fields.length !== 1 || field.label.trim() !== node.title.trim(),
          showScope && ids.length > 1 && (!sharedScope || field.studyIds?.length) ? studyNames(ids) : undefined);
      })}
      {renderEvidence(noteSourceIds)}
    </section>;
  };
  const renderOverview = (nodes: ProgramNode[], showScope = false) => overviewGroups.map((group, index) => {
    const entries = nodes.filter(node => group.kinds.includes(node.kind));
    return entries.length > 0 && <div key={group.title} id={showScope ? `paper-overview-${index}` : undefined} tabIndex={showScope ? -1 : undefined} className="mt-4 scroll-mt-24">
      <h4 className="font-semibold">{group.title}</h4>
      {entries.map(node => renderNode(node, showScope))}
    </div>;
  });
  const renderGroups = (nodes: ProgramNode[], showScope = false) => {
    const details = nodes.filter(node => !overviewKinds.has(node.kind));
    const other = details.filter(node => !detailGroups.some(group => group.kinds.includes(node.kind)));
    return [
      ...detailGroups.map(group => ({ title: group.title, entries: details.filter(node => group.kinds.includes(node.kind)) })),
      { title: "Additional notes", entries: other },
    ].map(({ title, entries }) => entries.length > 0 &&
      <details key={title} className="mt-3">
        <summary className="cursor-pointer font-medium">{title}</summary>
        {entries.map(node => renderNode(node, showScope))}
      </details>);
  };
  const renderSteps = (steps: ProgramStep[]) => steps.length > 0 && <details className="mt-3">
    <summary className="cursor-pointer font-medium">Experiment flow</summary>
    <ul className="mt-3 list-disc space-y-3 pl-5 text-sm">
      {steps.map(step => <li key={step.id}>
        <strong>{step.title}</strong>
        {step.conditionIds?.length ? <p>Conditions · {nodeNames(step.conditionIds)}</p> : null}
        {step.actorIds.length > 0 && <p>Actors · {nodeNames(step.actorIds)}</p>}
        {step.inputIds.length > 0 && <p>Inputs · {nodeNames(step.inputIds)}</p>}
        {step.outputIds.length > 0 && <p>Outputs · {nodeNames(step.outputIds)}</p>}
        {step.visibleIds.length > 0 && <p>Visible information · {nodeNames(step.visibleIds)}</p>}
        {step.children.length > 0 && <p>Contains · {step.children.map(id => stepsById.get(id)?.title ?? id).join(", ")}</p>}
        {step.next.map(edge => <p key={edge.to}>Next · {stepsById.get(edge.to)?.title ?? edge.to}{edge.when && ` (${edge.when})`}</p>)}
        {step.rule && renderField(step.rule, [])}
        {renderEvidence(step.evidenceIds)}
      </li>)}
    </ul>
  </details>;

  const overviewLinks = overviewGroups.flatMap((group, index) =>
    paperNodes.some(node => group.kinds.includes(node.kind))
      ? [{ id: `paper-overview-${index}`, title: group.title }] : []);
  const credits = reuseSources(program.extensions);
  const experimentLinks = program.studies.map((study, index) => ({ id: `paper-experiment-${index}`, title: study.title }));
  return <section id="paper-program" className={`mt-9 scroll-mt-24 border-t border-[var(--site-line)] pt-6 ${reading.layout}`}>
    <ReadingContents overview={overviewLinks} experiments={experimentLinks} />
    <div className={reading.body}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2>Human Study Program</h2>
        <a href="#run-experiment" className="text-sm text-[var(--site-accent)] underline">Run experiment</a>
      </div>
      {paperNodes.some(node => overviewKinds.has(node.kind)) && <section className="mt-6">
        <h3 className="font-serif text-lg font-semibold">Overview</h3>
        {renderOverview(paperNodes, true)}
      </section>}
      {program.studies.length > 0 && <section className="mt-7">
        <h3 className="font-semibold">Experiments and analyses</h3>
        {program.studies.map((study, index) => {
          const nodes = nodesFor(study.id);
          return <details id={experimentLinks[index].id} key={study.id} className="mt-2 scroll-mt-24 border-b border-[var(--site-line)] py-2" open={program.studies.length === 1}>
            <summary className="cursor-pointer font-medium">{study.title}</summary>
            {study.description && <p className="mt-2 text-sm leading-relaxed">{study.description}</p>}
            {renderOverview(nodes)}
            {renderSteps(program.steps.filter(step => step.studyId === study.id))}
            {renderGroups(nodes)}
          </details>;
        })}
      </section>}
      {paperNodes.some(node => !overviewKinds.has(node.kind)) && <section className="mt-7">
        <h3 className="font-semibold">Details across the paper</h3>
        {renderGroups(paperNodes, true)}
      </section>}
      {credits.length > 0 && <section className="mt-7 border-t border-[var(--site-line)] pt-4">
        <h3>Sources and reuse</h3>
        <ul className="mt-2 space-y-3 text-sm leading-relaxed [overflow-wrap:anywhere]">
          {credits.map((source, index) => <li key={source.url ?? index}>
            {source.url ? <a className="font-medium text-[var(--site-accent)] underline" href={source.url} target="_blank" rel="noreferrer">
              {source.title || "Original source"} ↗
            </a> : source.title && <p className="font-medium">{source.title}</p>}
            {source.attribution && <p>{source.attribution}</p>}
            {source.licenseUrl ? <a className="text-[var(--site-accent)] underline" href={source.licenseUrl} target="_blank" rel="noreferrer">
              {source.license || "Reuse terms"} ↗
            </a> : source.license && <p>{source.license}</p>}
            {source.changes && <p className="text-[var(--site-muted)]">{source.changes}</p>}
          </li>)}
        </ul>
      </section>}
    </div>
  </section>;
}
