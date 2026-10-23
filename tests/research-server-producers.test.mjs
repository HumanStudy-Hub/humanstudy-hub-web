// T08: server-owned research producers, durable outbox and delivery, against an in-memory Supabase
// that implements the RPC, outbox guard, Storage, research_content and research_events semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

const requireLocal = createRequire(import.meta.url), ts = requireLocal("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.RESEARCH_COLLECTION_V1_ENABLED = "1";
process.env.SUPABASE_URL = "https://db.test";
process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-test-key";
function load(file, deps = {}) {
  const js = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const m = { exports: {} };
  new Function("require", "module", "exports", js)(id => deps[id] ?? ((id === "./human-program" || id === "@/lib/studio/human-program") ? load("lib/studio/human-program.ts") : id === "./human-program.schema.json" ? JSON.parse(fs.readFileSync(path.join(root, "lib/studio/human-program.schema.json"), "utf8")) : requireLocal(id)), m, m.exports);
  return m.exports;
}
const sha = b => createHash("sha256").update(b).digest("hex");
const ids = {
  owner: "11111111-1111-4111-8111-111111111111", workspace: "22222222-2222-4222-8222-222222222222",
  source: "33333333-3333-4333-8333-333333333333", conversation: "44444444-4444-4444-8444-444444444444",
  request: "55555555-5555-4555-8555-555555555555", action: "77777777-7777-4777-8777-777777777777", second: "66666666-6666-4666-8666-666666666666",
};
const now = "2026-01-02T00:00:00.000Z";
const ctx = { user: { id: ids.owner, email: "researcher@example.org" }, accessToken: "user-access-token" };
const model = (title = "Draft") => ({ id: "study", title, source: { title: "", authors: "", filename: "" }, entities: [], relations: [], procedure: [], variables: [] });
const source = () => ({ id: ids.source, name: "paper.pdf", path: `${ids.owner}/${ids.workspace}/${ids.source}.pdf`, mimeType: "application/pdf", size: 12 });
const doc = () => ({ version: 1, title: "Study", model: model(), sources: [source()], annotations: [], conversations: [], reviewResponses: {} });
const jobId = (request = ids.request) => `studio-${ids.workspace}-${request}`;

const contract = load("lib/research-data/contract.ts");
const http = load("lib/studio/http.ts", { "next/server": { NextResponse: { json: (d, o = {}) => Response.json(d, { status: o.status || 200, headers: o.headers }) } } });
const resources = load("lib/studio/resources.ts");
const conversationTree = load("lib/studio/conversation-tree.ts");
const validation = load("lib/studio/validation.ts", { "./conversation-tree": conversationTree, "./resources": resources });
const modelVersion = load("lib/studio/model-version.ts");
const producer = load("lib/research-data/server-producer.ts", { "./contract": contract });
const outbox = load("lib/research-data/server-outbox.ts", { "./contract": contract });
const webEvent = load("lib/research-data/web-event.ts", { "./contract": contract });

/** In-memory Supabase: the subset of PostgREST/Storage behaviour the producers rely on. */
function fakeSupabase(initial = doc()) {
  const db = { workspace: { id: ids.workspace, title: "Study", revision: 1, document: initial, created_at: now, updated_at: now, owner_id: ids.owner },
    outbox: new Map(), content: new Map(), objects: new Map(), events: new Map(), history: [] };
  const fail = { events: 0, eventsStatus: 503, rpcMissing: false, rpcOutbox: true };
  const log = [];
  const reply = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const commit = (expected, document) => {
    if (expected !== db.workspace.revision) return null;
    db.workspace = { ...db.workspace, revision: db.workspace.revision + 1, document, title: document.title };
    db.history.push(db.workspace.revision);
    return db.workspace;
  };
  const insertOutbox = rows => {
    for (const r of rows) {
      if (!r.payload || !Array.isArray(r.payload.events) || !Array.isArray(r.payload.content)) throw new Error("check_violation");
      if (!db.outbox.has(r.id)) db.outbox.set(r.id, { ...structuredClone(r), owner_id: ids.owner, attempts: 0, last_attempt_at: null, last_error: null, delivered_at: null, created_at: new Date().toISOString() });
    }
  };
  async function handle(url, init = {}) {
    const u = new URL(url), method = init.method || "GET", q = u.searchParams, p = u.pathname;
    const body = init.body === undefined ? undefined : typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    log.push(`${method} ${p}`);
    if (p === "/rest/v1/rpc/studio_cas_workspace_research") {
      if (fail.rpcMissing) return reply({ code: "PGRST202" }, 404);
      const saved = commit(body.p_expected_revision, body.p_document);
      if (!saved) return reply({ workspace: null, outbox_stored: false });
      let stored = false;
      if (fail.rpcOutbox) { try { insertOutbox(body.p_outbox); stored = true; } catch { stored = false; } }
      return reply({ workspace: saved, outbox_stored: stored });
    }
    if (p === "/rest/v1/rpc/studio_cas_workspace") { const saved = commit(body.p_expected_revision, body.p_document); return reply(saved ? [saved] : []); }
    if (p === "/rest/v1/studio_workspaces") return reply([db.workspace]);
    if (p === "/rest/v1/research_consents") return reply([{ version: 3 }]);
    if (p === "/rest/v1/research_server_outbox") {
      if (method === "POST") { try { insertOutbox(body); return reply(null, 201); } catch { return reply({}, 400); } }
      const id = q.get("id")?.slice(3);
      if (method === "PATCH") {
        const row = db.outbox.get(id); if (!row) return reply(null, 204);
        if ("payload" in body && body.payload !== null) return reply({}, 400);
        if (body.payload === null && !(body.delivered_at ?? row.delivered_at)) return reply({}, 400);
        if (row.delivered_at && body.delivered_at && body.delivered_at !== row.delivered_at) return reply({}, 400);
        Object.assign(row, body); return reply(null, 204);
      }
      let rows = [...db.outbox.values()];
      if (q.get("delivered_at") === "is.null") rows = rows.filter(r => !r.delivered_at);
      if (id) rows = rows.filter(r => r.id === id);
      return reply(rows.map(r => structuredClone(r)));
    }
    if (p === "/rest/v1/research_content") {
      if (method === "POST") {
        if (!db.objects.has(`${body.owner_id}/${body.sha256}`)) return reply({}, 403); // row only after the object
        db.content.set(body.sha256, body); return reply(null, 201);
      }
      const hash = q.get("sha256").slice(3); return reply(db.content.has(hash) ? [{ sha256: hash }] : []);
    }
    if (p.startsWith("/storage/v1/object/authenticated/research-content/")) {
      const key = p.slice("/storage/v1/object/authenticated/research-content/".length);
      return db.objects.has(key) ? new Response(db.objects.get(key)) : reply({}, 404);
    }
    if (p.startsWith("/storage/v1/object/research-content/")) {
      const key = p.slice("/storage/v1/object/research-content/".length);
      if (db.objects.has(key)) return reply({ statusCode: "409", error: "Duplicate" }, 400);
      db.objects.set(key, Buffer.from(init.body)); return reply({ Key: key });
    }
    if (p === "/rest/v1/research_events") {
      if (method === "POST") {
        if (fail.events > 0) { fail.events--; return reply({}, fail.eventsStatus); }
        for (const row of body) {
          const { owner_id, ...event } = row;
          if (owner_id !== ids.owner || contract.validateResearchEvent(event).length) return reply({ message: "check_violation" }, 400);
          for (const ref of event.content_refs) if (!db.content.has(ref.sha256)) return reply({}, 409);
        }
        for (const row of body) if (!db.events.has(row.id)) db.events.set(row.id, row);
        return reply(null, 201);
      }
      const session = q.get("research_session_id")?.slice(3);
      return reply([...db.events.values()].filter(e => !session || e.research_session_id === session).map(e => ({ id: e.id })));
    }
    return reply({ error: "unhandled " + p }, 500);
  }
  return { db, fail, log, handle };
}

function harness(initial) {
  const supa = fakeSupabase(initial);
  globalThis.fetch = (url, init) => supa.handle(url, init);
  const tasks = [];
  const after = fn => { tasks.push(fn); };
  const store = load("lib/studio/store.ts", { "./http": http, "./resources": resources });
  const capture = load("lib/research-data/server-capture.ts", { "next/server": { after }, "../studio/http": http, "../studio/store": store, "./server-producer": producer, "./server-outbox": outbox });
  const job = { id: jobId(), status: "queued", message: "Waiting", updatedAt: now, packageReady: false };
  let turn = { requestId: ids.request, reply: "The paper reports 40 participants." };
  const github = {
    studioPipelineConfigured: () => true,
    async createStudioPipelineJob(arg) { return { ...job, id: arg.id, studio: arg.identity }; },
    async dispatchStudioPipelineJob() {},
    async readOwnedStudioJob(id) { return { ...job, id }; },
    async readOwnedStudioTurn() { return turn; },
    async listPackageFiles() { return [{ path: "paper/study.json", content: Buffer.from(JSON.stringify({ title: "Pipeline study" })) }, { path: "paper/studio-reply.md", content: Buffer.from("Generated package is ready.") }]; },
    async approveStage() { return job; },
    async retryStudioPipelineJob(id) { return { ...job, id, status: "queued", updatedAt: new Date().toISOString() }; },
  };
  const resourceServer = { prepareStudioResourceArchive: async () => null, signPrivateSource: async () => "https://storage.test/signed?token=secret", isOwnedResourceArchivePath: () => true };
  const adapter = load("lib/studio/pipeline-adapter.ts", { "./validation": validation });
  const research = { "../research-data/server-capture": capture, "@/lib/research-data/server-capture": capture, "../research-data/server-producer": producer, "@/lib/research-data/server-producer": producer };
  const pipeline = load("lib/studio/pipeline.ts", { ...research, "./web-access": { webAgentAllowed: () => true }, "@/lib/github-jobs": github, "./http": http, "./store": store, "./pipeline-adapter": adapter, "./validation": validation, "./model-version": modelVersion, "./conversation-tree": conversationTree, "./resources": resources, "./resource-server": resourceServer });
  const nextServer = { NextResponse: { json: (d, o = {}) => Response.json(d, { status: o.status || 200, headers: o.headers }) } };
  const deps = { ...research, "next/server": nextServer, "@/lib/research-data/consent-server": { requireStudioResearchUser: async () => ctx }, "@/lib/studio/http": http, "@/lib/studio/store": store, "@/lib/studio/validation": validation, "@/lib/studio/model-version": modelVersion, "@/lib/studio/pipeline": pipeline, "@/lib/github-jobs": github };
  const routes = {
    chat: load("app/api/studio/workspaces/[id]/chat/route.ts", deps),
    sync: load("app/api/studio/workspaces/[id]/pipeline/route.ts", deps),
    proposals: load("app/api/studio/workspaces/[id]/proposals/route.ts", deps),
    workspace: load("app/api/studio/workspaces/[id]/route.ts", deps),
  };
  const req = (suffix, body, method = "POST") => new Request(`https://studio.test/api/studio/workspaces/${ids.workspace}${suffix}`, { method, headers: { origin: "https://studio.test", "content-type": "application/json" }, body: JSON.stringify(body) });
  const routeContext = { params: Promise.resolve({ id: ids.workspace }) };
  return {
    supa, job, github, tasks, routes, req, routeContext, capture,
    set turn(v) { turn = v; },
    async runAfter() { while (tasks.length) await tasks.shift()(); },
    events: () => [...supa.db.events.values()],
    byType: type => [...supa.db.events.values()].filter(e => e.event_type === type),
    send: (body) => routes.chat.POST(req("/chat", { conversationId: ids.conversation, requestId: ids.request, text: "What sample size was reported?", revision: supa.db.workspace.revision, intent: "discuss", ...body }), routeContext),
    poll: () => routes.sync.POST(req("/pipeline", { revision: supa.db.workspace.revision }), routeContext),
  };
}

test("batches are valid, gap-free, deterministic sessions; long text is referenced in full, never clipped", () => {
  const p = { ownerId: ids.owner, email: "researcher@example.org", projectId: ids.workspace, at: now };
  const long = "Participants read the vignette. ".repeat(600) + " contact researcher@example.org key sk-or-v1-abcdefghijklmnopqrstuvwxyz";
  const make = () => producer.buildServerBatch(p, "chat.submit", "turn:x:submit", producer.submitEvents(p, { requestId: ids.request, conversationId: ids.conversation, text: long, mode: "discuss", jobId: jobId() }));
  const a = make(), b = make();
  assert.deepEqual(a, b, "replay builds identical rows");
  assert.deepEqual(a.events.map(e => e.client_seq), a.events.map((_, i) => i + 1));
  assert.equal(a.events[0].event_type, "session.start");
  assert.equal(a.events.at(-1).event_type, "session.end");
  assert.equal(a.events.at(-1).metadata.captured_through_seq, a.events.length);
  for (const e of a.events) { assert.deepEqual(contract.validateResearchEvent(e), []); assert.equal(e.research_session_id, a.id); assert.equal(e.install_id, "web-server"); }
  const message = a.events.find(e => e.event_type === "conversation.message");
  assert.equal(message.metadata.text, undefined, "long text is not inline");
  const ref = message.content_refs.find(r => r.role === "text"), stored = a.content.find(c => c.sha256 === ref.sha256);
  assert.equal(sha(Buffer.from(stored.text)), ref.sha256);
  assert.ok(stored.text.startsWith("Participants read the vignette. ") && stored.text.length >= long.length - 80, "complete text");
  assert.doesNotMatch(stored.text, /researcher@example\.org|sk-or-v1/, "sanitized like every other surface");
  const action = a.events.find(e => e.event_type === "action.invoke");
  assert.equal(action.metadata.via, "system", "without a browser action the server records one primary action");
});

test("chat turn: committed user message, dispatch tool call, received reply and turn end are linked at the producer", async () => {
  const h = harness();
  const sent = await h.send({ actionId: ids.action });
  assert.equal(sent.status, 202);
  assert.equal(h.supa.db.outbox.size, 2, "reservation and dispatch commits each stored a batch atomically");
  assert.equal(h.events().length, 0, "nothing is delivered inside the user's request");
  await h.runAfter();
  assert.equal(h.byType("action.invoke").length, 0, "the browser's primary action is referenced, not duplicated");
  const [turnStart] = h.byType("agent.turn_start"), [user] = h.byType("conversation.message"), [toolStart] = h.byType("tool.start");
  assert.equal(user.metadata.role, "user"); assert.equal(user.metadata.text, "What sample size was reported?");
  assert.equal(user.message_id, ids.request); assert.equal(user.thread_id, ids.conversation);
  for (const e of [turnStart, user, toolStart]) assert.equal(e.action_id, ids.action);
  assert.equal(user.caused_by, turnStart.id); assert.equal(toolStart.caused_by, turnStart.id);
  assert.equal(toolStart.tool_call_id, jobId()); assert.equal(toolStart.target, "humanstudy.pipeline");
  const input = h.supa.db.content.get(toolStart.content_refs.find(r => r.role === "input")?.sha256) ? JSON.parse(gunzipSync(h.supa.db.objects.get(`${ids.owner}/${toolStart.content_refs.find(r => r.role === "input").sha256}`)).toString()) : JSON.parse(toolStart.metadata.input);
  assert.equal(input.request.message, "What sample size was reported?", "complete runner input");
  assert.doesNotMatch(JSON.stringify(input), /token=secret|signed/, "signed URLs are never recorded");

  h.job.status = "complete";
  await h.poll(); await h.runAfter();
  const [toolEnd] = h.byType("tool.end"), reply = h.byType("conversation.message").find(e => e.metadata.role === "assistant"), [turnEnd] = h.byType("agent.turn_end");
  assert.equal(toolEnd.caused_by, toolStart.id); assert.equal(toolEnd.metadata.status, "completed");
  assert.equal(reply.caused_by, toolEnd.id); assert.equal(reply.metadata.status, "complete"); assert.equal(reply.metadata.text, "The paper reports 40 participants.");
  assert.equal(reply.message_id, h.supa.db.workspace.document.conversations[0].messages.at(-1).id, "message id is the committed message id");
  assert.equal(turnEnd.caused_by, turnStart.id); assert.equal(turnEnd.metadata.status, "complete");
  for (const e of [toolEnd, reply, turnEnd]) assert.equal(e.action_id, ids.action);
  assert.ok([...h.supa.db.outbox.values()].every(r => r.delivered_at && r.payload === null), "payload released only after read-back");

  const count = h.events().length;
  await h.poll(); await h.runAfter();
  assert.equal(h.events().length, count, "polling an already-recorded result adds nothing");
  const resend = await h.send({ actionId: ids.action, revision: h.supa.db.workspace.revision });
  assert.equal((await resend.json()).idempotent, true); await h.runAfter();
  assert.equal(h.events().length, count, "a retried send is the same logical event");
});

test("first build: generated package files become artifact versions caused by the tool result", async () => {
  const h = harness();
  await h.send({ actionId: ids.action, intent: "build", text: "Build this study" }); await h.runAfter();
  h.job.status = "review"; h.job.packageReady = true;
  await h.poll(); await h.runAfter();
  const [end] = h.byType("tool.end"), files = h.byType("artifact.version");
  assert.equal(end.metadata.status, "completed");
  assert.deepEqual(files.map(f => f.artifact_id).sort(), ["package/paper/studio-reply.md", "package/paper/study.json"]);
  for (const f of files) { assert.equal(f.caused_by, end.id); assert.equal(f.action_id, ids.action); assert.equal(f.metadata.by, "agent"); }
  assert.equal(h.byType("permission.request").length, 1, "the package proposal awaits the researcher's decision");
  assert.equal(h.byType("agent.turn_end")[0].metadata.status, "complete");
});

test("without a browser action id the server records one system primary action", async () => {
  const h = harness();
  await h.send({}); await h.runAfter();
  const [action] = h.byType("action.invoke");
  assert.equal(action.metadata.via, "system"); assert.equal(action.action_id, action.id);
  assert.ok(h.events().filter(e => e.action_id).every(e => e.action_id === action.id));
});

test("interrupted output: a received but unusable reply is kept as partial with the error and turn status", async () => {
  const h = harness();
  await h.send({ actionId: ids.action }); await h.runAfter();
  h.job.status = "complete"; h.turn = { requestId: ids.request, reply: "Half an answer before the runner", model: { broken: true } };
  await h.poll(); await h.runAfter();
  const partial = h.byType("conversation.message").find(e => e.metadata.role === "assistant");
  assert.equal(partial.metadata.status, "partial"); assert.equal(partial.metadata.text, "Half an answer before the runner"); assert.equal(partial.metadata.reason, "invalid_result");
  assert.equal(h.byType("tool.end")[0].metadata.status, "error");
  assert.equal(h.byType("conversation.error").length, 1);
  assert.equal(h.byType("agent.turn_end")[0].metadata.status, "error");
});

test("a failed runner job closes the tool call and turn as errors", async () => {
  const h = harness();
  await h.send({ actionId: ids.action }); await h.runAfter();
  h.job.status = "failed"; h.job.message = "Runner exceeded its time limit";
  await h.poll(); await h.runAfter();
  const [end] = h.byType("tool.end"), [error] = h.byType("conversation.error"), [turnEnd] = h.byType("agent.turn_end");
  assert.equal(end.metadata.status, "error"); assert.match(error.metadata.text, /time limit/); assert.equal(turnEnd.metadata.status, "error");
});

test("outbox retry: a transient insert failure leaves the batch pending and visible, the next drain delivers it once", async () => {
  const h = harness();
  h.supa.fail.events = 1;
  await h.send({ actionId: ids.action });
  await h.runAfter();
  const rows = [...h.supa.db.outbox.values()];
  const failing = rows.filter(r => !r.delivered_at);
  assert.equal(failing.length, 1, "one batch hit the outage");
  assert.equal(failing[0].attempts, 1); assert.match(failing[0].last_error, /^events_503$/); assert.ok(failing[0].payload, "payload retained");
  assert.equal(outbox.due(failing).length, 0, "backoff before the next attempt");
  failing[0].last_attempt_at = "2026-01-01T00:00:00.000Z";
  const payload = structuredClone(failing[0].payload);
  const t = { url: "https://db.test", apikey: "k", bearer: ctx.accessToken, ownerId: ids.owner, mode: "user" };
  assert.deepEqual(await outbox.drainOwner(t), { delivered: 1, pending: 0, rejected: 0 });
  assert.ok(failing[0].delivered_at && failing[0].payload === null);
  const before = h.events().length;
  // Lost acknowledgement: the same batch delivered again is the same rows.
  await outbox.deliverBatch(t, payload, failing[0].id);
  assert.equal(h.events().length, before);
  assert.ok(payload.events.every(e => h.supa.db.events.has(e.id)));
});

test("a rejected row is isolated, reported and not retried automatically", async () => {
  const h = harness();
  h.supa.fail.events = 99; h.supa.fail.eventsStatus = 400;
  await h.send({ actionId: ids.action }); await h.runAfter();
  const rows = [...h.supa.db.outbox.values()];
  assert.ok(rows.every(r => /^rejected:/.test(r.last_error) && r.payload), "kept for review");
  assert.equal(outbox.due(rows.map(r => ({ ...r, last_attempt_at: "2026-01-01T00:00:00.000Z" }))).length, 0);
});

test("research capture never blocks or fails the user's request", async () => {
  const h = harness();
  h.supa.fail.rpcOutbox = false; h.supa.fail.events = 99;
  const sent = await h.send({ actionId: ids.action });
  assert.equal(sent.status, 202);
  assert.equal(h.supa.db.workspace.document.discussion.status, "queued");
  await h.runAfter();
  assert.equal(h.supa.db.outbox.size, 2, "an outbox the RPC could not store is inserted after the response");
});

test("without the RPC deployed the plain CAS runs and the outbox is filled after the response", async () => {
  const h = harness();
  h.supa.fail.rpcMissing = true;
  const sent = await h.send({ actionId: ids.action });
  assert.equal(sent.status, 202);
  assert.ok(h.supa.log.includes("POST /rest/v1/rpc/studio_cas_workspace"));
  await h.runAfter();
  assert.equal(h.byType("conversation.message").length, 1);
});

test("proposal decision commits a permission decision and the effective program version at that revision", async () => {
  const h = harness();
  await h.send({ actionId: ids.action }); await h.runAfter();
  h.job.status = "complete"; h.turn = { requestId: ids.request, reply: "A more specific title.", model: model("Revised title") };
  await h.poll(); await h.runAfter();
  const proposal = h.supa.db.workspace.document.conversations[0].messages.at(-1).proposal;
  const [request] = h.byType("permission.request");
  assert.equal(request.metadata.permission_id, proposal.id);
  const review = "88888888-8888-4888-8888-888888888888";
  const r = await h.routes.proposals.POST(h.req("/proposals", { proposalId: proposal.id, decision: "apply", revision: h.supa.db.workspace.revision, actionId: review }), h.routeContext);
  assert.equal(r.status, 200); await h.runAfter();
  const [decision] = h.byType("permission.decision"), [program] = h.byType("program.version");
  assert.equal(decision.caused_by, request.id); assert.equal(decision.metadata.reply, "apply"); assert.equal(decision.action_id, review);
  assert.equal(program.caused_by, decision.id); assert.equal(program.metadata.by, "agent-proposal");
  assert.ok(h.supa.db.history.includes(program.artifact_version), "artifact_version joins studio_research_history");
  const text = program.metadata.program ?? gunzipSync(h.supa.db.objects.get(`${ids.owner}/${program.content_refs[0].sha256}`)).toString();
  assert.equal(JSON.parse(text).title, "Revised title", "complete program content");
});

test("human autosave records only committed program/annotation changes", async () => {
  const h = harness();
  const save = d => h.routes.workspace.PATCH(h.req("", { document: d, expectedRevision: h.supa.db.workspace.revision }, "PATCH"), h.routeContext);
  const d = structuredClone(h.supa.db.workspace.document); d.reviewResponses = {};
  await save(d); await h.runAfter();
  assert.equal(h.events().length, 0, "a save without knowledge changes is not a version");
  const edited = structuredClone(h.supa.db.workspace.document); edited.model.title = "Edited by the researcher";
  await save(edited); await h.runAfter();
  const [program] = h.byType("program.version");
  assert.equal(program.metadata.by, "human"); assert.equal(program.artifact_version, h.supa.db.workspace.revision);
});

test("content larger than one part round-trips through gzip parts and a manifest", async () => {
  const supa = fakeSupabase();
  globalThis.fetch = (url, init) => supa.handle(url, init);
  const p = { ownerId: ids.owner, projectId: ids.workspace, at: now };
  const big = Array.from({ length: 250_000 }, (_, i) => `line ${String(i).padStart(10, "0")} αβγ\n`).join("");
  const batch = producer.buildServerBatch(p, "pipeline.build_result", "big", producer.packageFileEvents(p, { jobId: jobId(), revision: 2, files: [{ path: "paper/materials.txt", content: big }], actionId: null, causedBy: null }));
  const t = { url: "https://db.test", apikey: "k", bearer: "t", ownerId: ids.owner, mode: "user" };
  await outbox.deliverBatch(t, { events: batch.events, content: batch.content }, batch.id);
  const ref = batch.events.find(e => e.event_type === "artifact.version").content_refs[0];
  const manifestRow = supa.db.content.get(ref.sha256);
  assert.equal(manifestRow.kind, "manifest"); assert.ok(manifestRow.parts.length >= 2);
  const rebuilt = Buffer.concat(manifestRow.parts.map(part => gunzipSync(supa.db.objects.get(`${ids.owner}/${part}`))));
  assert.equal(sha(rebuilt), ref.sha256); assert.equal(rebuilt.toString("utf8"), big);
  await outbox.deliverBatch(t, { events: batch.events, content: batch.content }, batch.id);
  assert.equal(supa.db.events.size, batch.events.length, "duplicate delivery adds nothing");
});

test("browser events cannot impersonate server producers", () => {
  const types = ["click", "scroll", "selection", "visibility", "chat", "review", "layout"];
  const server = new Set(["conversation.message", "conversation.question", "conversation.error", "tool.start", "tool.end", "agent.turn_start", "agent.turn_end", "agent.usage", "permission.request", "permission.decision", "program.version", "artifact.version", "source.import"]);
  for (const type of types) {
    const e = webEvent.webResearchEvent({ id: ids.action, sessionId: ids.second, research: { installId: "browser-install-1", seq: 1 }, type, at: new Date().toISOString(), target: "chat-send", durationMs: 5, metadata: { action: "send", text: "forged reply", role: "assistant" } }, ids.workspace);
    assert.ok(!server.has(e.event_type), `${type} -> ${e.event_type}`);
    assert.notEqual(e.install_id, "web-server");
  }
});
