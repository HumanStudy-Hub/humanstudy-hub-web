// Shared T08/T10 harness: the real research modules and studio routes against an in-memory
// Supabase (RPC, outbox guard, Storage, research_content, research_events semantics).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const requireLocal = createRequire(import.meta.url), ts = requireLocal("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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
    outbox: new Map(), content: new Map(), objects: new Map(), events: new Map(), history: [], sources: new Map() };
  const fail = { events: 0, eventsStatus: 503, rpcMissing: false, rpcOutbox: true, consent: {} };
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
    const representation = /return=representation/.test(init.headers?.Prefer ?? "");
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
    if (p === "/rest/v1/research_consents") return reply(fail.consent === null ? [] : [{ version: 3, sources: true, ...fail.consent }]);
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
        const owner = body.owner_id ?? ids.owner; // column default auth.uid()
        if (!db.objects.has(`${owner}/${body.sha256}`)) return reply({}, 403); // row only after the object
        db.content.set(body.sha256, { ...body, owner_id: owner }); return representation ? reply([body], 201) : reply(null, 201);
      }
      const hash = q.get("sha256").slice(3); return reply(db.content.has(hash) ? [{ sha256: hash }] : []);
    }
    if (p.startsWith("/storage/v1/object/info/authenticated/research-content/")) {
      const key = p.slice("/storage/v1/object/info/authenticated/research-content/".length);
      return db.objects.has(key) ? reply({ name: key, size: db.objects.get(key).length }) : reply({}, 404);
    }
    if (p.startsWith("/storage/v1/object/authenticated/studio-sources/")) {
      const key = p.slice("/storage/v1/object/authenticated/studio-sources/".length);
      return db.sources.has(key) ? new Response(db.sources.get(key)) : reply({}, 404);
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
          const { owner_id = ids.owner, ...event } = row; // column default auth.uid()
          if (owner_id !== ids.owner || contract.validateResearchEvent(event).length) return reply({ message: "check_violation" }, 400);
          for (const ref of event.content_refs) if (!db.content.has(ref.sha256)) return reply({}, 409);
        }
        for (const row of body) if (!db.events.has(row.id)) db.events.set(row.id, { owner_id: ids.owner, ...row });
        return representation ? reply(body, 201) : reply(null, 201);
      }
      const session = q.get("research_session_id")?.slice(3);
      const type = q.get("event_type")?.slice(3), record = q.get("metadata->>source_record_id")?.slice(3);
      return reply([...db.events.values()].filter(e => (!session || e.research_session_id === session) && (!type || e.event_type === type) && (!record || e.metadata.source_record_id === record)).map(e => ({ id: e.id, source_id: e.source_id })));
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
    events: load("app/api/studio/workspaces/[id]/events/route.ts", { ...deps, "@/lib/research-data/web-event": webEvent }),
    researchSource: load("app/api/studio/workspaces/[id]/research-source/route.ts", { ...deps, "@/lib/studio/resources": resources,
      "@/lib/research-data/archive-source": load("lib/research-data/archive-source.ts", { "../studio/http": http, "./contract": contract }) }),
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

export { load, sha, ids, now, ctx, model, source, doc, jobId, contract, http, resources, conversationTree, validation, modelVersion, producer, outbox, webEvent, fakeSupabase, harness };
