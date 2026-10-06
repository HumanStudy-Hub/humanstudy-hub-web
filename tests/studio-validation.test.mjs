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
  const localRequire = id => dependencies[id] || requireLocal(id);
  new Function("require", "module", "exports", compiled)(localRequire, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const conversationTree = load("lib/studio/conversation-tree.ts");
const resources = load("lib/studio/resources.ts");
const validation = load("lib/studio/validation.ts", { "./conversation-tree": conversationTree, "./resources": resources });
const evidence = (sourceId, quote = "") => ({ sourceId, page: 1, rects: [], quote });
const emptyModel = () => ({ id: "study", title: "Untitled study", source: { title: "", authors: "", filename: "" }, entities: [], relations: [], procedure: [], variables: [] });
const source = { id: "source-1", name: "paper.pdf", path: "owner/workspace/source-1.pdf", mimeType: "application/pdf", size: 100, pages: [{ page: 1, text: "Participants read the instructions before the task." }] };
const document = () => ({ version: 1, title: "Untitled study", model: emptyModel(), sources: [source], annotations: [], conversations: [], reviewResponses: {} });

test("resource inclusion is reversible metadata and auxiliary files cannot fabricate parsed PDF text", () => {
  const draft = document();
  draft.sources.push({ id: "resource-1", name: "survey.docx", path: "owner/workspace/resource-1.docx", mimeType: resources.sourceSpec("survey.docx").mimeType, kind: "resource", size: 100, includeInBuild: false });
  const saved = validation.validateStudioDocument(draft);
  assert.equal(saved.sources[1].includeInBuild, false);
  saved.sources[1].includeInBuild = true;
  assert.equal(validation.validateStudioDocument(saved).sources[1].includeInBuild, true);
  draft.sources[1].pages = [{ page: 1, text: "invented" }];
  assert.throws(() => validation.validateStudioDocument(draft), /do not have PDF page text/);
  delete draft.sources[1].pages;
  draft.sources[1].includeInBuild = "false";
  assert.throws(() => validation.validateStudioDocument(draft), /includeInBuild must be a boolean/);
});

test("empty generic model and conversation validate", () => {
  const draft = document();
  draft.conversations.push({ id: "conversation-1", title: "", updatedAt: new Date().toISOString(), messages: [], draft: "", modelAnchor: null, sourceSelection: null, selected: "" });
  draft.annotations.push({ id: "note-1", sourceId: source.id, page: 1, rects: [], text: "instructions", kind: "text", comment: "Check these instructions", entity: "", createdAt: new Date().toISOString() });
  assert.equal(validation.validateStudioDocument(draft).conversations[0].selected, "");
  assert.equal(validation.validateStudioDocument(draft).annotations[0].entity, "");
  assert.equal(validation.validateStudioDocument(draft).model.source.filename, "");
});

test("historical proposal and message references survive a new model; live annotation links still validate", () => {
  const draft = document();
  const oldModel = emptyModel();
  oldModel.entities.push({ id: "old", kind: "material", title: "Old input", subtitle: "", description: "", fields: [], x: 0, y: 0, w: 10, h: 10, evidence: evidence("removed-source", "old passage") });
  draft.model.entities.push({ id: "new", kind: "material", title: "New input", subtitle: "", description: "", fields: [], x: 0, y: 0, w: 10, h: 10, evidence: evidence(source.id) });
  draft.conversations.push({ id: "conversation-1", title: "History", updatedAt: new Date().toISOString(), draft: "", selected: "new", modelAnchor: null, sourceSelection: null, messages: [
    { id: "message-1", role: "agent", text: "Earlier proposal", createdAt: new Date().toISOString(), entityId: "old", modelAnchor: { kind: "objects", entityIds: ["old"] }, sourceSelection: { sourceId: "removed-source", page: 1, rects: [], text: "old passage", kind: "text" }, proposal: { id: "proposal-1", model: oldModel, summary: "Earlier interpretation", status: "rejected" } },
  ] });
  draft.reviewResponses["old:field:0"] = { text: "Needs another check", savedAt: new Date().toISOString() };
  const saved = validation.validateStudioDocument(draft);
  assert.equal(saved.conversations[0].messages[0].proposal.model.entities[0].id, "old");
  assert.equal(saved.conversations[0].messages[0].proposal.changesModel, undefined, "older proposals remain valid");
  assert.equal(saved.reviewResponses["old:field:0"].text, "Needs another check");
  draft.conversations[0].messages[0].proposal.changesModel = "false";
  assert.throws(() => validation.validateStudioDocument(draft), /changesModel must be a boolean/);
  draft.conversations[0].messages[0].proposal.changesModel = false;
  assert.equal(validation.validateStudioDocument(draft).conversations[0].messages[0].proposal.changesModel, false);
  draft.conversations[0].selected = "";
  assert.equal(validation.validateStudioDocument(draft).conversations[0].selected, "");
  draft.annotations.push({ id: "note-1", sourceId: source.id, page: 1, rects: [], text: "", kind: "region", comment: "Still linked to old", entity: "old", createdAt: new Date().toISOString() });
  assert.throws(() => validation.validateStudioDocument(draft), /missing entity/);
});

test("model validation rejects dangling relations and impossible source pages", () => {
  const model = emptyModel();
  model.relations.push({ from: "missing", to: "other", label: "requires" });
  assert.throws(() => validation.validateStudyModel(model), /missing entity/);
  model.relations = [];
  model.entities.push({ id: "people", kind: "participants", title: "People", subtitle: "", description: "", fields: [], x: 0, y: 0, w: 10, h: 10, evidence: { ...evidence(source.id), page: 2 } });
  assert.throws(() => validation.validateStudyModel(model, { allowedPages: new Set([1]) }), /page does not exist/);
});

test("auxiliary materials enforce safe names, formats, bounds and live source IDs", () => {
  const material = { id: "analysis-draft", title: "Analysis draft", filename: "analysis.py", format: "python", kind: "analysis", content: "# Draft only\n", sourceIds: [source.id] };
  assert.deepEqual(validation.validateStudioArtifacts([material], [source]), [material]);
  assert.throws(() => validation.validateStudioArtifacts([{ ...material, filename: "../analysis.py" }], [source]), /safe basename/);
  assert.throws(() => validation.validateStudioArtifacts([{ ...material, filename: "analysis.txt" }], [source]), /matching format extension/);
  assert.throws(() => validation.validateStudioArtifacts([{ ...material, sourceIds: ["retired-source"] }], [source]), /missing source/);
  assert.deepEqual(validation.validateStudioArtifacts([{ ...material, sourceIds: ["retired-source"] }], [source], { historical: true })[0].sourceIds, ["retired-source"]);
  assert.throws(() => validation.validateStudioArtifacts([{ ...material, format: "json", filename: "analysis.json", content: "{broken" }], [source]), /valid JSON/);
});

test("single-source citations gain a stable identity before another PDF is attached", () => {
  const draft=document();
  draft.model.entities.push({id:"people",kind:"participants",title:"People",subtitle:"",description:"",fields:[],x:0,y:0,w:10,h:10,evidence:{page:1,rects:[],quote:"Participants"}});
  const saved=validation.validateStudioDocument(draft);
  assert.equal(saved.model.entities[0].evidence.sourceId,source.id);
  saved.sources.push({...source,id:"source-2"});
  assert.doesNotThrow(()=>validation.validateStudioDocument(saved));
});
