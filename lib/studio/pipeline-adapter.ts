import type { Evidence, StudySchema, Entity, Variable } from "@/app/build-preview/study-schema";
import type { StudioArtifact, StudioDocument } from "./types";
import { validateStudyModel, validateStudioArtifacts } from "./validation";

type PackageFile = { path: string; content: string };
type JsonObject = Record<string, unknown>;
const record = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
const clipped = (value: string, max: number) => value.slice(0, max);
const readable = (value: unknown, max = 4000): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return clipped(text(value), max);
  return clipped(JSON.stringify(value), max);
};
const first = (value: JsonObject, ...names: string[]) => names.map(name => value[name]).find(item => item !== undefined && item !== null);
const parse = (file?: PackageFile): JsonObject => {
  if (!file) return {};
  try { return record(JSON.parse(file.content)); } catch { return {}; }
};
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const safeId = (value: string, fallback: string) => {
  const id = value.replace(/[^A-Za-z0-9._:-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 100);
  return id || fallback;
};
const basePath = (path: string) => path.replace(/\\/g, "/").replace(/^\/+/, "");
const suffix = (path: string, target: string) => path === target || path.endsWith(`/${target}`);
const getFile = (files: PackageFile[], target: string) => files.find(file => suffix(basePath(file.path), target));

function sourceEvidence(document: StudioDocument): Evidence {
  const source = document.sources.find(item => item.pages?.length) ?? document.sources[0];
  return { ...(source ? { sourceId: source.id } : {}), page: source?.pages?.[0]?.page ?? 1, rects: [], quote: "" };
}

/** Keep a sidecar's quote only when its exact text appears on the identified attached page. */
function cleanEvidence(input: Evidence, document: StudioDocument): Evidence {
  const source = document.sources.find(item => item.id === input.sourceId) ?? (document.sources.length === 1 ? document.sources[0] : undefined);
  const page = source?.pages?.find(item => item.page === input.page);
  const quote = input.quote?.trim() ?? "";
  return { ...(source ? { sourceId: source.id } : {}), page: page?.page ?? source?.pages?.[0]?.page ?? 1,
    rects: [], quote: quote && page?.text.includes(quote) ? quote : "" };
}

function sidecarModel(files: PackageFile[], document: StudioDocument): StudySchema | undefined {
  const file = getFile(files, "studio-model.json");
  if (!file) return undefined;
  try {
    const raw=record(JSON.parse(file.content));
    // Categorical variables often have no physical unit. Null carries the same
    // display meaning as an empty unit; it must not discard a complete model.
    if(Array.isArray(raw.variables))raw.variables=raw.variables.map(value=>{
      const variable=record(value);
      const references=(value:unknown)=>Array.isArray(value)&&value.every(item=>typeof item==='string')?value.join(', '):value;
      return {...variable,unit:variable.unit===null?"":variable.unit,producedBy:references(variable.producedBy),usedBy:references(variable.usedBy)};
    });
    const model = validateStudyModel(raw, { sources: document.sources });
    const grounded = { ...model,
      entities: model.entities.map(entity => ({ ...entity, evidence: cleanEvidence(entity.evidence, document) })),
      procedure: model.procedure.map(step => ({ ...step, evidence: cleanEvidence(step.evidence, document) })),
    };
    return validateStudyModel(grounded, { sources: document.sources });
  } catch { return undefined; }
}

function packageArtifacts(files: PackageFile[], document: StudioDocument): { artifacts: StudioArtifact[]; omitted: string[] } {
  const artifacts: StudioArtifact[] = [], omitted: string[] = [];
  const used = new Set<string>();
  let total = 0;
  for (const file of files) {
    const path = basePath(file.path);
    const extension = path.match(/(\.md|\.csv|\.json|\.txt|\.py|\.r|\.R)$/)?.[0];
    const format = extension === ".md" ? "markdown" : extension === ".csv" ? "csv" : extension === ".json" ? "json" : extension === ".txt" ? "text" : extension === ".py" ? "python" : extension === ".r" || extension === ".R" ? "r" : undefined;
    const size = bytes(file.content);
    if (!format || size > 100_000 || total + size > 120_000 || artifacts.length >= 30 || (format === "json" && !isJson(file.content))) { omitted.push(path); continue; }
    const basename = path.split("/").pop() ?? "file";
    let filename = basename.replace(/[^A-Za-z0-9._-]/g, "-").replace(/\.\./g, "--");
    if (!/^[A-Za-z0-9]/.test(filename)) filename = `file-${filename}`;
    filename = filename.slice(0, 120 - extension!.length - 1).replace(/\.[^.]*$/, "") + extension!;
    const stem = safeId(path.replace(/\.[^.]+$/, "").replace(/\//g, "-"), "artifact").replace(/[.:]/g, "-");
    let id = stem, serial = 2;
    while (used.has(id)) id = `${stem.slice(0, 95)}-${serial++}`;
    used.add(id);
    const kind: StudioArtifact["kind"] = path.includes("evaluation/") || path.includes("analysis") ? "analysis" : path.includes("materials/") ? "instrument" : path.includes("task/") ? "instructions" : "other";
    artifacts.push({ id, title: clipped(path, 200), filename, format, kind, content: file.content, sourceIds: [] });
    total += size;
  }
  return { artifacts: validateStudioArtifacts(artifacts, document.sources) ?? [], omitted };
}
function isJson(content: string) { try { JSON.parse(content); return true; } catch { return false; } }

function fallbackModel(files: PackageFile[], document: StudioDocument): StudySchema {
  const overview = parse(getFile(files, "study.json"));
  const specification = parse(getFile(files, "source/specification.json"));
  const index = parse(getFile(files, "index.json"));
  const oldMetadata = parse(getFile(files, "source/metadata.json"));
  const metadata = Object.keys(parse(getFile(files, "source/paper_metadata.json"))).length ? parse(getFile(files, "source/paper_metadata.json")) : { ...index, ...oldMetadata };
  const materialFiles = files.filter(file => /\/source\/materials\/[^/]+\.json$/.test(basePath(file.path)));
  const materials = Object.keys(parse(getFile(files, "materials/materials.json"))).length ? parse(getFile(files, "materials/materials.json")) :
    Object.fromEntries(materialFiles.slice(0, 50).map(file => [basePath(file.path).split("/").pop()!, parse(file)]));
  const task = parse(getFile(files, "task/task.json"));
  const auditRaw = getFile(files, "audit/missing_information.json");
  let audit: unknown = [];
  try { audit = auditRaw ? JSON.parse(auditRaw.content) : []; } catch { /* invalid file stays available in the ZIP */ }
  const checklist = Array.isArray(audit) ? audit : list(first(record(audit), "items", "missing_information", "questions", "review_items"));
  const title = clipped(text(first(overview, "title", "paper_title")) || text(first(specification, "title", "paper_title")) || text(first(metadata, "title", "paper_title")) || document.title || "Generated study", 300);
  const source = { title: clipped(text(first(metadata, "title", "paper_title")) || title, 300),
    authors: clipped(list(metadata.authors).map(text).filter(Boolean).join(", ") || text(metadata.authors), 500),
    filename: clipped(document.sources[0]?.name ?? "", 300) };
  const evidence = sourceEvidence(document);
  const entities: Entity[] = [];
  const add = (id: string, kind: Entity["kind"], label: string, description: string, fields: Entity["fields"]) => {
    const index = entities.length;
    entities.push({ id, kind, title: label, subtitle: "Pipeline package", description: clipped(description, 12000), evidence,
      fields: fields.slice(0, 100).map(field => ({ ...field, name: clipped(field.name, 200), value: clipped(field.value, 4000) })),
      x: 35 + index % 3 * 270, y: 35 + Math.floor(index / 3) * 160, w: 235, h: 115 });
  };
  const field = (name: string, value: unknown, status: "implementation" | "unresolved" = "implementation") => {
    const rendered = readable(value);
    return { name, value: rendered, status: /\bNEED_INPUT\b/.test(rendered) ? "unresolved" as const : status };
  };
  const participantFlow = first(overview, "participant_flow", "participants") ?? specification.participants;
  const conditions = first(task, "conditions", "arms") ?? first(overview, "conditions") ?? record(specification.design).conditions;
  add("participants", "participants", "Participants and assignment", readable(participantFlow, 12000), [
    field("Participant flow", participantFlow ?? "Needs source review", participantFlow ? "implementation" : "unresolved"),
    field("Agent structure", first(task, "participant_structure", "agents", "roles") ?? "Needs source review", first(task, "participant_structure", "agents", "roles") ? "implementation" : "unresolved"),
    field("Conditions", conditions ?? "Needs source review", conditions ? "implementation" : "unresolved"),
  ]);
  add("materials", "material", "Participant materials", readable(materials, 12000), [
    field("Material manifest", Object.keys(materials).length ? materials : "Needs source review", Object.keys(materials).length ? "implementation" : "unresolved"),
  ]);
  const steps = list(first(task, "procedure", "steps", "stages")).length ? list(first(task, "procedure", "steps", "stages")) :
    list(first(overview, "procedure", "steps", "stages")).length ? list(first(overview, "procedure", "steps", "stages")) : list(specification.procedure);
  const procedure: StudySchema["procedure"] = steps.slice(0, 200).map((raw, index) => {
    const step = record(raw);
    return { id: `step-${index + 1}`, name: clipped(text(first(step, "name", "title", "stage")) || `Step ${index + 1}`, 200),
      input: readable(first(step, "input", "inputs", "sees", "materials")), actor: clipped(readable(first(step, "actor", "role", "agent")), 1000),
      output: readable(first(step, "output", "outputs", "response", "details")), evidence };
  });
  add("procedure", "procedure", "Procedure", readable(first(task, "procedure", "steps", "stages") ?? first(overview, "procedure", "participant_flow") ?? specification.procedure, 12000), [
    field("Steps", steps.length ? `${steps.length} package step(s)` : "Needs source review", steps.length ? "implementation" : "unresolved"),
    field("Inputs", first(task, "inputs", "input") ?? "Needs source review", first(task, "inputs", "input") ? "implementation" : "unresolved"),
  ]);
  add("records", "record", "Session records", readable(first(task, "outputs", "output", "session_log"), 12000), [
    field("Outputs", first(task, "outputs", "output", "session_log") ?? "Needs source review", first(task, "outputs", "output", "session_log") ? "implementation" : "unresolved"),
  ]);
  const variableInputs = [...list(first(task, "inputs", "input_variables")), ...list(first(task, "outputs", "output_variables")), ...list(first(overview, "outcomes", "measures")),
    ...list(specification.independent_variables), ...list(specification.dependent_variables), ...list(specification.primary_outcomes), ...list(specification.secondary_outcomes)];
  const variables: Variable[] = variableInputs.slice(0, 500).map((raw, index) => {
    const item = record(raw);
    const name = clipped(text(first(item, "name", "id", "field", "outcome")) || (typeof raw === "string" ? raw : `Variable ${index + 1}`), 200);
    return { id: `variable-${index + 1}`, name, role: clipped(text(first(item, "role", "kind")), 500), type: clipped(text(first(item, "type", "format")), 500),
      unit: clipped(text(first(item, "unit", "unit_of_analysis")), 500), producedBy: "Pipeline package", usedBy: "", definition: readable(raw, 8000),
      status: /\bNEED_INPUT\b/.test(readable(raw, 8000)) ? "unresolved" : "implementation", entity: "variables" };
  });
  add("variables", "variable", "Variables and outcomes", readable(variableInputs, 12000), [
    field("Variables", variables.length ? `${variables.length} package variable(s)` : "Needs source review", variables.length ? "implementation" : "unresolved"),
  ]);
  const analysis = first(overview, "findings", "analysis", "outcomes") ?? first(oldMetadata, "statistical_methods_used", "findings");
  add("analysis", "analysis", "Analysis and evaluation", readable(analysis, 12000), [
    field("Evaluation file", getFile(files, "evaluation/evaluation.py")?.path ?? "Needs source review", getFile(files, "evaluation/evaluation.py") ? "implementation" : "unresolved"),
    field("Outcomes", first(overview, "outcomes", "findings") ?? specification.primary_outcomes ?? "Needs source review", first(overview, "outcomes", "findings") ?? specification.primary_outcomes ? "implementation" : "unresolved"),
  ]);
  if (checklist.length) add("review", "analysis", "Researcher review needed", "Questions and missing information from audit/missing_information.json.",
    checklist.slice(0, 100).map((raw, index) => {
      const item = record(raw);
      return field(text(first(item, "field", "name")) || `Review item ${index + 1}`, { reason: item.reason, impact: item.impact, suggested_action: item.suggested_action }, "unresolved");
    }));
  const relations = [{ from: "participants", to: "procedure", label: "takes part in" }, { from: "materials", to: "procedure", label: "provides input" },
    { from: "procedure", to: "records", label: "produces" }, { from: "records", to: "variables", label: "contains" }, { from: "variables", to: "analysis", label: "is evaluated by" }];
  const model: StudySchema = { id: safeId(text(first(overview, "study_id", "id")) || text(specification.study_id) || title.toLowerCase().replace(/\s+/g, "-"), "pipeline-study"), title,
    source, entities, relations, procedure, variables };
  return validateStudyModel(model, { sources: document.sources });
}

/** Pure, bounded presentation of a complete HumanStudy-Bench package. */
export function adaptPipelinePackage(files: PackageFile[], document: StudioDocument): { model: StudySchema; artifacts: StudioArtifact[]; summary: string } {
  const validatedSidecar = sidecarModel(files, document);
  const model = validatedSidecar ?? fallbackModel(files, document);
  const { artifacts, omitted } = packageArtifacts(files, document);
  const usedSidecar = !!validatedSidecar;
  let summary = `HumanStudy-Bench package: ${files.length} file(s); ${artifacts.length} available in Studio. ${usedSidecar ? "Validated studio-model.json sidecar used." : "Package mapped into a reviewable model; source evidence and missing choices require researcher review."}`;
  if (omitted.length) summary += ` Studio omitted ${omitted.length} file(s) because of format, validity, count, or size limits: ${omitted.join(", ")}. The complete package ZIP remains available.`;
  return { model, artifacts, summary: clipped(summary, 4000) };
}
