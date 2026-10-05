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
const validation = load("lib/studio/validation.ts");
class StudioError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const agent = load("lib/studio/agent.ts", { "./http": { StudioError }, "./validation": validation });
const evidence = (sourceId, quote = "") => ({ sourceId, page: 1, rects: [], quote });
const emptyModel = () => ({ id: "study", title: "Untitled study", source: { title: "", authors: "", filename: "" }, entities: [], relations: [], procedure: [], variables: [] });
const source = { id: "source-1", name: "paper.pdf", path: "owner/workspace/source-1.pdf", mimeType: "application/pdf", size: 100, pages: [{ page: 1, text: "Participants read the instructions before the task." }] };
const document = () => ({ version: 1, title: "Untitled study", model: emptyModel(), sources: [source], annotations: [], conversations: [], reviewResponses: {} });

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

test("citation verification accepts OCR text and rejects invented quotes", () => {
  const model = emptyModel();
  model.entities.push({ id: "people", kind: "participants", title: "People", subtitle: "", description: "", fields: [], x: 0, y: 0, w: 10, h: 10, evidence: evidence(source.id, "Participants read the instructions") });
  assert.doesNotThrow(() => agent.verifyProposedEvidence(model, emptyModel(), [source]));
  model.entities[0].evidence.rects = [{ x: 1, y: 1, w: 10, h: 10 }];
  assert.throws(() => agent.verifyProposedEvidence(model, emptyModel(), [source]), error => error.code === "invalid_agent_citation");
  model.entities[0].evidence.rects = [];
  model.entities[0].evidence.quote = "Participants received a random assignment";
  assert.throws(() => agent.verifyProposedEvidence(model, emptyModel(), [source]), error => error.code === "invalid_agent_citation");
});

test("unconfigured agent returns 503 and never calls provider", async () => {
  const key = process.env.OPENROUTER_API_KEY, model = process.env.STUDIO_AGENT_MODEL, fallback = process.env.PERSONA_DESIGNER_MODEL;
  const previousFetch = global.fetch;
  delete process.env.OPENROUTER_API_KEY; delete process.env.STUDIO_AGENT_MODEL; delete process.env.PERSONA_DESIGNER_MODEL;
  global.fetch = () => { throw new Error("must not fetch"); };
  try { await assert.rejects(agent.generateStudyReply(document(), "conversation-1", "Help", null, null), error => error.status === 503); }
  finally { global.fetch = previousFetch; if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key; if (model === undefined) delete process.env.STUDIO_AGENT_MODEL; else process.env.STUDIO_AGENT_MODEL = model; if (fallback === undefined) delete process.env.PERSONA_DESIGNER_MODEL; else process.env.PERSONA_DESIGNER_MODEL = fallback; }
});

test("malformed provider JSON is rejected without a fabricated answer", async () => {
  const key = process.env.OPENROUTER_API_KEY, model = process.env.STUDIO_AGENT_MODEL;
  const previousFetch = global.fetch;
  process.env.OPENROUTER_API_KEY = "test-key"; process.env.STUDIO_AGENT_MODEL = "test-model";
  global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "not json" } }] }) });
  try { await assert.rejects(agent.generateStudyReply(document(), "conversation-1", "Help", null, null), error => error.code === "invalid_agent_response"); }
  finally { global.fetch = previousFetch; if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key; if (model === undefined) delete process.env.STUDIO_AGENT_MODEL; else process.env.STUDIO_AGENT_MODEL = model; }
});

test("agent receives the complete model schema and visible OCR truncation markers", async () => {
  const key = process.env.OPENROUTER_API_KEY, model = process.env.STUDIO_AGENT_MODEL;
  const previousFetch = global.fetch;
  process.env.OPENROUTER_API_KEY = "test-key"; process.env.STUDIO_AGENT_MODEL = "test-model";
  const draft = document();
  draft.sources[0].pages[0].text = "A".repeat(3600);
  draft.artifacts = [{ id: "instructions", title: "Instructions", filename: "instructions.md", format: "markdown", kind: "instructions", content: "# Draft", sourceIds: [source.id] }];
  let payload;
  global.fetch = async (_url, options) => { payload = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"reply":"The source detail needs review."}' } }] }) }; };
  try {
    const result = await agent.generateStudyReply(draft, "conversation-1", "Review the procedure", null, null);
    assert.equal(result.reply, "The source detail needs review.");
    assert.match(payload.messages[0].content, /entity\.kind must be one of participants/);
    assert.match(payload.messages[0].content, /FULL replacement list/);
    const context = JSON.parse(payload.messages[1].content.match(/<studio-context>\n([\s\S]*?)\n<\/studio-context>/)[1]);
    assert.deepEqual(context.currentModel, draft.model);
    assert.deepEqual(context.currentArtifacts, draft.artifacts);
    assert.equal(context.sourcePages[0].ocrTextTruncated, true);
  } finally { global.fetch = previousFetch; if (key === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = key; if (model === undefined) delete process.env.STUDIO_AGENT_MODEL; else process.env.STUDIO_AGENT_MODEL = model; }
});


test("single-source citations gain a stable identity before another PDF is attached", () => {
  const draft=document();
  draft.model.entities.push({id:"people",kind:"participants",title:"People",subtitle:"",description:"",fields:[],x:0,y:0,w:10,h:10,evidence:{page:1,rects:[],quote:"Participants"}});
  const saved=validation.validateStudioDocument(draft);
  assert.equal(saved.model.entities[0].evidence.sourceId,source.id);
  saved.sources.push({...source,id:"source-2"});
  assert.doesNotThrow(()=>validation.validateStudioDocument(saved));
});
