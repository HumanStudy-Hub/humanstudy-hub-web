import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const requireLocal = createRequire(import.meta.url);
const ts = requireLocal("typescript");
const JSZip = requireLocal("jszip");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
const programVersions = load("lib/studio/program-versions.ts", { "./model-version": modelVersion });
const owner = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const conversationId = "44444444-4444-4444-8444-444444444444";
const requestId = "55555555-5555-4555-8555-555555555555";
const proposalId = "66666666-6666-4666-8666-666666666666";
const messageId = "77777777-7777-4777-8777-777777777777";
const ctx = { user: { id: owner }, accessToken: "server-secret-access-token" };
const now = "2026-01-02T00:00:00.000Z";
const pdfBytes = new TextEncoder().encode("%PDF-1.4\nmock");
const source = { id: sourceId, name: "paper.pdf", path: `${owner}/${workspaceId}/${sourceId}.pdf`, mimeType: "application/pdf", size: pdfBytes.length, pages: [{ page: 1, text: "Participants read the instructions before the task." }] };
const model = title => ({ id: "study", title, source: { title: "", authors: "", filename: "" }, entities: [], relations: [], procedure: [], variables: [] });
const instructions = { id: "participant-instructions", title: "Participant instructions", filename: "instructions.md", format: "markdown", kind: "instructions", content: "# Instructions\nRead before responding.", sourceIds: [sourceId] };
const nextServer = { NextResponse: { json: (data, options = {}) => Response.json(data, { status: options.status || 200 }) } };

