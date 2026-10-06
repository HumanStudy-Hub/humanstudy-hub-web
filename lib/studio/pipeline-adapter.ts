import type { Evidence, StudySchema, StudyReviewIssue, Entity, Variable } from "@/app/build-preview/study-schema";
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

function procedureSteps(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const nested = record(value);
  return [nested.steps, nested.stages, nested.procedure].map(list).find(steps => steps.length > 0) ?? [];
}

/** Read the observed portions of the benchmark's documented ground-truth
 * convention. Hypotheses, test names and expected directions alone are plans,
 * not results. Keep experiment/finding identity and extraction caveats. */
function groundTruthObservations(groundTruth: JsonObject): JsonObject[] {
  const groups = list(groundTruth.studies).map(record);
  if (Array.isArray(groundTruth.preliminary_study_findings)) groups.push({
    study_id: "preliminary_study", findings: groundTruth.preliminary_study_findings,
  });
  if (Object.keys(record(groundTruth.main_study)).length) groups.push(record(groundTruth.main_study));
  if (Array.isArray(groundTruth.findings)) groups.push(groundTruth);
  const observedKeys = ["reported_statistics", "reported_result", "observed_result", "result", "results",
    "effect_size", "estimate", "statistic", "p_value", "confidence_interval", "raw_data"];
  const hasValue = (value: unknown) => value !== undefined && value !== null && value !== "" &&
    (!Array.isArray(value) || value.length > 0) && (typeof value !== "object" || Array.isArray(value) || Object.keys(record(value)).length > 0);
  return groups.flatMap(group => list(group.findings).flatMap(raw => {
    const finding = record(raw);
    const identity = { source_file: "source/ground_truth.json", study_id: group.study_id, study_name: group.study_name, finding_id: finding.finding_id };
    const observations: JsonObject[] = [];
    for (const key of ["original_data_points", "raw_outcomes", ...observedKeys]) {
      if (hasValue(finding[key])) observations.push({ ...identity, [key]: finding[key] });
    }
    for (const rawTest of list(finding.statistical_tests)) {
      const test = record(rawTest);
      if (!observedKeys.some(key => hasValue(test[key]))) continue;
      const preserved = Object.fromEntries([...observedKeys, "test_id", "test_name", "variable", "model", "claim", "location", "note", "covariates"]
        .filter(key => hasValue(test[key])).map(key => [key, test[key]]));
      observations.push({ ...identity, ...preserved });
    }
    return observations;
  }));
}

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

/** Keep the proposed layout while stripping source claims that cannot be verified
 * against the attached, extracted page text. Rectangles have no text-to-region
 * proof in the current source format, so they cannot be certified here. */
export function groundStudioModelEvidence(model: StudySchema, document: StudioDocument): StudySchema {
  const grounded = { ...model,
    entities: model.entities.map(entity => ({ ...entity, evidence: cleanEvidence(entity.evidence, document) })),
    procedure: model.procedure.map(step => ({ ...step, evidence: cleanEvidence(step.evidence, document) })),
    reviewIssues: model.reviewIssues?.map(issue => ({ ...issue, ...(issue.evidence ? { evidence: cleanEvidence(issue.evidence, document) } : {}) })),
  };
  return validateStudyModel(grounded, { sources: document.sources });
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
    return groundStudioModelEvidence(model, document);
  } catch { return undefined; }
}

