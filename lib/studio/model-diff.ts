import type { StudySchema } from "@/app/build-preview/study-schema";

export type ModelSection = "study" | "entities" | "relations" | "procedure" | "variables" | "reviewIssues" | "program";
export type EntityChange = { id: string; kind: "added" | "removed" | "changed"; title: string; details: string[] };
export type ModelChanges = {
  hasChanges: boolean;
  changedEntityIds: string[];
  addedEntityIds: string[];
  removedEntityIds: string[];
  entities: EntityChange[];
  sections: ModelSection[];
  details: string[];
};

const clean = (value: unknown): unknown => {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, clean(item)]));
  return value;
};
const same = (a: unknown, b: unknown) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));
const evidence = (value: { sourceId?: string; page: number; quote: string }) => ({ sourceId: value.sourceId, page: value.page, quote: value.quote });
const byId = <T extends { id: string }>(items: T[]) => new Map(items.map(item => [item.id, item]));

/** Compare the scientific content of two models, excluding visual layout and evidence rectangles. */
export function modelChanges(before: StudySchema, after: StudySchema): ModelChanges {
  const changed = new Map<string, EntityChange>();
  const sections = new Set<ModelSection>();
  const details: string[] = [];
  // Typed values and extension data are scientific content even when their card summaries match.
  if(JSON.stringify(before.program)!==JSON.stringify(after.program)){sections.add("program");details.push("Human Program data changed");}
  const oldEntities = byId(before.entities), newEntities = byId(after.entities);
  const mark = (id: string, detail: string) => {
    const entity = newEntities.get(id) ?? oldEntities.get(id);
    if (!entity) return;
    const existing = changed.get(id);
    if (existing) { if (!existing.details.includes(detail)) existing.details.push(detail); return; }
    changed.set(id, { id, kind: oldEntities.has(id) ? newEntities.has(id) ? "changed" : "removed" : "added", title: entity.title, details: [detail] });
  };
  if(before.program||after.program){
    const oldNodes=byId(before.program?.nodes??[]),newNodes=byId(after.program?.nodes??[]);
    for(const id of new Set([...oldNodes.keys(),...newNodes.keys()]))if(JSON.stringify(oldNodes.get(id))!==JSON.stringify(newNodes.get(id)))mark(id,"Typed research data changed");
    const oldFlow=byId(before.program?.steps??[]),newFlow=byId(after.program?.steps??[]);
    for(const id of new Set([...oldFlow.keys(),...newFlow.keys()]))if(JSON.stringify(oldFlow.get(id))!==JSON.stringify(newFlow.get(id)))mark(`flow:${id}`,"Procedure rule or references changed");
  }
  if (!same({ title: before.title, source: before.source }, { title: after.title, source: after.source })) {
    sections.add("study"); details.push("Study title or source changed");
  }
  for (const id of new Set([...oldEntities.keys(), ...newEntities.keys()])) {
    const old = oldEntities.get(id), next = newEntities.get(id);
    if (!old || !next) { sections.add("entities"); mark(id, old ? "Removed from study" : "Added to study"); continue; }
    const changes: string[] = [];
    for (const key of ["kind", "title", "subtitle", "description"] as const) if (!same(old[key], next[key])) changes.push(key === "kind" ? "Type" : key[0].toUpperCase() + key.slice(1));
    if (!same(evidence(old.evidence), evidence(next.evidence))) changes.push("Source evidence changed");
    const oldFields = new Map(old.fields.map(field => [field.name, field]));
    const nextFields = new Map(next.fields.map(field => [field.name, field]));
    for (const name of new Set([...oldFields.keys(), ...nextFields.keys()])) {
      const prev = oldFields.get(name), proposed = nextFields.get(name);
      if (!prev || !proposed) changes.push(`${name}: ${prev ? "removed" : "added"}`);
      else if (!same(prev.value, proposed.value) || !same(prev.status, proposed.status)) changes.push(`${name}: ${!same(prev.value, proposed.value) ? `${prev.value} → ${proposed.value}` : "value unchanged"}${!same(prev.status, proposed.status) ? ` · ${prev.status ?? "unspecified"} → ${proposed.status ?? "unspecified"}` : ""}`);
    }
    // Field order is presentation, not a scientific change.
    if (changes.length) { sections.add("entities"); changes.forEach(detail => mark(id, detail)); }
  }
  const relationKey = (item: StudySchema["relations"][number]) => `${item.from}\u0000${item.to}\u0000${String(clean(item.label))}`;
  const oldRelations = new Set(before.relations.map(relationKey)), newRelations = new Set(after.relations.map(relationKey));
  if (!same([...oldRelations].sort(), [...newRelations].sort())) {
    sections.add("relations"); details.push("Study connections changed");
    for (const relation of [...before.relations, ...after.relations]) if (oldRelations.has(relationKey(relation)) !== newRelations.has(relationKey(relation))) {
      const action = oldRelations.has(relationKey(relation)) ? "removed" : "added";
      mark(relation.from, `Connection to ${relation.to} ${action}: ${relation.label}`);
      mark(relation.to, `Connection from ${relation.from} ${action}: ${relation.label}`);
    }
  }
  const oldSteps = byId(before.procedure), newSteps = byId(after.procedure);
  for (const id of new Set([...oldSteps.keys(), ...newSteps.keys()])) {
    const old = oldSteps.get(id), next = newSteps.get(id);
    if (!old || !next || !same({ ...old, evidence: evidence(old.evidence) }, { ...next, evidence: evidence(next.evidence) })) {
      sections.add("procedure");
      const keys: string[] = old && next ? (["name", "input", "actor", "output"] as const).filter(key => !same(old[key], next[key])) : [];
      if (old && next && !same(evidence(old.evidence), evidence(next.evidence))) keys.push("evidence");
      details.push(`${next?.name ?? old?.name ?? id}: procedure ${old ? next ? `changed (${keys.join(", ") || "details"})` : "removed" : "added"}`);
    }
  }
  if (!same(before.procedure.map(step => step.id), after.procedure.map(step => step.id))) {
    sections.add("procedure"); details.push("Procedure sequence changed");
  }
  if (sections.has("procedure")) for (const entity of after.entities) if (entity.kind === "procedure") mark(entity.id, "Procedure steps changed");
  const oldVariables = byId(before.variables), newVariables = byId(after.variables);
  for (const id of new Set([...oldVariables.keys(), ...newVariables.keys()])) {
    const old = oldVariables.get(id), next = newVariables.get(id);
    if (!old || !next || !same(old, next)) {
      sections.add("variables");
      const verb = old ? next ? "changed" : "removed" : "added";
      const keys = old && next ? Object.keys(next).filter(key => !same(old[key as keyof typeof old], next[key as keyof typeof next])) : [];
      details.push(`${next?.name ?? old?.name ?? id}: variable ${verb}${keys.length ? ` (${keys.join(", ")})` : ""}`);
      if (old?.entity) mark(old.entity, `Variable ${old.name} ${verb}${keys.length ? `: ${keys.join(", ")}` : ""}`);
      if (next?.entity) mark(next.entity, `Variable ${next.name} ${verb}${keys.length ? `: ${keys.join(", ")}` : ""}`);
    }
  }
  const oldIssues = byId(before.reviewIssues ?? []), newIssues = byId(after.reviewIssues ?? []);
  for (const id of new Set([...oldIssues.keys(), ...newIssues.keys()])) {
    const old = oldIssues.get(id), next = newIssues.get(id);
    const comparable = (issue: typeof old) => issue && { ...issue, ...(issue.evidence ? { evidence: evidence(issue.evidence) } : {}) };
    if (!old || !next || !same(comparable(old), comparable(next))) {
      sections.add("reviewIssues");
      const verb = old ? next ? "changed" : "resolved" : "added";
      details.push(`${next?.title ?? old?.title ?? id}: review question ${verb}`);
      if (old?.entity) mark(old.entity, `Review question ${verb}`);
      if (next?.entity) mark(next.entity, `Review question ${verb}`);
    }
  }
  const entities = [...changed.values()];
  return {
    hasChanges: sections.size > 0,
    changedEntityIds: entities.map(item => item.id),
    addedEntityIds: entities.filter(item => item.kind === "added").map(item => item.id),
    removedEntityIds: entities.filter(item => item.kind === "removed").map(item => item.id),
    entities, sections: [...sections], details,
  };
}
