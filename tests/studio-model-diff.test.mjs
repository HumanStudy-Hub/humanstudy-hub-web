import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const localRequire = createRequire(import.meta.url);
const ts = localRequire("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "lib/studio/model-diff.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const loaded = { exports: {} };
new Function("require", "module", "exports", compiled)(localRequire, loaded, loaded.exports);
const { modelChanges } = loaded.exports;

const evidence = { page: 1, quote: "The source says so.", rects: [{ x: 1, y: 2, w: 3, h: 4 }] };
const entity = (id, kind = "analysis") => ({ id, kind, title: id, subtitle: "Brief", description: "Meaning", evidence, fields: [{ name: "Method", value: "t test", status: "reported" }], x: 0, y: 0, w: 100, h: 50 });
const model = () => ({ id: "study", title: "Study", source: { title: "Paper", authors: "A", filename: "paper.pdf" }, entities: [entity("participants", "participants"), entity("analysis")], relations: [{ from: "participants", to: "analysis", label: "contributes" }], procedure: [], variables: [{ id: "test", name: "test", role: "inferential", type: "t test", unit: "participant", producedBy: "analysis", usedBy: "result", definition: "Paired contrast", status: "reported", entity: "analysis" }], reviewIssues: [] });

test("adding and deleting entities and connections produces precise node changes", () => {
  const before = model();
  const after = model();
  after.entities = [entity("analysis"), entity("responses", "record")];
  after.relations = [{ from: "responses", to: "analysis", label: "supplies" }];
  const diff = modelChanges(before, after);
  assert.deepEqual(diff.addedEntityIds, ["responses"]);
  assert.deepEqual(diff.removedEntityIds, ["participants"]);
  assert.ok(diff.changedEntityIds.includes("analysis"));
  assert.ok(diff.sections.includes("relations"));
});

test("statistical methods, statuses, and definitions count as semantic changes", () => {
  const before = model();
  const after = model();
  after.entities[1].fields[0] = { name: "Method", value: "mixed model", status: "implementation" };
  after.variables[0].definition = "Mixed model with participant effects";
  const diff = modelChanges(before, after);
  assert.ok(diff.changedEntityIds.includes("analysis"));
  assert.ok(diff.entities.find(item => item.id === "analysis").details.some(item => item.includes("Method")));
  assert.ok(diff.sections.includes("variables"));
});

test("layout, evidence rectangles, and whitespace do not create proposal changes", () => {
  const before = model();
  const after = model();
  after.entities[0] = { ...after.entities[0], x: 999, y: 20, w: 30, h: 30, subtitle: "  Brief  ", evidence: { ...evidence, quote: " The source  says so. ", rects: [{ x: 20, y: 20, w: 2, h: 2 }] } };
  assert.equal(modelChanges(before, after).hasChanges, false);
});

test("procedure sequence and review questions are reported without imposing a record shape", () => {
  const before = model();
  const after = model();
  const step = id => ({ id, name: id, input: "", actor: "participant", output: "", evidence });
  before.procedure = [step("first"), step("second")];
  after.procedure = [step("second"), step("first")];
  after.reviewIssues = [{ id: "pairing", title: "Confirm pairing", severity: "decision", reason: "Unclear", impact: "Analysis", suggestedAction: "Ask researcher", entity: "analysis" }];
  const diff = modelChanges(before, after);
  assert.ok(diff.sections.includes("procedure"));
  assert.ok(diff.sections.includes("reviewIssues"));
  assert.ok(diff.details.includes("Procedure sequence changed"));
  assert.ok(diff.changedEntityIds.includes("analysis"));
});
