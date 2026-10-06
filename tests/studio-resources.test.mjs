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
  const loaded = { exports: {} };
  new Function("require", "module", "exports", compiled)(id => dependencies[id] ?? requireLocal(id), loaded, loaded.exports);
  return loaded.exports;
}

class StudioError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }
const owner = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const ctx = { user: { id: owner }, accessToken: "owner-access-token" };
const resources = load("lib/studio/resources.ts");
const source = (id, name, includeInBuild = true) => {
  const spec = resources.sourceSpec(name);
  return { id, name, path: `${owner}/${workspaceId}/${id}.${spec.extension}`, mimeType: spec.mimeType, kind: spec.kind, size: 8, includeInBuild };
};
const paper = source("33333333-3333-4333-8333-333333333333", "primary.pdf");
const extraPdf = source("44444444-4444-4444-8444-444444444444", "extra.pdf");
const notes = source("55555555-5555-4555-8555-555555555555", "notes.txt", false);

test("resource formats and owned storage keys reject unsupported or foreign files", () => {
  for (const name of ["study.pdf", "notes.txt", "script.py", "analysis.r", "table.csv", "data.json", "image.png", "image.jpeg", "bundle.zip", "survey.docx", "data.xlsx"]) {
    assert.ok(resources.sourceSpec(name), name);
  }
  for (const name of ["x.html", "../x.pdf", "file.exe", "survey.doc", "sheet.xls"]) assert.equal(resources.sourceSpec(name), null);
  assert.equal(resources.validStoredSource(extraPdf, owner, workspaceId), true);
  assert.equal(resources.validStoredSource(extraPdf, "other-user", workspaceId), false);
  assert.equal(resources.validStoredSource({ ...notes, path: `${owner}/${workspaceId}/wrong.txt` }, owner, workspaceId), false);
});

test("auxiliary bundle includes supplementary PDFs, skips excluded files, and signs an owner-bound private ZIP", async () => {
  const calls = [];
  let uploaded;
  const http = {
    StudioError,
    studioConfig: () => ({ url: "https://storage.test" }),
    upstreamJson: async response => response.json(),
    async studioFetch(url, options = {}) {
      calls.push([url, options]);
      assert.equal(options.token, ctx.accessToken);
      if (url.includes("/object/authenticated/")) return new Response(new TextEncoder().encode(url.includes(extraPdf.id) ? "%PDF-1.4" : "notes!!!"));
      if (url.includes("/object/upload/sign/")) return Response.json({ url: "/object/upload/sign/studio-sources/placeholder?token=private-upload" });
      if (url.includes("/object/sign/")) return Response.json({ signedURL: url.replace("/storage/v1", "") + "?token=private-download" });
      throw new Error(`Unexpected request: ${url}`);
    },
  };
  const server = load("lib/studio/resource-server.ts", { "./http": http, "./resources": resources });
  const oldFetch = global.fetch;
  global.fetch = async (url, options) => { uploaded = { url, options }; return new Response(null, { status: 200 }); };
  try {
    const result = await server.prepareStudioResourceArchive(ctx, { id: workspaceId, document: { sources: [paper, extraPdf, notes] } }, paper.id);
    assert.deepEqual(result.sourceIds, [extraPdf.id]);
    assert.match(result.path, new RegExp(`^${owner}/${workspaceId}/[0-9a-f-]{36}\\.zip$`));
    assert.match(result.url, /token=private-download$/);
    assert.equal(server.isOwnedResourceArchivePath(result.path, ctx, workspaceId), true);
    assert.equal(server.isOwnedResourceArchivePath(result.path, ctx, "other-workspace"), false);
    assert.match(uploaded.url, /token=private-upload$/);
    assert.equal(uploaded.options.headers["Content-Type"], "application/zip");
    const zip = await JSZip.loadAsync(await uploaded.options.body.arrayBuffer());
    const manifest = JSON.parse(await zip.file("resource-manifest.json").async("string"));
    assert.equal(manifest.primarySourceId, paper.id);
    assert.deepEqual(manifest.files.map(file => file.id), [extraPdf.id]);
    assert.equal(await zip.file(`resources/${extraPdf.id}/extra.pdf`).async("string"), "%PDF-1.4");
    assert.equal(zip.file(`resources/${notes.id}/notes.txt`), null);
    assert.equal(calls.filter(([url]) => url.includes("/object/authenticated/")).length, 1);
  } finally { global.fetch = oldFetch; }
});

test("auxiliary bundle enforces total size and owner boundary before fetching", async () => {
  const http = { StudioError, studioConfig: () => ({ url: "https://storage.test" }), studioFetch: () => { throw new Error("must not fetch"); } };
  const server = load("lib/studio/resource-server.ts", { "./http": http, "./resources": resources });
  const oversized = { ...extraPdf, size: resources.MAX_PIPELINE_RESOURCE_BYTES + 1 };
  await assert.rejects(server.prepareStudioResourceArchive(ctx, { id: workspaceId, document: { sources: [paper, oversized] } }, paper.id), error => error.code === "resources_too_large");
  const foreign = { ...extraPdf, path: `another-owner/${workspaceId}/${extraPdf.id}.pdf` };
  await assert.rejects(server.prepareStudioResourceArchive(ctx, { id: workspaceId, document: { sources: [paper, foreign] } }, paper.id), error => error.code === "invalid_source");
  assert.equal(await server.prepareStudioResourceArchive(ctx, { id: workspaceId, document: { sources: [paper, notes] } }, paper.id), null);
});
