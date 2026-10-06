import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";

const requireLocal = createRequire(import.meta.url);
const ts = requireLocal("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!globalThis.crypto) globalThis.crypto = webcrypto;
function load(file, dependencies = {}) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", compiled)(id => dependencies[id] ?? requireLocal(id), loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
class StudioError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const conversationTree = load("lib/studio/conversation-tree.ts");
const resources = load("lib/studio/resources.ts");
const validation = load("lib/studio/validation.ts", { "./conversation-tree": conversationTree, "./resources": resources });
const modelVersion = load("lib/studio/model-version.ts");
const ids = {
  owner: "11111111-1111-4111-8111-111111111111",
  workspace: "22222222-2222-4222-8222-222222222222",
  source: "33333333-3333-4333-8333-333333333333",
  otherSource: "88888888-8888-4888-8888-888888888888",
  conversation: "44444444-4444-4444-8444-444444444444",
  request: "55555555-5555-4555-8555-555555555555",
  next: "66666666-6666-4666-8666-666666666666",
};
const ctx = { user: { id: ids.owner }, accessToken: "private-token" };
const now = "2026-01-02T00:00:00.000Z";
const model = (title = "Draft") => ({ id: "study", title, source: { title: "", authors: "", filename: "" }, entities: [], relations: [], procedure: [], variables: [] });
const source = () => ({ id: ids.source, name: "paper.pdf", path: `${ids.owner}/${ids.workspace}/${ids.source}.pdf`, mimeType: "application/pdf", size: 12, pages: [{ page: 1, text: "Participants followed the instructions." }] });
const otherSource = () => ({ ...source(), id: ids.otherSource, name: "other.pdf", path: `${ids.owner}/${ids.workspace}/${ids.otherSource}.pdf` });
const document = (sources = [source()]) => ({ version: 1, title: "Study", model: model(), sources, annotations: [], conversations: [], reviewResponses: {} });
const nextServer = { NextResponse: { json: (data, options = {}) => Response.json(data, { status: options.status || 200, headers: options.headers }) } };
const jobId = `studio-${ids.workspace}-${ids.request}`;
const request = (suffix, body) => new Request(`https://studio.test/api/studio/workspaces/${ids.workspace}/${suffix}`, { method: "POST", headers: { origin: "https://studio.test", "content-type": "application/json" }, body: JSON.stringify(body) });
const input = (revision = 1, requestId = ids.request) => ({ conversationId: ids.conversation, requestId, text: "Build this study", revision, intent: "build" });
const routeContext = { params: Promise.resolve({ id: ids.workspace }) };

function harness(initial = document()) {
  let workspace = { id: ids.workspace, title: "Study", revision: 1, document: initial, created_at: now, updated_at: now };
  let configured = true, signing = `/object/sign/studio-sources/${source().path}?token=secret`, materialsSigning = null, dispatchError = null;
  let casConflict = false, reads = 0, lists = 0;
  const calls = [];
  const job = { id: jobId, status: "queued", message: "Waiting", updatedAt: now, progress: 0, packageReady: false };
  let turn = { requestId: ids.request, reply: "The paper does not report a sample size." };
  const github = {
    studioPipelineConfigured: () => configured,
    async createStudioPipelineJob(arg) { calls.push(["create", arg]); return { ...job, id: arg.id, message: "Waiting", studio: arg.identity }; },
    async dispatchStudioPipelineJob(arg) { calls.push(["dispatch", arg]); if (dispatchError) throw dispatchError; },
    async readOwnedStudioJob(id, identity) { reads++; calls.push(["read", id, identity]); return { ...job, id, packageReady:job.status==='review'?true:job.packageReady }; },
    async readOwnedStudioTurn(id, identity) { calls.push(["turn", id, identity]); return turn; },
    async listPackageFiles(id, identity) { lists++; calls.push(["list", id, identity]); return [{ path: "paper/study.json", content: Buffer.from(JSON.stringify({ title: "Pipeline study", participant_flow: "Read then answer" })) }, { path: "paper/studio-reply.md", content: Buffer.from("Generated package is ready.") }]; },
    async approveStage(id, decision, identity) { calls.push(["approve", id, decision, identity]); return job; },
    async retryStudioPipelineJob(id, identity, paperUrl, materialsUrl) { calls.push(["retry", id, identity, paperUrl, materialsUrl]); return { ...job, id, status: "queued", message: "Waiting for retry", updatedAt: new Date().toISOString() }; },
  };
  const store = {
    async getWorkspace(_ctx, id) { return id === ids.workspace ? workspace : null; },
    async saveWorkspace(_ctx, id, next, expected) {
      calls.push(["save", expected]);
      if (id !== ids.workspace || expected !== workspace.revision || casConflict) return { conflict: true, latest: workspace };
      workspace = { ...workspace, revision: workspace.revision + 1, document: next };
      return workspace;
    },
  };
  const http = {
    StudioError,
    assertSameOrigin(req) { if (req.headers.get("origin") !== new URL(req.url).origin) throw new StudioError(403, "invalid_origin"); },
    isUuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value); },
    async readJsonBody(req) { return req.json(); },
    routeError(error) { return Response.json({ error: error instanceof StudioError ? error.code : "internal_error" }, { status: error instanceof StudioError ? error.status : 500 }); },
    studioConfig() { return { url: "https://storage.test" }; },
    async studioFetch(path, options) { calls.push(["sign", path, options]); return Response.json({ signedURL: path.endsWith(".zip") && materialsSigning ? materialsSigning : signing }); },
    async upstreamJson(response) { return response.json(); },
  };
  const adapter = load("lib/studio/pipeline-adapter.ts", { "./validation": validation });
  const resourceServer = {
    ...load("lib/studio/resource-server.ts", { "./http": http, "./resources": resources }),
    async prepareStudioResourceArchive(_ctx, current, primaryId) {
      const sourceIds = current.document.sources.filter(item => item.id !== primaryId && item.includeInBuild !== false).map(item => item.id);
      return sourceIds.length ? { path: `${ids.owner}/${ids.workspace}/${ids.next}.zip`, url: "https://storage.test/materials.zip", sourceIds } : null;
    },
  };
  const pipeline = load("lib/studio/pipeline.ts", { "@/lib/github-jobs": github, "./http": http, "./store": store, "./pipeline-adapter": adapter, "./validation": validation, "./model-version": modelVersion, "./conversation-tree": conversationTree, "./resources": resources, "./resource-server": resourceServer });
  const auth = { async requireStudioUser() { return ctx; } };
  const deps = { "next/server": nextServer, "@/lib/studio/auth": auth, "@/lib/studio/http": http, "@/lib/studio/store": store, "@/lib/studio/validation": validation, "@/lib/studio/model-version": modelVersion, "@/lib/studio/pipeline": pipeline, "@/lib/github-jobs": github };
  const chat = load("app/api/studio/workspaces/[id]/chat/route.ts", deps);
  const sync = load("app/api/studio/workspaces/[id]/pipeline/route.ts", deps);
  const proposals = load("app/api/studio/workspaces/[id]/proposals/route.ts", deps);
  const workspaceRoute = load("app/api/studio/workspaces/[id]/route.ts", deps);
  return { chat, sync, proposals, workspaceRoute, pipeline, github, job, calls, get workspace() { return workspace; }, set workspace(value) { workspace = value; }, get turn() {return turn;},set turn(value){turn=value;}, get reads() { return reads; }, get lists() { return lists; }, set configured(value) { configured = value; }, set signing(value) { signing = value; }, set materialsSigning(value) { materialsSigning = value; }, set dispatchError(value) { dispatchError = value; }, set casConflict(value) { casConflict = value; } };
}

