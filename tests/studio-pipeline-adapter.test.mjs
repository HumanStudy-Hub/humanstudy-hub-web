import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const requireLocal = createRequire(import.meta.url);
const ts = requireLocal("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function load(file, dependencies = {}) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", compiled)(id => dependencies[id] ?? requireLocal(id), loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const conversationTree = load("lib/studio/conversation-tree.ts");
const resources = load("lib/studio/resources.ts");
const validation = load("lib/studio/validation.ts", { "./conversation-tree": conversationTree, "./resources": resources });
const { adaptPipelinePackage } = load("lib/studio/pipeline-adapter.ts", { "./validation": validation });
const source = { id: "paper", name: "paper.pdf", path: "owner/paper.pdf", mimeType: "application/pdf", size: 10,
  pages: [{ page: 2, text: "Participants read the instructions before answering." }] };
const document = { version: 1, title: "Paper", model: { id: "old", title: "Old", source: { title: "", authors: "", filename: "" }, entities: [], relations: [], procedure: [], variables: [] },
  sources: [source], annotations: [], conversations: [], reviewResponses: {} };
const file = (path, value) => ({ path: `paper-slug/${path}`, content: typeof value === "string" ? value : JSON.stringify(value) });

test("maps pipeline contract into a bounded model and unresolved review checklist", () => {
  const files = [
    file("study.json", { study_id: "paper-study", title: "Paper Study", participant_flow: "Recruit, assign, then survey", outcomes: [{ name: "Accuracy", unit: "percent" }] }),
    file("source/paper_metadata.json", { title: "Paper Study", authors: ["A. Author", "B. Author"] }),
    file("materials/materials.json", { conditions: [{ name: "control", instructions: "Read this" }] }),
    file("task/task.json", { conditions: ["control", "treatment"], steps: [{ name: "Survey", input: "Questions", actor: "participant", output: "Answer" }], outputs: [{ name: "answer", type: "text" }, { name: "scale", type: "NEED_INPUT" }] }),
    file("audit/missing_information.json", [{ study: "1", field: "Exact wording", reason: "Not printed", impact: "Cannot verify fidelity", suggested_action: "Find original instrument" }]),
    file("task/adapter.py", "def run_sessions(llm, seed, n, arms=None):\n    return []\n"),
  ];
  const result = adaptPipelinePackage(files, document);
  validation.validateStudyModel(result.model, { sources: document.sources });
  validation.validateStudioArtifacts(result.artifacts, document.sources);
  assert.equal(result.model.title, "Paper Study");
  assert.equal(result.model.procedure[0].input, "Questions");
  assert.equal(result.model.variables.some(variable => variable.name === "Accuracy"), true);
  assert.equal(result.model.variables.find(variable => variable.name === "scale").status, "unresolved");
  assert.equal(result.model.entities.find(entity => entity.id === "review").fields[0].status, "unresolved");
  assert.match(result.model.reviewIssues?.[0].id, /^audit-[0-9a-f]{8}$/);
  assert.deepEqual({ ...result.model.reviewIssues?.[0], id: "audit-id" }, { id: "audit-id", title: "Exact wording", severity: "check", study: "1", field: "Exact wording", reason: "Not printed", impact: "Cannot verify fidelity", suggestedAction: "Find original instrument" });
  assert.equal(result.model.entities.every(entity => entity.evidence.quote === "" && entity.evidence.rects.length === 0), true);
  assert.equal(result.artifacts.length, files.length);
});

test("uses valid sidecar and removes unsupported evidence and rectangles", () => {
  const evidence = { sourceId: "paper", page: 2, rects: [{ x: 1, y: 1, w: 3, h: 3 }], quote: "Participants read the instructions" };
  const sidecar = { ...document.model, id: "sidecar", title: "Curated model", source: { title: "Paper", authors: "", filename: "paper.pdf" },
    entities: [{ id: "step", kind: "procedure", title: "Read", subtitle: "", description: "Read", evidence, fields: [], x: 0, y: 0, w: 10, h: 10 },
      { id: "reported-result", kind: "result", title: "Result", subtitle: "", description: "", evidence: { ...evidence, quote: "Unsupported result" }, fields: [], x: 20, y: 0, w: 10, h: 10 }],
    procedure: [{ id: "read", name: "Read", input: "instructions", actor: "participant", output: "answer", evidence }] };
  const result = adaptPipelinePackage([file("studio-model.json", sidecar)], document);
  assert.equal(result.model.title, "Curated model");
  assert.equal(result.model.entities[0].evidence.quote, evidence.quote);
  assert.deepEqual(result.model.entities[0].evidence.rects, []);
  assert.equal(result.model.entities[1].evidence.quote, "");
  assert.deepEqual(result.model.entities[1].evidence.rects, []);
  assert.match(result.summary, /sidecar used/);
  const changed = structuredClone(sidecar);
  changed.entities[0].evidence.quote = "Text absent from PDF";
  changed.procedure[0].evidence.page = 9;
  const invalid = adaptPipelinePackage([file("studio-model.json", changed)], document);
  assert.notEqual(invalid.model.title, "Curated model", "invalid sidecar falls back to package mapping");
});

test("omits oversized or unsupported Studio artifacts and names them in summary", () => {
  const files = [file("study.json", { title: "Sample" }), file("task/adapter.py", "x".repeat(100_001)), file("notes.bin", "binary")];
  const result = adaptPipelinePackage(files, document);
  assert.deepEqual(result.artifacts.map(item => item.filename), ["study.json"]);
  assert.match(result.summary, /task\/adapter.py/);
  assert.match(result.summary, /notes.bin/);
  assert.match(result.summary, /complete package ZIP remains available/);
});

test("maps legacy study package specification without inventing citations", () => {
  const files = [
    file("index.json", { title: "Legacy experiment", authors: ["Researcher"] }),
    file("source/specification.json", { study_id: "legacy-study", participants: { experimental: { n: 20 } },
      design: { conditions: [{ name: "control" }, { name: "treatment" }] },
      procedure: [{ stage: 1, name: "Recruit", details: "Invite participants" }],
      independent_variables: [{ name: "Condition", levels: ["control", "treatment"] }],
      primary_outcomes: [{ name: "Completion", measurement: "binary" }] }),
    file("source/metadata.json", { statistical_methods_used: ["Difference in proportions"] }),
    file("source/materials/instructions.json", { instruction: "Start" }),
  ];
  const result = adaptPipelinePackage(files, document);
  assert.equal(result.model.id, "legacy-study");
  assert.equal(result.model.source.authors, "Researcher");
  assert.deepEqual(result.model.variables.map(item => item.name), ["Condition", "Completion"]);
  assert.equal(result.model.procedure[0].name, "Recruit");
  assert.equal(result.model.entities.find(item => item.id === "materials").fields[0].status, "implementation");
  assert.equal(result.model.entities.every(item => item.evidence.quote === ""), true);
});

test("legacy findings preserve hypotheses without turning planned tests into reported results", () => {
  const legacyBackground = "Evidence from four studies demonstrates that social observers tend to perceive a “false consensus” with respect to the relative commonness of their own responses.";
  const legacyHypothesis = "Subjects who 'choose' a particular hypothetical response will rate that response as more probable for 'people in general' than will subjects who 'choose' the alternative response.";
  const files = [
    file("index.json", { title: "Legacy study", description: legacyBackground }),
    file("source/metadata.json", { findings: [{ finding_id: "F1", main_hypothesis: legacyHypothesis, tests: [{ test_name: "ANOVA" }] }] }),
    file("source/specification.json", { design: { type: "Between-Subjects", factors: [{ name: "Choice", levels: ["A", "B"] }] } }),
  ];
  const model = adaptPipelinePackage(files, document).model;
  assert.equal(model.entities.find(entity => entity.kind === "background").subtitle, legacyBackground);
  assert.equal(model.entities.find(entity => entity.kind === "hypothesis").subtitle, legacyHypothesis);
  assert.match(model.entities.find(entity => entity.kind === "background").fields[0].value, /false consensus/);
  assert.match(model.entities.find(entity => entity.kind === "hypothesis").fields[0].value, /particular hypothetical response/);
  assert.match(model.entities.find(entity => entity.kind === "design").fields[0].value, /Between-Subjects/);
  assert.match(model.entities.find(entity => entity.kind === "design").subtitle, /Between-Subjects/);
  assert.deepEqual(model.entities.find(entity => entity.kind === "result").fields, []);
  assert.equal(model.entities.find(entity => entity.kind === "result").subtitle, "Not reported in this package");
  assert.equal(model.reviewIssues, undefined);
  assert.equal(model.entities.every(entity => entity.evidence.quote === ""), true);
});

test("fallback preserves explicit reported results while marking absent hypotheses unresolved", () => {
  const model = adaptPipelinePackage([file("study.json", {
    title: "Outcome study", rationale: "Prior work", research_question: "Does the task change outcomes?",
    conditions: ["control", "treatment"], results: [{ measure: "accuracy", estimate: 0.2, p_value: 0.03 }],
  })], document).model;
  assert.equal(model.entities.find(entity => entity.kind === "hypothesis").fields[0].status, "unresolved");
  assert.match(model.entities.find(entity => entity.kind === "result").fields[0].value, /"estimate":0.2/);
  assert.equal(model.entities.find(entity => entity.kind === "result").fields[0].status, "implementation");
  assert.equal(model.relations.some(relation => relation.from === "analysis" && relation.to === "results"), true);
});

test('keeps live-run categorical variables with null units and list references', () => {
  const sidecar={...document.model,id:'live-run',title:'Framing',entities:[{id:'choice',kind:'variable',title:'Choice',subtitle:'',description:'',evidence:{sourceId:'paper',page:2,rects:[],quote:''},fields:[],x:0,y:0,w:10,h:10}],variables:[{id:'choice-variable',name:'Choice',role:'dependent',type:'categorical',unit:null,producedBy:'record',usedBy:['compare','report'],definition:'Selected option',status:'reported',entity:'choice'}]};
  const result=adaptPipelinePackage([file('studio-model.json',sidecar)],document);
  assert.equal(result.model.id,'live-run');
  assert.equal(result.model.variables[0].unit,'');
  assert.equal(result.model.variables[0].usedBy,'compare, report');
  assert.match(result.summary,/sidecar used/);
});

test('keeps explicit review issues and audit provenance while removing unverified quotes', () => {
  const sidecar={...document.model,id:'reviewed',reviewIssues:[
    {id:'choice',title:'Choose allocation',severity:'decision',entity:undefined,study:'Experiment 1',field:'allocation',reason:'Source omits assignment rule',impact:'Cannot assign arms reproducibly',suggestedAction:'Researcher decides',sourcePointer:'Methods',evidence:{sourceId:'paper',page:2,rects:[{x:2,y:3,w:4,h:5}],quote:'Not in the source'}},
  ]};
  const files=[file('studio-model.json',sidecar),file('audit/missing_information.json',[
    {study:'Experiment 1',field:'allocation',reason:'Audit reason',impact:'Audit impact',suggested_action:'Audit action'},
    {study:'Experiment 2',field:'stopping rule',reason:'Not specified',impact:'Run length varies',suggested_action:'Define a stopping rule',severity:'blocking',source_pointer:'p. 2'},
  ])];
  const result=adaptPipelinePackage(files,document);
  assert.equal(result.model.reviewIssues?.length,2,'matching audit item does not duplicate a sidecar issue');
  assert.equal(result.model.reviewIssues?.[0].evidence?.quote,'');
  assert.deepEqual(result.model.reviewIssues?.[0].evidence?.rects,[]);
  assert.equal(result.model.reviewIssues?.[0].reason,'Audit reason','authoritative audit metadata survives sidecar deduplication');
  assert.equal(result.model.reviewIssues?.[1].severity,'blocking');
  assert.equal(result.model.reviewIssues?.[1].sourcePointer,'p. 2');
  assert.equal(result.model.reviewIssues?.[1].reason,'Not specified');
});

test('audit IDs survive reordering and change when the question changes', () => {
  const a={study:'One',field:'allocation',reason:'Rule absent',impact:'Cannot assign',suggested_action:'Decide'};
  const b={study:'Two',field:'stopping',reason:'Rule absent',impact:'Cannot stop',suggested_action:'Decide'};
  const read=items=>adaptPipelinePackage([file('audit/missing_information.json',items)],document).model.reviewIssues;
  const initial=read([a,b,a]);
  const reordered=read([b,a]);
  assert.equal(initial.length,2,'duplicate audit rows collapse');
  assert.equal(initial.find(issue=>issue.field==='allocation').id,reordered.find(issue=>issue.field==='allocation').id);
  assert.equal(initial.find(issue=>issue.field==='stopping').id,reordered.find(issue=>issue.field==='stopping').id);
  const changed=read([{...a,reason:'Different missing rule'},b]);
  assert.notEqual(initial.find(issue=>issue.field==='allocation').id,changed.find(issue=>issue.field==='allocation').id,
    'a response saved for the old question cannot mark the new one answered');
});
