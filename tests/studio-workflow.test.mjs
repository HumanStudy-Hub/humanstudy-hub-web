import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";

const requireLocal = createRequire(import.meta.url);
const ts = requireLocal("typescript");
const JSZip = requireLocal("jszip");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!globalThis.crypto) globalThis.crypto = webcrypto;

function load(file, dependencies = {}) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const loadedModule = { exports: {} };
  const localRequire = id => dependencies[id] || requireLocal(id);
  new Function("require", "module", "exports", compiled)(localRequire, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

const validation = load("lib/studio/validation.ts");
class StudioError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const http = {
  StudioError,
  assertSameOrigin(request) { if (request.headers.get("origin") !== new URL(request.url).origin) throw new StudioError(403, "invalid_origin"); },
  isUuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value); },
  async readJsonBody(request) { return request.json(); },
  routeError(error) { return Response.json({ error: error instanceof StudioError ? error.code : "internal_error" }, { status: error instanceof StudioError ? error.status : 500 }); },
};
const agent = load("lib/studio/agent.ts", { "./http": http, "./validation": validation });
const nextServer = { NextResponse: { json: (data, options = {}) => Response.json(data, { status: options.status || 200 }) } };

const userId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const conversationId = "44444444-4444-4444-8444-444444444444";
const firstRequestId = "55555555-5555-4555-8555-555555555555";
const secondRequestId = "66666666-6666-4666-8666-666666666666";
const thirdRequestId = "77777777-7777-4777-8777-777777777777";
const fourthRequestId = "88888888-8888-4888-8888-888888888888";
const ctx = { user: { id: userId }, accessToken: "server-secret-access-token" };
const pdfBytes = new TextEncoder().encode("%PDF-1.4\nmock");
const source = { id: sourceId, name: "paper.pdf", path: `${userId}/${workspaceId}/${sourceId}.pdf`, mimeType: "application/pdf", size: pdfBytes.length, pages: [{ page: 1, text: "Participants read the instructions before the task." }], signedUrl: "https://private.invalid/secret-signed-url" };
const emptyModel = () => ({ id: "study", title: "Study", source: { title: "", authors: "", filename: "" }, entities: [], relations: [], procedure: [], variables: [] });
const modelWith = (entityId, quote = "") => ({ ...emptyModel(), entities: [{ id: entityId, kind: "participants", title: entityId, subtitle: "", description: "", evidence: { sourceId, page: 1, rects: [], quote }, fields: [{ name: "Recruitment", value: "Needs a decision", status: "unresolved" }], x: 10, y: 10, w: 200, h: 80 }] });
const instructions = { id: "participant-instructions", title: "Participant instructions", filename: "instructions.md", format: "markdown", kind: "instructions", content: "# Instructions\nRead the task before responding.", sourceIds: [sourceId] };
const analysisDraft = { id: "analysis-draft", title: "Analysis draft", filename: "analysis.py", format: "python", kind: "analysis", content: "# Draft only; unresolved analysis decisions remain.\n", sourceIds: [] };