test("discussion is the default and completes beside an in-flight package sync", async () => {
  const initial=document();
  initial.pipeline={jobId,requestId:ids.request,conversationId:ids.conversation,sourceId:ids.source,status:"running",message:"Building",updatedAt:now,kind:"sync",targetModelFingerprint:modelVersion.modelFingerprint(initial.model)};
  const h=harness(initial);
  const response=await h.chat.POST(request("chat",{...input(1,ids.next),intent:"discuss",text:"What sample size was reported?"}),routeContext);
  assert.equal(response.status,202);
  assert.equal(h.workspace.document.pipeline.status,"running");
  assert.equal(h.workspace.document.discussion.status,"queued");
  assert.equal(h.calls.find(call=>call[0]==="create")[1].request.mode,"discuss");
  h.job.status="complete";h.job.packageReady=false;h.turn={requestId:ids.next,reply:"The paper does not report a sample size."};
  h.github.readOwnedStudioJob=async id=>id===jobId?{...h.job,status:"running",packageReady:false}:{...h.job,id};
  const synced=await h.sync.POST(request("pipeline",{revision:h.workspace.revision}),routeContext);
  assert.equal(synced.status,200);
  assert.equal(h.workspace.document.conversations[0].messages.at(-1).text,h.turn.reply);
  assert.equal(h.workspace.document.pipeline.status,"running");
  const count=h.workspace.document.conversations[0].messages.length;
  await h.sync.POST(request("pipeline",{revision:h.workspace.revision}),routeContext);
  assert.equal(h.workspace.document.conversations[0].messages.length,count,"completion is idempotent");
});

