import type { ModelAnchor } from "@/app/build-preview/model-review";
import type { Evidence, StudySchema } from "@/app/build-preview/study-schema";
import type { SourceSelection, StudioArtifact, StudioDocument, StudioSource } from "./types";
import { assertConversationTree } from "./conversation-tree";
import { MAX_PAPER_BYTES, MAX_RESOURCE_BYTES, sourceSpec } from "./resources";

export class StudioValidationError extends Error {
  readonly status = 400;
  constructor(message: string) { super(message); this.name = "StudioValidationError"; }
}

type ObjectValue = Record<string, unknown>;
const fail = (message: string): never => { throw new StudioValidationError(message); };
const object = (value: unknown, name: string): ObjectValue => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : fail(`${name} must be an object.`);
const array = (value: unknown, name: string, max: number): unknown[] => Array.isArray(value) && value.length <= max ? value : fail(`${name} must be an array with at most ${max} items.`);
const string = (value: unknown, name: string, max: number, required = false): string => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) fail(`${name} must be ${required ? "a nonempty" : "a"} string of at most ${max} characters.`);
  return value as string;
};
const id = (value: unknown, name: string): string => {
  const result = string(value, name, 100, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) fail(`${name} has invalid characters.`);
  return result;
};
const number = (value: unknown, name: string, min: number, max: number): number => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fail(`${name} must be between ${min} and ${max}.`);
const integer = (value: unknown, name: string, min: number, max: number): number => Number.isInteger(value) ? number(value, name, min, max) : fail(`${name} must be an integer.`);
const oneOf = <T extends string>(value: unknown, name: string, choices: readonly T[]): T => choices.includes(value as T) ? value as T : fail(`${name} is invalid.`);
const unique = (values: string[], name: string) => { if (new Set(values).size !== values.length) fail(`${name} contains duplicate IDs.`); };
const timestamp = (value: unknown, name: string) => {
  const result = string(value, name, 64, true);
  if (Number.isNaN(Date.parse(result))) fail(`${name} must be a date-time.`);
  return result;
};

export function validateStudioMessageRef(input: unknown, name = "message reference") {
  if (input === undefined || input === null) return undefined;
  const ref = object(input, name);
  return { conversationId: id(ref.conversationId, `${name}.conversationId`), messageId: id(ref.messageId, `${name}.messageId`) };
}

function rect(value: unknown, name: string) {
  const r = object(value, name);
  const x = number(r.x, `${name}.x`, 0, 100), y = number(r.y, `${name}.y`, 0, 100);
  const w = number(r.w, `${name}.w`, 0, 100), h = number(r.h, `${name}.h`, 0, 100);
  if (x + w > 100.01 || y + h > 100.01) fail(`${name} extends outside the source page.`);
  return { x, y, w, h };
}

function evidence(value: unknown, name: string, allowedPages?: ReadonlySet<number>, sources?: StudioSource[]): Evidence {
  const item = object(value, name);
  const page = integer(item.page, `${name}.page`, 1, 10000);
  if (allowedPages && !allowedPages.has(page)) fail(`${name}.page does not exist in the attached source.`);
  const sourceId = item.sourceId === undefined ? (sources?.length === 1 ? sources[0].id : undefined) : id(item.sourceId, `${name}.sourceId`);
  if (sources && sourceId && !sources.some(source => source.id === sourceId)) fail(`${name}.sourceId does not exist.`);
  const quote = string(item.quote, `${name}.quote`, 8000);
  if (sources && quote.trim() && (!sources.length || (sources.length > 1 && !sourceId))) fail(`${name} needs an attached, identified source.`);
  if (sources?.length) {
    const source = sources.find(candidate => candidate.id === sourceId) ?? (sources.length === 1 ? sources[0] : undefined);
    if (source?.pages?.length && !source.pages.some(candidate => candidate.page === page)) fail(`${name}.page does not exist in its source.`);
  }
  return { ...(sourceId ? { sourceId } : {}), page, rects: array(item.rects, `${name}.rects`, 64).map((r, i) => rect(r, `${name}.rects[${i}]`)), quote };
}

