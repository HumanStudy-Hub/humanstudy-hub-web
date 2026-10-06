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
  assert.equal(result.model.entities.every(entity => entity.evidence.quote === "" && entity.evidence.rects.length === 0), true);
  assert.equal(result.artifacts.length, files.length);
});

test("uses valid sidecar and removes unsupported evidence and rectangles", () => {
  const evidence = { sourceId: "paper", page: 2, rects: [{ x: 1, y: 1, w: 3, h: 3 }], quote: "Participants read the instructions" };
  const sidecar = { ...document.model, id: "sidecar", title: "Curated model", source: { title: "Paper", authors: "", filename: "paper.pdf" },
    entities: [{ id: "step", kind: "procedure", title: "Read", subtitle: "", description: "Read", evidence, fields: [], x: 0, y: 0, w: 10, h: 10 }],
    procedure: [{ id: "read", name: "Read", input: "instructions", actor: "participant", output: "answer", evidence }] };
  const result = adaptPipelinePackage([file("studio-model.json", sidecar)], document);
  assert.equal(result.model.title, "Curated model");
  assert.equal(result.model.entities[0].evidence.quote, evidence.quote);
  assert.deepEqual(result.model.entities[0].evidence.rects, []);
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

test('keeps live-run categorical variables with null units and list references', () => {
  const sidecar={...document.model,id:'live-run',title:'Framing',entities:[{id:'choice',kind:'variable',title:'Choice',subtitle:'',description:'',evidence:{sourceId:'paper',page:2,rects:[],quote:''},fields:[],x:0,y:0,w:10,h:10}],variables:[{id:'choice-variable',name:'Choice',role:'dependent',type:'categorical',unit:null,producedBy:'record',usedBy:['compare','report'],definition:'Selected option',status:'reported',entity:'choice'}]};
  const result=adaptPipelinePackage([file('studio-model.json',sidecar)],document);
  assert.equal(result.model.id,'live-run');
  assert.equal(result.model.variables[0].unit,'');
  assert.equal(result.model.variables[0].usedBy,'compare, report');
  assert.match(result.summary,/sidecar used/);
});