test("a model-changing discussion proposal records its base model fingerprint", async () => {
  const h=harness();
  await h.chat.POST(request("chat",{...input(),intent:"discuss"}),routeContext);
  h.job.status="complete";h.job.packageReady=false;
  h.turn={requestId:ids.request,reply:"I suggest a more specific title.",model:model("Revised")};
  await h.sync.POST(request("pipeline",{revision:h.workspace.revision}),routeContext);
  const proposal=h.workspace.document.conversations[0].messages.at(-1).proposal;
  assert.equal(proposal.baseModelFingerprint,modelVersion.modelFingerprint(model()));
  assert.equal(proposal.jobId,jobId);
  assert.equal(proposal.changesModel,true);
  assert.equal(h.workspace.document.model.title,"Draft");
});

test("discussion proposals strip forged source quotes and rectangles while preserving layout", async () => {
  const h=harness();
  await h.chat.POST(request("chat",{...input(),intent:"discuss"}),routeContext);
  h.job.status="complete";h.job.packageReady=false;
  const forged=model("Proposed protocol");
  forged.entities=[{id:"participants",kind:"participants",title:"Participants",subtitle:"",description:"Discuss recruitment",evidence:{sourceId:ids.source,page:1,rects:[{x:10,y:10,w:20,h:10}],quote:"The paper verified 10,000 participants."},fields:[],x:345,y:210,w:180,h:90}];
  h.turn={requestId:ids.request,reply:"This is a tentative interpretation.",model:forged};
  const response=await h.sync.POST(request("pipeline",{revision:h.workspace.revision}),routeContext);
  assert.equal(response.status,200);
  const entity=h.workspace.document.conversations[0].messages.at(-1).proposal.model.entities[0];
  assert.equal(entity.evidence.quote,"");
  assert.deepEqual(entity.evidence.rects,[]);
  assert.equal(entity.evidence.sourceId,ids.source);
  assert.equal(entity.x,345);
  assert.equal(entity.y,210);
});

test("concurrent model edits stale a discussion proposal, but rejection stays available", async () => {
  const h=harness();
  await h.chat.POST(request("chat",{...input(),intent:"discuss"}),routeContext);
  h.workspace={...h.workspace,revision:h.workspace.revision+1,document:{...h.workspace.document,model:model("Researcher edit")}};
  h.job.status="complete";h.job.packageReady=false;
  h.turn={requestId:ids.request,reply:"Use a revised title.",model:model("Agent suggestion")};
  await h.sync.POST(request("pipeline",{revision:h.workspace.revision}),routeContext);
  const proposal=h.workspace.document.conversations[0].messages.at(-1).proposal;
  assert.equal(proposal.baseModelFingerprint,modelVersion.modelFingerprint(model()));
  const apply=await h.proposals.POST(request("proposals",{revision:h.workspace.revision,proposalId:proposal.id,decision:"apply"}),routeContext);
  assert.equal(apply.status,409);
  assert.equal((await apply.json()).error,"proposal_stale_model");
  const reject=await h.proposals.POST(request("proposals",{revision:h.workspace.revision,proposalId:proposal.id,decision:"reject"}),routeContext);
  assert.equal(reject.status,200);
  assert.equal(h.workspace.document.model.title,"Researcher edit");
});

test("a completed package sync tracks the accepted model without replacing it", async () => {
  const initial=document();
  const fingerprint=modelVersion.modelFingerprint(initial.model);
  initial.pipeline={jobId,requestId:ids.request,conversationId:ids.conversation,sourceId:ids.source,status:"running",message:"Building",updatedAt:now,kind:"sync",targetModelFingerprint:fingerprint};
  const h=harness(initial);
  h.job.status="review";
  const response=await h.sync.POST(request("pipeline",{revision:h.workspace.revision}),routeContext);
  assert.equal(response.status,200);
  assert.equal(h.workspace.document.model.title,"Draft");
  assert.equal(h.workspace.document.acceptedPackage.modelFingerprint,fingerprint);
  assert.equal(h.workspace.document.pipeline.status,"complete");
  assert.equal(h.calls.filter(call=>call[0]==="list").length,0,"sync output is not adapted into a model proposal");
  await h.sync.POST(request("pipeline",{revision:h.workspace.revision}),routeContext);
  assert.equal(h.workspace.document.pipeline.status,"complete","remote review does not regress accepted status");
});