test("empty study → chat proposal → explicit apply → historical references → export ZIP", async () => {
  let authenticated = true, saveCount = 0, providerCount = 0, sourceCancelled = false, oversizedSource = false;
  let workspace = { id: workspaceId, title: "Study", revision: 1, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), document: {
    version: 1, title: "Study", model: emptyModel(), sources: [source],
    annotations: [{ id: "note-1", sourceId, page: 1, rects: [], text: "instructions", kind: "text", comment: "Unlinked source note", entity: "", createdAt: new Date().toISOString() }],
    conversations: [], reviewResponses: { "people:field:0": { text: "Check recruitment", savedAt: new Date().toISOString() } },
  } };
  const auth = { async requireStudioUser() { if (!authenticated) throw new StudioError(401, "unauthorized"); return ctx; } };
  const store = {
    async getWorkspace(_ctx, id) { return id === workspaceId ? workspace : null; },
    async saveWorkspace(_ctx, id, document, expectedRevision) {
      if (id !== workspaceId) return { conflict: true, latest: null };
      if (workspace.revision !== expectedRevision) return { conflict: true, latest: workspace };
      saveCount++;
      workspace = { ...workspace, revision: workspace.revision + 1, document };
      return workspace;
    },
  };
  http.studioFetch = async (_path, options) => {
    assert.equal(options.token, ctx.accessToken);
    if (!oversizedSource) return new Response(pdfBytes, { status: 200, headers: { "content-length": String(pdfBytes.length) } });
    return new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(pdfBytes.length + 1025)); },
      cancel() { sourceCancelled = true; },
    }), { status: 200 });
  };
  const dependencies = { "next/server": nextServer, "@/lib/studio/auth": auth, "@/lib/studio/agent": agent, "@/lib/studio/http": http, "@/lib/studio/store": store, "@/lib/studio/validation": validation, jszip: JSZip };
  const chat = load("app/api/studio/workspaces/[id]/chat/route.ts", dependencies);
  const proposals = load("app/api/studio/workspaces/[id]/proposals/route.ts", dependencies);
  const exportRoute = load("app/api/studio/workspaces/[id]/export/route.ts", dependencies);
  const workspaceRoute = load("app/api/studio/workspaces/[id]/route.ts", dependencies);
  const routeContext = { params: Promise.resolve({ id: workspaceId }) };
  const url = `https://studio.test/api/studio/workspaces/${workspaceId}`;
  const post = (suffix, body) => new Request(`${url}/${suffix}`, { method: "POST", headers: { origin: "https://studio.test", "content-type": "application/json" }, body: JSON.stringify(body) });
  const previousFetch = global.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY, previousModel = process.env.STUDIO_AGENT_MODEL;
  process.env.OPENROUTER_API_KEY = "test-provider-key"; process.env.STUDIO_AGENT_MODEL = "test-model";
  const providerOutputs = [
    JSON.stringify({ reply: "I propose a participants object and draft materials for review.", model: modelWith("people", "Participants read the instructions"), artifacts: [instructions, analysisDraft] }),
    JSON.stringify({ reply: "I propose a revised object.", model: modelWith("replacement") }),
  ];
  global.fetch = async () => { providerCount++; return Response.json({ choices: [{ message: { content: providerOutputs.shift() } }] }); };
  try {
    authenticated = false;
    const denied = await chat.POST(post("chat", { conversationId, text: "Help", revision: 1, requestId: firstRequestId }), routeContext);
    assert.equal(denied.status, 401);
    assert.equal((await exportRoute.GET(new Request(`${url}/export`), routeContext)).status, 401);
    assert.equal(saveCount, 0);
    authenticated = true;

    const first = await chat.POST(post("chat", { conversationId, text: "Describe the participants", revision: 1, requestId: firstRequestId }), routeContext);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.workspace.revision, 2);
    assert.equal(firstBody.workspace.document.model.entities.length, 0, "chat must not apply its proposal");
    assert.equal(firstBody.workspace.document.artifacts, undefined, "chat must not apply draft materials");
    const proposalId = firstBody.message.proposal.id;
    assert.equal(firstBody.message.proposal.status, "pending");
    assert.equal(firstBody.message.proposal.artifacts.length, 2);
    assert.equal(saveCount, 1);

    const repeated = await chat.POST(post("chat", { conversationId, text: "Describe the participants", revision: 1, requestId: firstRequestId }), routeContext);
    assert.equal((await repeated.json()).idempotent, true);
    assert.equal(providerCount, 1);
    assert.equal(saveCount, 1);
    const stale = await chat.POST(post("chat", { conversationId, text: "Another question", revision: 1, requestId: secondRequestId }), routeContext);
    assert.equal(stale.status, 409);
    assert.equal(providerCount, 1);
    const staleDecision = await proposals.POST(post("proposals", { proposalId, decision: "apply", revision: 1 }), routeContext);
    assert.equal(staleDecision.status, 409);
    assert.equal(saveCount, 1);

    const applied = await proposals.POST(post("proposals", { proposalId, decision: "apply", revision: 2 }), routeContext);
    assert.equal(applied.status, 200);
    assert.equal((await applied.json()).workspace.document.model.entities[0].id, "people");
    assert.equal(workspace.revision, 3);
    assert.equal(workspace.document.annotations[0].entity, "");
    assert.equal(workspace.document.artifacts[0].content, instructions.content);

    providerOutputs.unshift("malformed provider JSON");
    const malformed = await chat.POST(post("chat", { conversationId, text: "Revise again", revision: 3, requestId: secondRequestId }), routeContext);
    assert.equal(malformed.status, 502);
    assert.equal(saveCount, 2, "invalid provider output must not append a message or save");
    assert.equal(workspace.revision, 3);

    const second = await chat.POST(post("chat", { conversationId, text: "Replace the current object", modelAnchor: { kind: "objects", entityIds: ["people"] }, revision: 3, requestId: secondRequestId }), routeContext);
    assert.equal(second.status, 200);
    const secondProposalId = (await second.json()).message.proposal.id;
    assert.equal(workspace.revision, 4);
    const replaced = await proposals.POST(post("proposals", { proposalId: secondProposalId, decision: "apply", revision: 4 }), routeContext);
    assert.equal(replaced.status, 200);
    assert.equal(workspace.document.model.entities[0].id, "replacement");
    assert.equal(workspace.document.conversations[0].selected, "replacement");
    assert.equal(workspace.document.conversations[0].modelAnchor, null);
    assert.deepEqual(workspace.document.conversations[0].messages.find(m => m.id === secondRequestId).modelAnchor.entityIds, ["people"], "historical anchor must remain");
    assert.equal(workspace.document.reviewResponses["people:field:0"].text, "Check recruitment");
    assert.equal(workspace.document.artifacts[0].content, instructions.content, "model-only proposal preserves materials");

    providerOutputs.push(JSON.stringify({ reply: "I propose a revision to the materials only.", artifacts: [{ ...instructions, content: "# Revised instructions\nAwait approval." }, analysisDraft] }));
    const materialsOnly = await chat.POST(post("chat", { conversationId, text: "Revise the instructions", revision: 5, requestId: thirdRequestId }), routeContext);
    assert.equal(materialsOnly.status, 200);
    const materialsProposal = (await materialsOnly.json()).message.proposal;
    assert.equal(materialsProposal.model.entities[0].id, "replacement", "artifact-only proposal carries the current model");
    assert.equal(materialsProposal.changesModel, false);
    assert.equal(workspace.document.artifacts[0].content, instructions.content, "materials stay draft before approval");
    const newerModel = modelWith("later-model");
    const newerDocument = { ...workspace.document, model: newerModel, conversations: workspace.document.conversations.map(conversation => ({ ...conversation, selected: "later-model", modelAnchor: null })) };
    const modelPatch = await workspaceRoute.PATCH(post("", { document: newerDocument, expectedRevision: 6 }), routeContext);
    assert.equal(modelPatch.status, 200);
    assert.equal(workspace.revision, 7);
    const appliedMaterials = await proposals.POST(post("proposals", { proposalId: materialsProposal.id, decision: "apply", revision: 7 }), routeContext);
    assert.equal(appliedMaterials.status, 200);
    assert.equal(workspace.document.model.entities[0].id, "later-model", "applying an older artifact-only proposal must retain the latest model");
    const revisedInstructions = "# Revised instructions\nAwait approval.";
    assert.equal(workspace.document.artifacts[0].content, revisedInstructions);

    providerOutputs.push(JSON.stringify({ reply: "Here is another draft of the materials.", artifacts: [{ ...instructions, content: "# Rejected revision\nDo not apply." }, analysisDraft] }));
    const anotherDraft = await chat.POST(post("chat", { conversationId, text: "Try another wording", revision: 8, requestId: fourthRequestId }), routeContext);
    assert.equal(anotherDraft.status, 200);
    const rejectedProposalId = (await anotherDraft.json()).message.proposal.id;
    const rejected = await proposals.POST(post("proposals", { proposalId: rejectedProposalId, decision: "reject", revision: 9 }), routeContext);
    assert.equal(rejected.status, 200);
    assert.equal(workspace.document.artifacts[0].content, revisedInstructions, "rejection preserves applied material");
    assert.equal(workspace.document.conversations[0].messages.find(message => message.proposal?.id === rejectedProposalId).proposal.status, "rejected");
    const reloaded = await workspaceRoute.GET(new Request(url), routeContext);
    assert.equal(reloaded.status, 200);
    assert.equal((await reloaded.json()).workspace.document.artifacts[0].content, revisedInstructions, "saved materials survive a fresh GET");

    const exported = await exportRoute.GET(new Request(`${url}/export`), routeContext);
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition"), /attachment/);
    const zip = await JSZip.loadAsync(await exported.arrayBuffer());
    const savedDocument = JSON.parse(await zip.file("document.json").async("string"));
    const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
    assert.equal(savedDocument.model.entities[0].id, "later-model");
    assert.equal(savedDocument.conversations[0].messages.length, 8);
    assert.equal(savedDocument.annotations[0].entity, "");
    assert.equal(manifest.revision, 10);
    assert.equal(savedDocument.artifacts.length, 2);
    assert.equal(manifest.auxiliaryMaterials.length, 2);
    assert.equal(await zip.file("materials/participant-instructions/instructions.md").async("string"), revisedInstructions);
    assert.equal(await zip.file("materials/analysis-draft/analysis.py").async("string"), analysisDraft.content);
    assert.equal(await zip.file(`source-files/${sourceId}.pdf`).async("string"), "%PDF-1.4\nmock");
    const allText = await Promise.all(Object.values(zip.files).filter(file => !file.dir && !file.name.endsWith(".pdf")).map(file => file.async("string")));
    assert.ok(allText.every(text => !text.includes(ctx.accessToken) && !text.includes("secret-signed-url")), "ZIP must not expose authentication or signed URLs");

    oversizedSource = true;
    const bounded = await exportRoute.GET(new Request(`${url}/export`), routeContext);
    assert.equal(bounded.status, 200);
    const boundedZip = await JSZip.loadAsync(await bounded.arrayBuffer());
    const boundedManifest = JSON.parse(await boundedZip.file("manifest.json").async("string"));
    assert.equal(boundedZip.file(`source-files/${sourceId}.pdf`), null);
    assert.match(boundedManifest.sourceFiles[0].reason, /could not be included/);
    assert.equal(sourceCancelled, true);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.STUDIO_AGENT_MODEL; else process.env.STUDIO_AGENT_MODEL = previousModel;
  }
});
