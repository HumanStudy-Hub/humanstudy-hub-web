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
const validation = load("lib/studio/validation.ts");
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
const input = (revision = 1, requestId = ids.request) => ({ conversationId: ids.conversation, requestId, text: "Build this study", revision });
const routeContext = { params: Promise.resolve({ id: ids.workspace }) };

function harness(initial = document()) {
  let workspace = { id: ids.workspace, title: "Study", revision: 1, document: initial, created_at: now, updated_at: now };
  let configured = true, signing = `/object/sign/studio-sources/${source().path}?token=secret`, dispatchError = null;
  let casConflict = false, reads = 0, lists = 0;
  const calls = [];
  const job = { id: jobId, status: "queued", message: "Waiting", updatedAt: now, progress: 0, packageReady: false };
  const github = {
    studioPipelineConfigured: () => configured,
    async createStudioPipelineJob(arg) { calls.push(["create", arg]); return { ...job, id: arg.id, message: "Waiting", studio: arg.identity }; },
    async dispatchStudioPipelineJob(arg) { calls.push(["dispatch", arg]); if (dispatchError) throw dispatchError; },
    async readOwnedStudioJob(id, identity) { reads++; calls.push(["read", id, identity]); return { ...job, id }; },
    async listPackageFiles(id, identity) { lists++; calls.push(["list", id, identity]); return [{ path: "paper/study.json", content: Buffer.from(JSON.stringify({ title: "Pipeline study", participant_flow: "Read then answer" })) }, { path: "paper/studio-reply.md", content: Buffer.from("Generated package is ready.") }]; },
    async approveStage(id, decision, identity) { calls.push(["approve", id, decision, identity]); return job; },
    async retryStudioPipelineJob(id, identity, paperUrl) { calls.push(["retry", id, identity, paperUrl]); return { ...job, id, status: "queued", message: "Waiting for retry", updatedAt: new Date().toISOString() }; },
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
    async studioFetch(path, options) { calls.push(["sign", path, options]); return Response.json({ signedURL: signing }); },
    async upstreamJson(response) { return response.json(); },
  };
  const adapter = load("lib/studio/pipeline-adapter.ts", { "./validation": validation });
  const pipeline = load("lib/studio/pipeline.ts", { "@/lib/github-jobs": github, "./http": http, "./store": store, "./pipeline-adapter": adapter, "./validation": validation });
  const auth = { async requireStudioUser() { return ctx; } };
  const deps = { "next/server": nextServer, "@/lib/studio/auth": auth, "@/lib/studio/http": http, "@/lib/studio/store": store, "@/lib/studio/validation": validation, "@/lib/studio/pipeline": pipeline, "@/lib/github-jobs": github };
  const chat = load("app/api/studio/workspaces/[id]/chat/route.ts", deps);
  const sync = load("app/api/studio/workspaces/[id]/pipeline/route.ts", deps);
  const proposals = load("app/api/studio/workspaces/[id]/proposals/route.ts", deps);
  return { chat, sync, proposals, pipeline, github, job, calls, get workspace() { return workspace; }, set workspace(value) { workspace = value; }, get reads() { return reads; }, get lists() { return lists; }, set configured(value) { configured = value; }, set signing(value) { signing = value; }, set dispatchError(value) { dispatchError = value; }, set casConflict(value) { casConflict = value; } };
}

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
  assert.equal(created.previousJobId, undefined, "a different PDF must start a fresh package");
});

test("a rejected proposal still reuses the completed package for the same PDF", async () => {
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
  assert.equal(created.previousJobId, jobId);
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