test("autosave cannot erase a server discussion or proposal decision", async () => {
  const h=harness();
  await h.chat.POST(request("chat",{...input(),intent:"discuss"}),routeContext);
  h.job.status="complete";h.job.packageReady=false;h.turn={requestId:ids.request,reply:"Revise the title.",model:model("Agent suggestion")};
  await h.sync.POST(request("pipeline",{revision:h.workspace.revision}),routeContext);
  const original=h.workspace.document;
  const tampered={...original,discussion:undefined,conversations:original.conversations.map(c=>({...c,messages:c.messages.filter(m=>!m.proposal)}))};
  const patch=new Request(`https://studio.test/api/studio/workspaces/${ids.workspace}`,{method:"PATCH",headers:{origin:"https://studio.test","content-type":"application/json"},body:JSON.stringify({document:tampered,expectedRevision:h.workspace.revision})});
  const response=await h.workspaceRoute.PATCH(patch,routeContext);
  assert.equal(response.status,200);
  assert.equal(h.workspace.document.discussion.jobId,original.discussion.jobId);
  assert.equal(h.workspace.document.conversations[0].messages.at(-1).proposal.status,"pending");
});

test("an outdated package sync coalesces to the latest applied model", async () => {
  const initial=document();
  const oldFingerprint=modelVersion.modelFingerprint(initial.model);
  initial.model=model("Latest accepted model");
  initial.pipeline={jobId,requestId:ids.request,conversationId:ids.conversation,sourceId:ids.source,status:"running",message:"Building older package",updatedAt:now,kind:"sync",targetModelFingerprint:oldFingerprint};
  initial.conversations=[{id:ids.conversation,title:"Latest decision",draft:"",updatedAt:now,modelAnchor:null,sourceSelection:null,selected:"",messages:[{id:ids.next,role:"agent",text:"Use the revised model",createdAt:now,proposal:{id:ids.next,model:initial.model,summary:"Revised model",status:"applied",changesModel:true}}]}];
  const h=harness(initial);
  h.job.status="review";
  const response=await h.sync.POST(request("pipeline",{revision:h.workspace.revision}),routeContext);
  assert.equal(response.status,200);
  assert.equal(h.workspace.document.pipeline.status,"queued");
  assert.equal(h.workspace.document.pipeline.targetModelFingerprint,modelVersion.modelFingerprint(initial.model));
  assert.equal(h.calls.filter(call=>call[0]==="create").length,1);
});

test("chat requires a PDF and setup before signing or dispatch", async () => {
  const missing = harness(document([]));
  const paper = await missing.chat.POST(request("chat", input()), routeContext);
  assert.equal(paper.status, 400);
  assert.equal((await paper.json()).error, "paper_required");
  assert.deepEqual(missing.calls, []);
  const disabled = harness(); disabled.configured = false;
  const setup = await disabled.chat.POST(request("chat", input()), routeContext);
  assert.equal(setup.status, 503);
  assert.equal((await setup.json()).error, "pipeline_setup_required");
  assert.deepEqual(disabled.calls, []);
});

test("source signing is owner bound and invalid signed URLs never reserve or dispatch", async () => {
  const foreign = source(); foreign.path = `another-owner/${ids.workspace}/${ids.source}.pdf`;
  const invalidPath = harness(document([foreign]));
  assert.equal((await invalidPath.chat.POST(request("chat", input()), routeContext)).status, 403);
  assert.deepEqual(invalidPath.calls, []);
  for (const signed of ["https://evil.test/paper.pdf", "/object/sign/studio-sources/wrong.pdf?token=secret"]) {
    const h = harness(); h.signing = signed;
    const response = await h.chat.POST(request("chat", input()), routeContext);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, "invalid_service_response");
    assert.equal(h.calls[0][0], "sign");
    assert.equal(h.calls[0][2].token, ctx.accessToken);
    assert.deepEqual(h.calls.map(call => call[0]), ["sign"]);
  }
});