/** Structural and referential validation; source pages may be supplied for provenance checks. */
export function validateStudyModel(input: unknown, options: { allowedPages?: ReadonlySet<number>; sources?: StudioSource[] } = {}): StudySchema {
  const value = object(input, "model");
  const source = object(value.source, "model.source");
  const entities = array(value.entities, "model.entities", 200).map((raw, i) => {
    const e = object(raw, `model.entities[${i}]`);
    return {
      id: id(e.id, `model.entities[${i}].id`),
      kind: oneOf(e.kind, `model.entities[${i}].kind`, ["participants", "material", "procedure", "record", "variable", "analysis"] as const),
      title: string(e.title, `model.entities[${i}].title`, 200, true), subtitle: string(e.subtitle, `model.entities[${i}].subtitle`, 500),
      description: string(e.description, `model.entities[${i}].description`, 12000), evidence: evidence(e.evidence, `model.entities[${i}].evidence`, options.allowedPages, options.sources),
      fields: array(e.fields, `model.entities[${i}].fields`, 100).map((rawField, j) => {
        const field = object(rawField, `model.entities[${i}].fields[${j}]`);
        return { name: string(field.name, "field.name", 200, true), value: string(field.value, "field.value", 4000), ...(field.status === undefined ? {} : { status: oneOf(field.status, "field.status", ["reported", "implementation", "unresolved"] as const) }) };
      }),
      x: number(e.x, "entity.x", 0, 10000), y: number(e.y, "entity.y", 0, 10000), w: number(e.w, "entity.w", 0, 10000), h: number(e.h, "entity.h", 0, 10000),
    };
  });
  unique(entities.map(e => e.id), "model.entities");
  const entityIds = new Set(entities.map(e => e.id));
  const relations = array(value.relations, "model.relations", 500).map((raw, i) => {
    const relation = object(raw, `model.relations[${i}]`);
    const from = id(relation.from, "relation.from"), to = id(relation.to, "relation.to");
    if (!entityIds.has(from) || !entityIds.has(to)) fail(`model.relations[${i}] refers to a missing entity.`);
    return { from, to, label: string(relation.label, "relation.label", 300) };
  });
  const procedure = array(value.procedure, "model.procedure", 200).map((raw, i) => {
    const step = object(raw, `model.procedure[${i}]`);
    return { id: id(step.id, "procedure.id"), name: string(step.name, "procedure.name", 200, true), input: string(step.input, "procedure.input", 4000), actor: string(step.actor, "procedure.actor", 1000), output: string(step.output, "procedure.output", 4000), evidence: evidence(step.evidence, `model.procedure[${i}].evidence`, options.allowedPages, options.sources) };
  });
  unique(procedure.map(step => step.id), "model.procedure");
  const variables = array(value.variables, "model.variables", 500).map((raw, i) => {
    const v = object(raw, `model.variables[${i}]`);
    const entity = id(v.entity, "variable.entity");
    if (!entityIds.has(entity)) fail(`model.variables[${i}] refers to a missing entity.`);
    return { id: id(v.id, "variable.id"), name: string(v.name, "variable.name", 200, true), role: string(v.role, "variable.role", 500), type: string(v.type, "variable.type", 500), unit: string(v.unit, "variable.unit", 500), producedBy: string(v.producedBy, "variable.producedBy", 2000), usedBy: string(v.usedBy, "variable.usedBy", 2000), definition: string(v.definition, "variable.definition", 8000), status: oneOf(v.status, "variable.status", ["reported", "implementation", "unresolved"] as const), entity };
  });
  unique(variables.map(v => v.id), "model.variables");
  return { id: id(value.id, "model.id"), title: string(value.title, "model.title", 300, true), source: { title: string(source.title, "model.source.title", 300), authors: string(source.authors, "model.source.authors", 500), filename: string(source.filename, "model.source.filename", 300) }, entities, relations, procedure, variables };
}