test("completed pipeline proposal requires apply, preserves edits, and exports an authenticated handoff", async () => {
  let authenticated = true, saveCount = 0, approvals = 0;
  let workspace = { id: workspaceId, title: "Study", revision: 4, created_at: now, updated_at: now, document: {
    version: 1, title: "Study", model: model("Researcher revision"), sources: [source], annotations: [], reviewResponses: {}, artifacts: [],
    pipeline: { jobId: `studio-${workspaceId}-${requestId}`, requestId, conversationId, sourceId, status: "review", message: "Package ready", updatedAt: now, proposalId },
    activeConversationId: conversationId,
    conversations: [{ id: conversationId, title: "Build this study", draft: "", updatedAt: now, modelAnchor: null, sourceSelection: null, selected: "", messages: [
      { id: requestId, role: "user", text: "Build this study", createdAt: now },
      { id: messageId, role: "agent", text: "The package is ready for review.", createdAt: now, proposal: { id: proposalId, model: model("Pipeline proposal"), changesModel: true, artifacts: [instructions], summary: "Generated package", status: "pending" } },
    ] }],
  } };
  const auth = { async requireStudioUser() { if (!authenticated) throw new StudioError(401, "unauthorized"); return ctx; } };
  const store = {
    async getWorkspace(_ctx, id) { return id === workspaceId ? workspace : null; },
    async saveWorkspace(_ctx, id, document, expectedRevision) {
      if (id !== workspaceId || expectedRevision !== workspace.revision) return { conflict: true, latest: workspace };
      saveCount++; workspace = { ...workspace, revision: workspace.revision + 1, document }; return workspace;
    },
  };
  const http = {
    StudioError,
    assertSameOrigin(req) { if (req.headers.get("origin") !== new URL(req.url).origin) throw new StudioError(403, "invalid_origin"); },
    isUuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value); },
    async readJsonBody(req) { return req.json(); },
    routeError(error) { return Response.json({ error: error instanceof StudioError ? error.code : "internal_error" }, { status: error instanceof StudioError ? error.status : 500 }); },
    async studioFetch(path, options) {
      assert.match(path, /authenticated\/studio-sources/);
      assert.equal(options.token, ctx.accessToken);
      return new Response(pdfBytes, { status: 200, headers: { "content-length": String(pdfBytes.length) } });
    },
  };
  const github = {
    async readOwnedStudioJob(id, identity) {
      assert.equal(id, workspace.document.pipeline.jobId);
      assert.deepEqual(identity, { ownerId: owner, workspaceId });
      return { id, status: "review", message: "Package ready", packageReady: true };
    },
    async listPackageFiles(){return [{path:"paper/protocol.md",content:Buffer.from("# Accepted package")}]},
    async approveStage(id, decision, identity) {
      assert.equal(workspace.document.model.title,"Pipeline proposal","remote approval follows model CAS");
      assert.equal(workspace.revision,5);
      assert.equal(id, workspace.document.pipeline.jobId);
      assert.deepEqual(decision, { decision: "approved" });
      assert.deepEqual(identity, { ownerId: owner, workspaceId });
      approvals++;
    },
  };
  const pipeline = load("lib/studio/pipeline.ts", { "@/lib/github-jobs": github, "./http": http, "./store": store, "./validation": validation, "./model-version": modelVersion, "./pipeline-adapter": {}, "./conversation-tree": conversationTree, "./resources": resources, "./resource-server": {} });
  const deps = { "next/server": nextServer, "@/lib/studio/auth": auth, "@/lib/studio/http": http, "@/lib/studio/store": store, "@/lib/studio/validation": validation, "@/lib/studio/model-version": modelVersion, "@/lib/studio/program-versions": programVersions, "@/lib/studio/pipeline": pipeline, "@/lib/studio/resources": resources, "@/lib/github-jobs": github, jszip: JSZip };
  const proposals = load("app/api/studio/workspaces/[id]/proposals/route.ts", deps);
  const exportRoute = load("app/api/studio/workspaces/[id]/export/route.ts", deps);
  const context = { params: Promise.resolve({ id: workspaceId }) };
  const url = `https://studio.test/api/studio/workspaces/${workspaceId}`;
  const decision = (revision, action = "apply") => new Request(`${url}/proposals`, { method: "POST", headers: { origin: "https://studio.test", "content-type": "application/json" }, body: JSON.stringify({ proposalId, decision: action, revision }) });

  authenticated = false;
  assert.equal((await proposals.POST(decision(4), context)).status, 401);
  assert.equal((await exportRoute.GET(new Request(`${url}/export`), context)).status, 401);
  assert.equal(saveCount, 0);
  authenticated = true;
  assert.equal((await proposals.POST(decision(3), context)).status, 409);
  assert.equal(saveCount, 0);
  assert.equal(workspace.document.model.title, "Researcher revision", "completed package must stay a pending proposal");

  const beforeApply = await exportRoute.GET(new Request(`${url}/export`), context);
  assert.equal(beforeApply.status, 200);
  const beforeZip = await JSZip.loadAsync(await beforeApply.arrayBuffer());
  const beforeManifest = JSON.parse(await beforeZip.file("manifest.json").async("string"));
  assert.equal(beforeManifest.pendingProposals[0].proposalId, proposalId);
  assert.equal(JSON.parse(await beforeZip.file("model.json").async("string")).title, "Researcher revision");

  const applied = await proposals.POST(decision(4), context);
  assert.equal(applied.status, 200);
  assert.equal(workspace.revision, 6);
  assert.equal(workspace.document.model.title, "Pipeline proposal");
  assert.equal(workspace.document.artifacts[0].content, instructions.content);
  assert.equal(workspace.document.conversations[0].messages[1].proposal.status, "applied");
  assert.equal(approvals, 1, "remote approval follows the authoritative model save");
  assert.equal((await proposals.POST(decision(5), context)).status, 409);
  assert.equal(approvals, 1);

  const exported = await exportRoute.GET(new Request(`${url}/export`), context);
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get("content-disposition"), /attachment/);
  const zip = await JSZip.loadAsync(await exported.arrayBuffer());
  const saved = JSON.parse(await zip.file("document.json").async("string"));
  const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
  assert.equal(saved.model.title, "Pipeline proposal");
  assert.equal(manifest.revision, 6);
  assert.equal(manifest.buildPackage.modelFingerprint,modelVersion.modelFingerprint(saved.model));
  assert.equal(await zip.file("build-package/paper/protocol.md").async("string"),"# Accepted package");
  assert.equal(manifest.pendingProposals.length, 0);
  assert.equal(await zip.file("materials/participant-instructions/instructions.md").async("string"), instructions.content);
  assert.equal(await zip.file(`source-files/${sourceId}.pdf`).async("string"), "%PDF-1.4\nmock");
  const allText = await Promise.all(Object.values(zip.files).filter(file => !file.dir && !file.name.endsWith(".pdf")).map(file => file.async("string")));
  assert.ok(allText.every(text => !text.includes(ctx.accessToken)), "export must not reveal server access token");

  workspace={...workspace,revision:workspace.revision+1,document:{...workspace.document,model:model("Edited after package acceptance")}};
  const staleZip=await JSZip.loadAsync(await (await exportRoute.GET(new Request(`${url}/export`),context)).arrayBuffer());
  const staleManifest=JSON.parse(await staleZip.file("manifest.json").async("string"));
  assert.match(staleManifest.buildPackage.reason,/older model revision/);
  assert.equal(staleZip.file("build-package/paper/protocol.md"),null,"an older package is never exported as current");
});