test("chat reserves by CAS before dispatch, queues without OpenRouter, and blocks duplicate work", async () => {
  const h = harness();
  const response = await h.chat.POST(request("chat", input()), routeContext);
  assert.equal(response.status, 202);
  assert.deepEqual(h.calls.map(call => call[0]), ["sign", "save", "create", "dispatch", "save"]);
  const created = h.calls.find(call => call[0] === "create")[1];
  assert.equal(created.id, jobId);
  assert.deepEqual(created.identity, { ownerId: ids.owner, workspaceId: ids.workspace, requestId: ids.request, conversationId: ids.conversation });
  assert.match(created.paperUrl, /^https:\/\/storage\.test\/storage\/v1\/object\/sign\/studio-sources\//);
  assert.equal(created.request.message, "Build this study");
  assert.equal(h.workspace.document.pipeline.status, "queued");
  assert.equal(h.workspace.document.model.title, "Draft");
  assert.deepEqual(h.workspace.document.conversations[0].messages.map(m => m.role), ["user"]);
  const duplicate = await h.chat.POST(request("chat", input(1)), routeContext);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).idempotent, true);
  assert.equal(h.calls.filter(call => call[0] === "dispatch").length, 1);
  const busy = await h.chat.POST(request("chat", input(3, ids.next)), routeContext);
  assert.equal(busy.status, 409);
  assert.equal((await busy.json()).error, "pipeline_busy");
  assert.equal(h.calls.filter(call => call[0] === "dispatch").length, 1);
});

test("chat persists a branch parent and message references in the pipeline request", async () => {
  const parentMessageId = "99999999-9999-4999-8999-999999999999";
  const sideConversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const siblingConversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const siblingMessageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const initial = document();
  initial.conversations.push({ id: ids.conversation, title: "Main", updatedAt: now, draft: "", modelAnchor: null, sourceSelection: null, selected: "",
    messages: [{ id: parentMessageId, role: "agent", text: "Fork here", createdAt: now }, { id: ids.next, role: "agent", text: "Later parent turn", createdAt: now }] });
  initial.conversations.push({ id: siblingConversationId, title: "Sibling", updatedAt: now, draft: "", modelAnchor: null, sourceSelection: null, selected: "", parent: { conversationId: ids.conversation, messageId: parentMessageId },
    messages: [{ id: siblingMessageId, role: "user", text: "Selected side-talk insight", createdAt: now, sourceSelection: { sourceId: ids.source, page: 1, rects: [], text: "Participants followed the instructions.", kind: "text" } }] });
  const h = harness(initial);
  const parent = { conversationId: ids.conversation, messageId: parentMessageId };
  const mergedFrom = { conversationId: siblingConversationId, messageId: siblingMessageId };
  const response = await h.chat.POST(request("chat", { ...input(), conversationId: sideConversationId, parent, replyTo: parent, mergedFrom }), routeContext);
  assert.equal(response.status, 202);
  const side = h.workspace.document.conversations.find(item => item.id === sideConversationId);
  assert.deepEqual(side.parent, parent);
  assert.deepEqual(side.messages[0].replyTo, parent);
  assert.deepEqual(side.messages[0].mergedFrom, mergedFrom);
  const sent = h.calls.find(call => call[0] === "create")[1].request;
  assert.deepEqual(sent.document.conversations.find(item => item.id === sideConversationId).parent, parent);
  assert.deepEqual(sent.document.conversations.map(item => [item.id, item.messages.map(message => message.id)]), [[ids.conversation, [parentMessageId]], [sideConversationId, [ids.request]]]);
  assert.deepEqual(sent.replyTo, parent);
  assert.deepEqual(sent.referencedMessages.map(item => [item.relation, item.message.text]), [["replyTo", "Fork here"], ["mergedFrom", "Selected side-talk insight"]]);
  assert.equal(sent.referencedMessages[1].message.sourceSelection.text, "Participants followed the instructions.");
});

test("chat rejects a missing branch parent before signing or saving", async () => {
  const h = harness();
  const response = await h.chat.POST(request("chat", { ...input(), parent: { conversationId: ids.conversation, messageId: ids.next } }), routeContext);
  assert.equal(response.status, 400);
  assert.deepEqual(h.calls, []);
});

test("reservation CAS conflict prevents external job creation", async () => {
  const h = harness(); h.casConflict = true;
  const response = await h.chat.POST(request("chat", input()), routeContext);
  assert.equal(response.status, 409);
  assert.deepEqual(h.calls.map(call => call[0]), ["sign", "save"]);
});

test("dispatch failure is saved as retryable failure without applying a model", async () => {
  const h = harness(); h.dispatchError = new Error("GitHub unavailable");
  const response = await h.chat.POST(request("chat", input()), routeContext);
  assert.equal(response.status, 202);
  assert.equal(h.workspace.document.pipeline.status, "failed");
  assert.equal(h.workspace.document.model.title, "Draft");
  assert.equal(h.calls.filter(call => call[0] === "dispatch").length, 1);
});