export function validateModelAnchor(input: unknown, model: StudySchema, options: { historical?: boolean } = {}): ModelAnchor | null {
  if (input === null || input === undefined) return null;
  const value = object(input, "modelAnchor");
  const kind = oneOf(value.kind, "modelAnchor.kind", ["objects", "lasso", "issue"] as const);
  const known = new Set(model.entities.map(e => e.id));
  const entityIds = array(value.entityIds, "modelAnchor.entityIds", 100).map((entry, i) => id(entry, `modelAnchor.entityIds[${i}]`));
  unique(entityIds, "modelAnchor.entityIds");
  if (!options.historical && entityIds.some(entityId => !known.has(entityId))) fail("modelAnchor refers to a missing entity.");
  const points = value.points === undefined ? undefined : array(value.points, "modelAnchor.points", 512).map((entry, i) => { const point = object(entry, `modelAnchor.points[${i}]`); return { x: number(point.x, "point.x", 0, 100), y: number(point.y, "point.y", 0, 100) }; });
  const issueId = value.issueId === undefined ? undefined : id(value.issueId, "modelAnchor.issueId");
  return { kind, entityIds, ...(points ? { points } : {}), ...(issueId ? { issueId } : {}) };
}

export function validateSourceSelection(input: unknown, sources: StudioSource[], options: { historical?: boolean } = {}): SourceSelection | null {
  if (input === null || input === undefined) return null;
  if (!sources.length && !options.historical) fail("sourceSelection requires an attached source.");
  const value = object(input, "sourceSelection");
  const sourceId = value.sourceId === undefined ? (!options.historical && sources.length === 1 ? sources[0].id : undefined) : id(value.sourceId, "sourceSelection.sourceId");
  if (!options.historical && sourceId && !sources.some(source => source.id === sourceId)) fail("sourceSelection refers to a missing source.");
  const page = integer(value.page, "sourceSelection.page", 1, 10000);
  const source = sources.find(item => item.id === sourceId) ?? (sources.length === 1 ? sources[0] : undefined);
  if (!options.historical && sources.length > 1 && !sourceId) fail("sourceSelection.sourceId is required for multiple sources.");
  if (!options.historical && source?.pages?.length && !source.pages.some(item => item.page === page)) fail("sourceSelection.page does not exist in its source.");
  return { ...(sourceId ? { sourceId } : {}), page, rects: array(value.rects, "sourceSelection.rects", 64).map((entry, i) => rect(entry, `sourceSelection.rects[${i}]`)), text: string(value.text, "sourceSelection.text", 8000), kind: oneOf(value.kind, "sourceSelection.kind", ["text", "region", "evidence"] as const) };
}

function validateSource(input: unknown, index: number): StudioSource {
  const source = object(input, `sources[${index}]`);
  const name = string(source.name, "source.name", 300, true);
  const spec = sourceSpec(name);
  if (!spec) return fail("source.name must identify a supported file type.");
  if (source.mimeType !== spec.mimeType) fail("source.mimeType does not match its file type.");
  const kind = source.kind === undefined ? undefined : oneOf(source.kind, "source.kind", ["paper", "resource"] as const);
  if (kind !== undefined && kind !== spec.kind || spec.kind === "resource" && kind !== "resource") fail("source.kind does not match its file type.");
  const includeInBuild = source.includeInBuild === undefined ? undefined : source.includeInBuild;
  if (includeInBuild !== undefined && typeof includeInBuild !== "boolean") return fail("source.includeInBuild must be a boolean.");
  const path = string(source.path, "source.path", 500);
  if (path && (path.startsWith("/") || path.includes("\\") || path.split("/").some(part => part === ".." || !part) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path))) fail("source.path must be a relative storage key.");
  const pages = source.pages === undefined ? undefined : array(source.pages, "source.pages", 2000).map((raw, i) => { const page = object(raw, `source.pages[${i}]`); return { page: integer(page.page, "source.page", 1, 10000), text: string(page.text, "source.page.text", 30000) }; });
  if (pages) unique(pages.map(page => String(page.page)), "source.pages");
  if (spec.kind === "resource" && (source.text !== undefined || pages !== undefined)) fail("Auxiliary resources do not have PDF page text.");
  const size = integer(source.size, "source.size", 1, spec.kind === "paper" ? MAX_PAPER_BYTES : MAX_RESOURCE_BYTES);
  return { id: id(source.id, "source.id"), name, path, mimeType: spec.mimeType, size, ...(kind ? { kind } : {}), ...(includeInBuild === undefined ? {} : { includeInBuild }), ...(source.text === undefined ? {} : { text: string(source.text, "source.text", 1_000_000) }), ...(pages ? { pages } : {}) };
}

const artifactExtensions: Record<StudioArtifact["format"], readonly string[]> = {
  markdown: [".md"], csv: [".csv"], json: [".json"], text: [".txt"], python: [".py"], r: [".r", ".R"],
};