function auditIssues(files: PackageFile[], document: StudioDocument): StudyReviewIssue[] {
  const auditRaw = getFile(files, "audit/missing_information.json");
  let audit: unknown = [];
  try { audit = auditRaw ? JSON.parse(auditRaw.content) : []; } catch { return []; }
  const checklist = Array.isArray(audit) ? audit : list(first(record(audit), "items", "missing_information", "questions", "review_items"));
  const candidates = checklist.slice(0, 200).map(raw => {
    const item = record(raw);
    const severity: StudyReviewIssue["severity"] = item.severity === "blocking" || item.severity === "decision" || item.severity === "check" ? item.severity : item.blocking === true ? "blocking" : "check";
    const pointer = text(first(item, "source_pointer", "sourcePointer", "source", "citation"));
    const rawEvidence = record(item.evidence);
    const candidate = typeof rawEvidence.page === "number" && Number.isInteger(rawEvidence.page) && typeof rawEvidence.quote === "string"
      ? cleanEvidence({ sourceId: text(rawEvidence.sourceId) || undefined, page: rawEvidence.page, rects: [], quote: rawEvidence.quote }, document) : undefined;
    return { id: "", title: clipped(text(first(item, "title", "field", "name")) || "Review item", 200), severity,
      reason: clipped(text(first(item, "reason", "question")), 4000), impact: clipped(text(item.impact), 4000),
      suggestedAction: clipped(text(first(item, "suggested_action", "suggestedAction")), 4000),
      ...(text(item.study) ? { study: clipped(text(item.study), 300) } : {}),
      ...(text(item.field) ? { field: clipped(text(item.field), 300) } : {}),
      ...(pointer ? { sourcePointer: clipped(pointer, 1000) } : {}),
      ...(candidate?.quote ? { evidence: candidate } : {}),
    };
  });
  // Identity excludes package order and mutable remediation text. Changing the
  // actual question gives it a new response key; identical audit rows collapse.
  const identity = (issue: StudyReviewIssue) => [issue.study ?? "", issue.field ?? "", issue.title, issue.reason].join("\u0000");
  const hash = (value: string) => {
    let result = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 0x01000193);
    return (result >>> 0).toString(16).padStart(8, "0");
  };
  const unique = [...new Map(candidates.map(issue => [identity(issue), issue])).entries()];
  const collisions = new Map<string, string[]>();
  for (const [key] of unique) {
    const digest = hash(key), group = collisions.get(digest) ?? [];
    group.push(key); collisions.set(digest, group);
  }
  for (const group of collisions.values()) group.sort();
  return unique.map(([key, issue]) => {
    const digest = hash(key), group = collisions.get(digest)!;
    return { ...issue, id: `audit-${digest}${group.length > 1 ? `-${group.indexOf(key) + 1}` : ""}` };
  });
}