test("completed sync verifies ownership, creates one proposal, and preserves edited model", async () => {
  const h = harness();
  await h.chat.POST(request("chat", input()), routeContext);
  h.job.status = "complete"; h.job.message = "Ready"; h.job.packageReady = true;
  h.workspace = { ...h.workspace, document: { ...h.workspace.document, model: model("Researcher edited model") } };
  const synced = await h.sync.POST(request("pipeline", { revision: h.workspace.revision }), routeContext);
  assert.equal(synced.status, 200);
  const result = await synced.json();
  assert.deepEqual(h.calls.slice(-3).map(call => call[0]), ["read", "list", "save"]);
  assert.deepEqual(h.calls.find(call => call[0] === "read").slice(1), [jobId, { ownerId: ids.owner, workspaceId: ids.workspace }]);
  assert.deepEqual(h.calls.find(call => call[0] === "list").slice(1), [jobId, { ownerId: ids.owner, workspaceId: ids.workspace }]);
  assert.equal(result.workspace.document.model.title, "Researcher edited model");
  const messages = result.workspace.document.conversations[0].messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[1].proposal.status, "pending");
  assert.equal(messages[1].proposal.model.title, "Pipeline study");
  assert.equal(result.job.packageReady, true);
  const again = await h.sync.POST(request("pipeline", { revision: h.workspace.revision }), routeContext);
  assert.equal(again.status, 200);
  assert.equal(h.lists, 1);
  assert.equal(h.workspace.document.conversations[0].messages.length, 2);
  assert.equal(h.workspace.document.model.title, "Researcher edited model");
  const stale = await h.sync.POST(request("pipeline", { revision: 1 }), routeContext);
  assert.equal(stale.status, 409);
  assert.equal(h.lists, 1);
});

test("sync refuses an unowned job before reading package files", async () => {
  const h = harness();
  await h.chat.POST(request("chat", input()), routeContext);
  h.github.readOwnedStudioJob = async () => { throw new Error("owner mismatch"); };
  h.job.status = "review";
  const response = await h.sync.POST(request("pipeline", { revision: h.workspace.revision }), routeContext);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "pipeline_not_found");
  assert.equal(h.lists, 0);
});

test("sync CAS conflict does not persist a stale proposal", async () => {
  const h = harness();
  await h.chat.POST(request("chat", input()), routeContext);
  h.job.status = "review";
  h.casConflict = true;
  const response = await h.sync.POST(request("pipeline", { revision: h.workspace.revision }), routeContext);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "revision_conflict");
  assert.equal(h.workspace.document.conversations[0].messages.length, 1);
  assert.equal(h.workspace.document.pipeline.proposalId, undefined);
});

test("explicit sourceId chooses its PDF over the previous job source", async () => {
  const initial = document([source(), otherSource()]);
  initial.pipeline = { jobId, requestId: ids.request, conversationId: ids.conversation, sourceId: ids.source, status: "review", message: "Ready", updatedAt: now };
  const h = harness(initial);
  h.signing = `/object/sign/studio-sources/${otherSource().path}?token=other`;
  const response = await h.chat.POST(request("chat", { ...input(1, ids.next), sourceId: ids.otherSource }), routeContext);
  assert.equal(response.status, 202);
  assert.equal(h.workspace.document.pipeline.sourceId, ids.otherSource);
  assert.match(h.calls.find(call => call[0] === "sign")[1], new RegExp(`${ids.otherSource}\\.pdf`));
  const created = h.calls.find(call => call[0] === "create")[1];
  assert.equal(created.paperName, "other.pdf");
  assert.deepEqual(created.openMaterialsSourceIds, [ids.source], "the other PDF must travel as an auxiliary source");
  assert.equal(created.previousJobId, undefined, "a different PDF must start a fresh package");
});

test("excluded sources stay in the workspace but leave the worker payload and resource bundle", async () => {
  const initial = document([source(), { ...otherSource(), includeInBuild: false }]);
  const h = harness(initial);
  const response = await h.chat.POST(request("chat", input()), routeContext);
  assert.equal(response.status, 202);
  assert.equal(h.workspace.document.sources.length, 2);
  const created = h.calls.find(call => call[0] === "create")[1];
  assert.deepEqual(created.request.document.sources.map(item => item.id), [ids.source]);
  assert.deepEqual(created.openMaterialsSourceIds, []);
});