/** A complete auxiliary-material snapshot. Historical snapshots may cite retired sources. */
export function validateStudioArtifacts(input: unknown, sources: StudioSource[], options: { historical?: boolean } = {}): StudioArtifact[] | undefined {
  if (input === undefined) return undefined;
  const knownSources = new Set(sources.map(source => source.id));
  let totalBytes = 0;
  const artifacts = array(input, "artifacts", 30).map((raw, index) => {
    const item = object(raw, `artifacts[${index}]`);
    const artifactId = id(item.id, "artifact.id");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(artifactId)) fail("artifact.id must be safe as an archive directory.");
    const format = oneOf(item.format, "artifact.format", ["markdown", "csv", "json", "text", "python", "r"] as const);
    const filename = string(item.filename, "artifact.filename", 120, true);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename) || filename.includes("..") || !artifactExtensions[format].some(extension => filename.endsWith(extension))) {
      fail("artifact.filename must be a safe basename with the matching format extension.");
    }
    const content = string(item.content, "artifact.content", 100_000);
    totalBytes += new TextEncoder().encode(content).byteLength;
    if (totalBytes > 120_000) fail("artifacts exceed the 120 KB total content limit.");
    if (format === "json") {
      try { JSON.parse(content); }
      catch { fail("JSON artifact content must be valid JSON."); }
    }
    const sourceIds = array(item.sourceIds, "artifact.sourceIds", 100).map((rawSourceId, j) => id(rawSourceId, `artifact.sourceIds[${j}]`));
    unique(sourceIds, "artifact.sourceIds");
    if (!options.historical && sourceIds.some(sourceId => !knownSources.has(sourceId))) fail("artifact refers to a missing source.");
    return { id: artifactId, title: string(item.title, "artifact.title", 200, true), filename, format,
      kind: oneOf(item.kind, "artifact.kind", ["instructions", "instrument", "analysis", "other"] as const), content, sourceIds };
  });
  unique(artifacts.map(artifact => artifact.id), "artifacts");
  return artifacts;
}