function withAuditIssues(model: StudySchema, files: PackageFile[], document: StudioDocument): StudySchema {
  const key = (issue: StudyReviewIssue) => `${issue.study ?? ""}\u0000${issue.field ?? issue.title}`.toLowerCase();
  const audits = auditIssues(files, document);
  const consumed = new Set<string>();
  const explicit = (model.reviewIssues ?? []).map(issue => {
    const audit = audits.find(candidate => key(candidate) === key(issue) && !consumed.has(candidate.id) && candidate.reason === issue.reason)
      ?? audits.find(candidate => key(candidate) === key(issue) && !consumed.has(candidate.id));
    if (!audit) return issue;
    consumed.add(audit.id);
    return { ...issue, id: audit.id, reason: audit.reason || issue.reason, impact: audit.impact || issue.impact,
      suggestedAction: audit.suggestedAction || issue.suggestedAction,
      ...(audit.sourcePointer ? { sourcePointer: audit.sourcePointer } : {}) };
  });
  const additions = audits.filter(issue => !consumed.has(issue.id));
  const used = new Set(explicit.map(issue => issue.id));
  for (const issue of additions) {
    let id = issue.id, serial = 2;
    while (used.has(id)) id = `${issue.id}-${serial++}`;
    issue.id = id; used.add(id);
  }
  return explicit.length || additions.length ? { ...model, reviewIssues: [...explicit, ...additions].slice(0, 200) } : model;
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
  const groundTruth = parse(getFile(files, "source/ground_truth.json"));
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
  const subtitleFrom = (value: unknown): string => {
    if (typeof value === "string") {
      const clean = value.replace(/\s+/g, " ").trim();
      if (/^[{[]/.test(clean)) { try { return subtitleFrom(JSON.parse(clean)); } catch { return ""; } }
      return clipped(clean, 300);
    }
    if (Array.isArray(value)) {
      const summaries = value.slice(0, 2).map(subtitleFrom).filter(Boolean);
      return clipped(summaries.length ? `${summaries.join(" · ")}${value.length > 2 ? ` · ${value.length} total` : ""}` : `${value.length} items`, 300);
    }
    const item = record(value);
    if (!Object.keys(item).length) return "";
    const prose = first(item, "main_hypothesis", "research_question", "researchQuestion", "rationale", "background", "summary", "description", "reported_result", "observed_result", "result", "question", "title", "name", "measure");
    const lead = prose === value ? "" : subtitleFrom(prose);
    const type = text(item.type);
    const factors = list(item.factors).length;
    const sample = item.n === undefined ? "" : `n=${text(item.n)}`;
    const population = subtitleFrom(item.population);
    const stats = [item.estimate === undefined ? "" : `estimate ${text(item.estimate)}`,
      item.p_value === undefined ? "" : `p=${text(item.p_value)}`].filter(Boolean);
    return clipped([lead || type || sample || population, factors ? `${factors} factors` : "", ...stats].filter(Boolean).join(" · "), 300);
  };
  const add = (id: string, kind: Entity["kind"], label: string, description: string, fields: Entity["fields"], subtitle: string) => {
    const index = entities.length;
    entities.push({ id, kind, title: label, subtitle: clipped(subtitle, 300), description: clipped(description, 12000), evidence,
      fields: fields.slice(0, 100).map(field => ({ ...field, name: clipped(field.name, 200), value: clipped(field.value, 4000) })),
      x: 35 + index % 3 * 270, y: 35 + Math.floor(index / 3) * 160, w: 235, h: 115 });
  };
  const field = (name: string, value: unknown, status: "implementation" | "unresolved" = "implementation") => {
    const rendered = readable(value);
    return { name, value: rendered, status: /\bNEED_INPUT\b/.test(rendered) ? "unresolved" as const : status };
  };
  const present = (value: unknown) => value !== undefined && value !== null && value !== "" &&
    (!Array.isArray(value) || value.length > 0) && (typeof value !== "object" || Array.isArray(value) || Object.keys(record(value)).length > 0);
  const firstPresent = (...values: unknown[]) => values.find(present);
  const sourceField = (name: string, value: unknown) => field(name, present(value) ? value : "NEED_INPUT: not specified in package", present(value) ? "implementation" : "unresolved");
  const background = first(overview, "background", "rationale", "research_question", "researchQuestion", "description")
    ?? first(specification, "background", "rationale", "research_question", "researchQuestion")
    ?? first(metadata, "background", "rationale", "research_question", "researchQuestion", "description")
    ?? index.description;
  const researchQuestion = first(overview, "research_question", "researchQuestion")
    ?? first(specification, "research_question", "researchQuestion")
    ?? first(metadata, "research_question", "researchQuestion");
  add("background", "background", "Background and research question", readable(background, 12000), [
    sourceField("Background or rationale", background),
    sourceField("Research question", researchQuestion),
  ], subtitleFrom(researchQuestion) || subtitleFrom(background) || "Background not specified in package");
  const explicitHypotheses = first(overview, "hypotheses", "main_hypothesis", "hypothesis")
    ?? first(specification, "hypotheses", "main_hypothesis", "hypothesis")
    ?? first(metadata, "hypotheses", "main_hypothesis", "hypothesis");
  const findingHypotheses = list(metadata.findings).map(raw => record(raw)).filter(item => present(item.main_hypothesis))
    .map(item => ({ finding_id: item.finding_id, main_hypothesis: item.main_hypothesis }));
  const hypotheses = firstPresent(explicitHypotheses, findingHypotheses);
  add("hypotheses", "hypothesis", "Hypotheses", readable(hypotheses, 12000), [
    sourceField("Source hypothesis (verify against paper)", hypotheses),
  ], subtitleFrom(hypotheses) || "Hypothesis not specified in package");
  const design = first(overview, "design", "study_design", "experimental_design") ?? specification.design ?? task.design;
  add("design", "design", "Study design and conditions", readable(design, 12000), [
    sourceField("Design", design),
    sourceField("Conditions", first(task, "conditions", "arms") ?? first(overview, "conditions", "arms") ?? record(design).conditions ?? record(design).factors),
  ], subtitleFrom(design) || subtitleFrom(first(task, "conditions", "arms")) || "Design not specified in package");
  const participantFlow = first(overview, "participant_flow", "participants") ?? specification.participants;
  const conditions = first(task, "conditions", "arms") ?? first(overview, "conditions") ?? record(specification.design).conditions;
  add("participants", "participants", "Participants and assignment", readable(participantFlow, 12000), [
    field("Participant flow", participantFlow ?? "Needs source review", participantFlow ? "implementation" : "unresolved"),
    field("Agent structure", first(task, "participant_structure", "agents", "roles") ?? "Needs source review", first(task, "participant_structure", "agents", "roles") ? "implementation" : "unresolved"),
    field("Conditions", conditions ?? "Needs source review", conditions ? "implementation" : "unresolved"),
  ], subtitleFrom(participantFlow) || "Participant flow needs source review");
  add("materials", "material", "Participant materials", readable(materials, 12000), [
    field("Material manifest", Object.keys(materials).length ? materials : "Needs source review", Object.keys(materials).length ? "implementation" : "unresolved"),
  ], Object.keys(materials).length ? `${Object.keys(materials).length} material entries` : "Materials need source review");
  const steps = [task.procedure, task.steps, task.stages, overview.procedure, overview.steps, overview.stages, specification.procedure]
    .map(procedureSteps).find(candidate => candidate.length > 0) ?? [];
  const procedure: StudySchema["procedure"] = steps.slice(0, 200).map((raw, index) => {
    const step = record(raw);
    return { id: `step-${index + 1}`, name: clipped((typeof raw === "string" ? raw : text(first(step, "name", "title", "stage"))) || `Step ${index + 1}`, 200),
      input: readable(first(step, "input", "inputs", "sees", "materials")), actor: clipped(readable(first(step, "actor", "role", "agent")), 1000),
      output: readable(first(step, "output", "outputs", "response")), evidence };
  });
  add("procedure", "procedure", "Procedure", readable(first(task, "procedure", "steps", "stages") ?? first(overview, "procedure", "participant_flow") ?? specification.procedure, 12000), [
    field("Steps", steps.length ? `${steps.length} package step(s)` : "Needs source review", steps.length ? "implementation" : "unresolved"),
    field("Inputs", first(task, "inputs", "input") ?? "Needs source review", first(task, "inputs", "input") ? "implementation" : "unresolved"),
    ...steps.map((step, index) => field(`Step ${index + 1} source definition`, step)),
  ], steps.length ? `${steps.length} steps${subtitleFrom(steps[0]) ? ` · ${subtitleFrom(steps[0])}` : ""}` : "Procedure needs source review");
  add("records", "record", "Session records", readable(first(task, "outputs", "output", "session_log"), 12000), [
    field("Outputs", first(task, "outputs", "output", "session_log") ?? "Needs source review", first(task, "outputs", "output", "session_log") ? "implementation" : "unresolved"),
  ], subtitleFrom(first(task, "outputs", "output", "session_log")) || "Recorded output needs source review");
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
  ], variables.length ? `${variables.length} variables · ${variables.slice(0, 2).map(variable => variable.name).join(" · ")}` : "Variables need source review");
  const analysis = first(overview, "analysis", "outcomes") ?? first(oldMetadata, "statistical_methods_used") ?? first(metadata, "statistical_methods_used");
  add("analysis", "analysis", "Analysis and evaluation", readable(analysis, 12000), [
    field("Evaluation file", getFile(files, "evaluation/evaluation.py")?.path ?? "Needs source review", getFile(files, "evaluation/evaluation.py") ? "implementation" : "unresolved"),
    field("Outcomes", first(overview, "outcomes", "findings") ?? specification.primary_outcomes ?? "Needs source review", first(overview, "outcomes", "findings") ?? specification.primary_outcomes ? "implementation" : "unresolved"),
    sourceField("Package finding summaries", firstPresent(overview.findings, specification.findings, metadata.findings)),
  ], subtitleFrom(analysis) || "Analysis rules need source review");
  // Legacy findings often carry only a hypothesis and planned tests. They are
  // not an observed result. Extract result-bearing fields only.
  const findingResults = list(firstPresent(overview.findings, specification.findings, metadata.findings)).map(raw => record(raw)).map(item => {
    const result = Object.fromEntries(["finding_id", "reported_result", "observed_result", "result", "results", "effect_size", "estimate", "statistic", "p_value"]
      .filter(key => present(item[key])).map(key => [key, item[key]]));
    return Object.keys(result).some(key => key !== "finding_id") ? result : undefined;
  }).filter(Boolean);
  const reportedResults = firstPresent(first(overview, "reported_results", "results"), first(specification, "reported_results", "results"),
    first(metadata, "reported_results", "results"), findingResults);
  const groundTruthResults = groundTruthObservations(groundTruth);
  const resultFields = [
    ...(present(reportedResults) ? [field("Reported observations or statistics (verify against paper)", reportedResults)] : []),
    ...groundTruthResults.map((result, index) => field(
      `${text(result.study_id) || "Study"} · ${text(result.finding_id) || "Finding"} · observation ${index + 1}`, result)),
  ];
  const results = firstPresent(reportedResults, groundTruthResults);
  add("results", "result", "Reported results", readable(results, 12000) || "Not reported in this package", resultFields,
    subtitleFrom(reportedResults) || (groundTruthResults.length ? `${groundTruthResults.length} package observations · verify against paper` : "Not reported in this package"));
  if (checklist.length) add("review", "analysis", "Researcher review needed", "Questions and missing information from audit/missing_information.json.",
    checklist.slice(0, 100).map((raw, index) => {
      const item = record(raw);
      return field(text(first(item, "field", "name")) || `Review item ${index + 1}`, { reason: item.reason, impact: item.impact, suggested_action: item.suggested_action }, "unresolved");
    }), `${checklist.length} review items`);
  const relations = [{ from: "background", to: "hypotheses", label: "motivates" }, { from: "hypotheses", to: "design", label: "informs" },
    { from: "design", to: "participants", label: "defines assignment for" }, { from: "design", to: "materials", label: "defines conditions for" },
    { from: "participants", to: "procedure", label: "takes part in" }, { from: "materials", to: "procedure", label: "provides input" },
    { from: "procedure", to: "records", label: "produces" }, { from: "records", to: "variables", label: "contains" },
    { from: "variables", to: "analysis", label: "is evaluated by" }, { from: "analysis", to: "results", label: "interprets" }];
  const model: StudySchema = { id: safeId(text(first(overview, "study_id", "id")) || text(specification.study_id) || title.toLowerCase().replace(/\s+/g, "-"), "pipeline-study"), title,
    source, entities, relations, procedure, variables };
  return validateStudyModel(model, { sources: document.sources });
}

/** Pure, bounded presentation of a complete HumanStudy-Bench package. */
export function adaptPipelinePackage(files: PackageFile[], document: StudioDocument): { model: StudySchema; artifacts: StudioArtifact[]; summary: string } {
  const validatedSidecar = sidecarModel(files, document);
  const model = validateStudyModel(withAuditIssues(validatedSidecar ?? fallbackModel(files, document), files, document), { sources: document.sources });
  const { artifacts, omitted } = packageArtifacts(files, document);
  const usedSidecar = !!validatedSidecar;
  let summary = `HumanStudy-Bench package: ${files.length} file(s); ${artifacts.length} available in Studio. ${usedSidecar ? "Validated studio-model.json sidecar used." : "Package mapped into a reviewable model; source evidence and missing choices require researcher review."}`;
  if (!usedSidecar && getFile(files, "studio-model.json")) summary += " The supplied studio-model.json did not pass validation; fallback mapping was used. Review the original sidecar in the package.";
  if (omitted.length) summary += ` Studio omitted ${omitted.length} file(s) because of format, validity, count, or size limits: ${omitted.join(", ")}. The complete package ZIP remains available.`;
  return { model, artifacts, summary: clipped(summary, 4000) };
}