test("retry refreshes the owner-bound resource bundle URL", async () => {
  const h = harness();
  await h.chat.POST(request("chat", input()), routeContext);
  h.job.status = "failed";
  h.job.openMaterialsPathname = `${ids.owner}/${ids.workspace}/${ids.next}.zip`;
  h.materialsSigning = `/object/sign/studio-sources/${h.job.openMaterialsPathname}?token=fresh`;
  const response = await h.sync.POST(request("pipeline", { revision: h.workspace.revision, action: "retry" }), routeContext);
  assert.equal(response.status, 200);
  const retry = h.calls.find(call => call[0] === "retry");
  assert.match(retry[4], new RegExp(`${ids.next}\\.zip\\?token=fresh$`));
});

test("a rejected proposal never seeds a later package", async () => {
  const initial = document();
  initial.pipeline = { jobId, requestId: ids.request, conversationId: ids.conversation, sourceId: ids.source, status: "review", message: "Ready", updatedAt: now, proposalId: ids.next };
  initial.conversations = [{ id: ids.conversation, title: "First request", draft: "", updatedAt: now, modelAnchor: null, sourceSelection: null, selected: "", messages: [
    { id: ids.request, role: "user", text: "First request", createdAt: now },
    { id: ids.otherSource, role: "agent", text: "Package ready", createdAt: now, proposal: { id: ids.next, model: model("First proposal"), changesModel: true, summary: "Review", status: "rejected" } },
  ] }];
  const h = harness(initial);
  const response = await h.chat.POST(request("chat", { ...input(1, ids.next), sourceId: ids.source }), routeContext);
  assert.equal(response.status, 202);
  const created = h.calls.find(call => call[0] === "create")[1];
  assert.equal(created.previousJobId, undefined);
  assert.equal(h.workspace.document.conversations[0].messages.at(-1).role, "user");
});

test("retry accepts failed, queued older than five minutes, and running older than 100 minutes", async () => {
  for (const [status, ageMinutes] of [["failed", 0], ["queued", 6], ["running", 101]]) {
    const h = harness();
    await h.chat.POST(request("chat", input()), routeContext);
    h.job.status = status;
    h.job.updatedAt = new Date(Date.now() - ageMinutes * 60_000).toISOString();
    const response = await h.sync.POST(request("pipeline", { revision: h.workspace.revision, action: "retry" }), routeContext);
    assert.equal(response.status, 200, `${status} after ${ageMinutes} minutes`);
    const retry = h.calls.find(call => call[0] === "retry");
    assert.deepEqual(retry.slice(1, 3), [jobId, { ownerId: ids.owner, workspaceId: ids.workspace }]);
    assert.match(retry[3], /^https:\/\/storage\.test\/storage\/v1\/object\/sign/);
    assert.equal(h.workspace.document.pipeline.status, "queued");
  }
});

test("retry rejects fresh queued and running jobs before signing or dispatch", async () => {
  for (const status of ["queued", "running"]) {
    const h = harness();
    await h.chat.POST(request("chat", input()), routeContext);
    h.job.status = status;
    h.job.updatedAt = new Date().toISOString();
    const callCount = h.calls.length;
    const response = await h.sync.POST(request("pipeline", { revision: h.workspace.revision, action: "retry" }), routeContext);
    assert.equal(response.status, 409, status);
    assert.equal((await response.json()).error, "pipeline_busy");
    assert.deepEqual(h.calls.slice(callCount).map(call => call[0]), ["read"]);
  }
});

test("missing old preparing job becomes failed without signing or retry dispatch", async () => {
  const initial = document();
  initial.pipeline = { jobId, requestId: ids.request, conversationId: ids.conversation, sourceId: ids.source, status: "preparing", message: "Preparing", updatedAt: new Date(Date.now() - 6 * 60_000).toISOString() };
  const h = harness(initial);
  h.github.readOwnedStudioJob = async (id, identity) => { h.calls.push(["read", id, identity]); throw new StudioError(404, "not_found"); };
  const response = await h.sync.POST(request("pipeline", { revision: 1, action: "retry" }), routeContext);
  assert.equal(response.status, 200);
  assert.equal(h.workspace.document.pipeline.status, "failed");
  assert.deepEqual(h.calls.map(call => call[0]), ["read", "save"]);
});

test("retry checks job ownership before signing or dispatch", async () => {
  const h = harness();
  await h.chat.POST(request("chat", input()), routeContext);
  h.github.readOwnedStudioJob = async (id, identity) => { h.calls.push(["read", id, identity]); throw new StudioError(404, "not_found"); };
  const callCount = h.calls.length;
  const response = await h.sync.POST(request("pipeline", { revision: h.workspace.revision, action: "retry" }), routeContext);
  assert.equal(response.status, 404);
  assert.deepEqual(h.calls.slice(callCount).map(call => call[0]), ["read"]);
});