export function validateStudioDocument(input: unknown): StudioDocument {
  const value = object(input, "document");
  if (value.version !== 1) fail("Unsupported studio document version.");
  const sources = array(value.sources, "document.sources", 100).map(validateSource);
  unique(sources.map(source => source.id), "document.sources");
  const model = validateStudyModel(value.model, { sources });
  const entityIds = new Set(model.entities.map(entity => entity.id));
  const annotations = array(value.annotations, "document.annotations", 10000).map((raw, i) => {
    const item = object(raw, `annotations[${i}]`);
    const selection = validateSourceSelection(item, sources)!;
    const entity = item.entity === "" ? "" : id(item.entity, "annotation.entity");
    if (entity && !entityIds.has(entity)) fail(`annotations[${i}] refers to a missing entity.`);
    return { ...selection, id: id(item.id, "annotation.id"), comment: string(item.comment, "annotation.comment", 12000, true), entity, createdAt: timestamp(item.createdAt, "annotation.createdAt") };
  });
  unique(annotations.map(annotation => annotation.id), "document.annotations");
  const conversations = array(value.conversations, "document.conversations", 500).map((raw, i) => {
    const c = object(raw, `conversations[${i}]`);
    const selected = c.selected === "" ? "" : id(c.selected, "conversation.selected");
    if (selected && !entityIds.has(selected)) fail(`conversations[${i}] refers to a missing selected entity.`);
    const messages = array(c.messages, "conversation.messages", 1000).map((rawMessage, j) => {
      const m = object(rawMessage, `conversations[${i}].messages[${j}]`);
      const entityId = m.entityId === undefined ? undefined : id(m.entityId, "message.entityId");
      // Message references and proposal snapshots describe what was true at the time.
      // A later model/source change must not erase that history.
      const sourceSelection = validateSourceSelection(m.sourceSelection, sources, { historical: true });
      const modelAnchor = validateModelAnchor(m.modelAnchor, model, { historical: true });
      const replyTo = validateStudioMessageRef(m.replyTo, "message.replyTo");
      const mergedFrom = validateStudioMessageRef(m.mergedFrom, "message.mergedFrom");
      const evidenceList = m.evidence === undefined ? undefined : array(m.evidence, "message.evidence", 100).map((entry, k) => evidence(entry, `message.evidence[${k}]`));
      const proposal = m.proposal === undefined ? undefined : (() => { const p = object(m.proposal, "message.proposal"); const artifacts = validateStudioArtifacts(p.artifacts, sources, { historical: true }); if (p.changesModel !== undefined && typeof p.changesModel !== "boolean") fail("proposal.changesModel must be a boolean."); return { id: id(p.id, "proposal.id"), model: validateStudyModel(p.model), ...(typeof p.changesModel === "boolean" ? { changesModel: p.changesModel } : {}), ...(artifacts ? { artifacts } : {}), summary: string(p.summary, "proposal.summary", 4000), status: oneOf(p.status, "proposal.status", ["pending", "applied", "rejected"] as const) }; })();
      return { id: id(m.id, "message.id"), role: oneOf(m.role, "message.role", ["user", "agent"] as const), text: string(m.text, "message.text", 20000), createdAt: timestamp(m.createdAt, "message.createdAt"), ...(entityId ? { entityId } : {}), ...(m.context === undefined ? {} : { context: string(m.context, "message.context", 2000) }), ...(modelAnchor ? { modelAnchor } : {}), ...(sourceSelection ? { sourceSelection } : {}), ...(replyTo ? { replyTo } : {}), ...(mergedFrom ? { mergedFrom } : {}), ...(evidenceList ? { evidence: evidenceList } : {}), ...(proposal ? { proposal } : {}) };
    });
    unique(messages.map(message => message.id), "conversation.messages");
    const parent = validateStudioMessageRef(c.parent, "conversation.parent");
    return { id: id(c.id, "conversation.id"), title: string(c.title, "conversation.title", 300), updatedAt: timestamp(c.updatedAt, "conversation.updatedAt"), messages, ...(parent ? { parent } : {}), draft: string(c.draft, "conversation.draft", 20000), modelAnchor: validateModelAnchor(c.modelAnchor, model), sourceSelection: validateSourceSelection(c.sourceSelection, sources), selected };
  });
  unique(conversations.map(conversation => conversation.id), "document.conversations");
  try { assertConversationTree(conversations); }
  catch (error) { fail(error instanceof Error ? error.message : "Invalid conversation links."); }
  const reviewResponses: StudioDocument["reviewResponses"] = {};
  const rawResponses = object(value.reviewResponses, "document.reviewResponses");
  for (const [key, raw] of Object.entries(rawResponses)) {
    id(key, "review response ID");
    const response = object(raw, `reviewResponses.${key}`);
    reviewResponses[key] = { text: string(response.text, "review response text", 12000, true), savedAt: timestamp(response.savedAt, "review response date") };
  }
  const activeConversationId = value.activeConversationId === undefined ? undefined : id(value.activeConversationId, "document.activeConversationId");
  if (activeConversationId && !conversations.some(c => c.id === activeConversationId)) fail("document.activeConversationId refers to a missing conversation.");
  const artifacts = validateStudioArtifacts(value.artifacts, sources);
  const pipeline = value.pipeline === undefined ? undefined : (() => {
    const p = object(value.pipeline, "pipeline");
    const jobId = string(p.jobId, "pipeline.jobId", 80, true);
    if (!/^studio-[0-9a-f-]{73}$/i.test(jobId)) fail("Invalid pipeline job ID.");
    return {jobId,requestId:id(p.requestId,"pipeline.requestId"),conversationId:id(p.conversationId,"pipeline.conversationId"),sourceId:id(p.sourceId,"pipeline.sourceId"),status:oneOf(p.status,"pipeline.status",["preparing","queued","running","review","complete","failed"] as const),message:string(p.message,"pipeline.message",4000),updatedAt:timestamp(p.updatedAt,"pipeline.updatedAt"),...(p.proposalId?{proposalId:id(p.proposalId,"pipeline.proposalId")}: {})};
  })();
  return { ...(pipeline ? {pipeline} : {}), version: 1, title: string(value.title, "document.title", 300, true), model, sources, annotations, conversations, reviewResponses, ...(artifacts ? { artifacts } : {}), ...(activeConversationId ? { activeConversationId } : {}) };
}