test("late local edits merge into an authoritative pipeline proposal", () => {
  const { mergeStudioUpdate } = load("lib/studio/merge-update.ts");
  const server = document();
  server.model = model("Pipeline model");
  server.pipeline = { jobId, requestId: ids.request, conversationId: ids.conversation, sourceId: ids.source, status: "complete", message: "Ready", updatedAt: now, proposalId: ids.next };
  server.conversations = [{ id: ids.conversation, title: "Study", updatedAt: now, draft: "", selected: "", modelAnchor: null, sourceSelection: null, messages: [
    { id: ids.request, role: "user", text: "Build", createdAt: now },
    { id: ids.next, role: "agent", text: "Proposal ready", createdAt: now, proposal: { id: ids.next, model: model("Proposal"), summary: "Review", status: "pending" } },
  ] }];
  const late = structuredClone(server);
  late.model = model("Old model");
  late.pipeline.status = "queued";
  late.conversations[0].draft = "My next question";
  late.conversations[0].messages = [{ id: ids.request, role: "user", text: "Build", createdAt: now }, { id: ids.otherSource, role: "user", text: "Late note", createdAt: now }];
  late.annotations = [{ id: ids.otherSource, sourceId: ids.source, page: 1, rects: [], text: "Participants", kind: "text", comment: "Check wording", entity: "", createdAt: now }];
  late.reviewResponses[ids.source] = { text: "Check the task wording", savedAt: now };
  const result = mergeStudioUpdate(server, late);
  assert.equal(result.model.title, "Pipeline model");
  assert.equal(result.pipeline.status, "complete");
  assert.equal(result.conversations[0].draft, "My next question");
  assert.deepEqual(result.conversations[0].messages.map(message => message.id), [ids.request, ids.next, ids.otherSource]);
  assert.equal(result.conversations[0].messages[1].proposal.status, "pending");
  assert.equal(result.annotations[0].comment, "Check wording");
  assert.equal(result.reviewResponses[ids.source].text, "Check the task wording");
});

test("legacy GitHub job reads reject Studio IDs before accessing a repository", async () => {
  const jobs = load("lib/github-jobs.ts", { "@/lib/blob-paper": {}, "@octokit/rest": { Octokit: class { constructor() { throw new Error("unexpected network access"); } } } });
  await assert.rejects(jobs.readJob(jobId), /authenticated study workspace/);
  await assert.rejects(jobs.readJob(jobId.replace("studio-", "st!udio-")), /authenticated study workspace/);
  await assert.rejects(jobs.listPackageFiles(jobId.replace("studio-", "st!udio-")), /authenticated study workspace/);
  await assert.rejects(jobs.listPackageFiles(jobId), /authenticated study workspace/);
  await assert.rejects(jobs.approveStage(jobId, { decision: "approved" }), /authenticated study workspace/);
});

test("acceptance stops adding program versions and autosave preserves existing metadata", async()=>{
 const h=harness();
 await h.chat.POST(request('chat',{...input(),intent:'discuss'}),routeContext);
 h.job.status='complete';h.turn={requestId:ids.request,reply:'Use a clearer research question.',summary:'Clarify question',model:model('Refined question')};
 await h.sync.POST(request('pipeline',{revision:h.workspace.revision}),routeContext);
 const proposal=h.workspace.document.conversations[0].messages.at(-1).proposal;
 const accepted=await h.proposals.POST(request('proposals',{revision:h.workspace.revision,proposalId:proposal.id,decision:'apply'}),routeContext);
 assert.equal(accepted.status,200);
 assert.equal(h.workspace.document.programVersions,undefined);
 const log=[{id:'legacy-version',createdAt:now,label:'Existing program',fingerprint:modelVersion.modelFingerprint(h.workspace.document.model),model:structuredClone(h.workspace.document.model)}];
 h.workspace.document.programVersions=log;
 const tampered={...h.workspace.document,programVersions:[]};
 const patch=new Request(`https://studio.test/api/studio/workspaces/${ids.workspace}`,{method:'PATCH',headers:{origin:'https://studio.test','content-type':'application/json'},body:JSON.stringify({document:tampered,expectedRevision:h.workspace.revision})});
 const saved=await h.workspaceRoute.PATCH(patch,routeContext);
 assert.equal(saved.status,200);assert.deepEqual(h.workspace.document.programVersions,log);
});
