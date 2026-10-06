import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const localRequire = createRequire(import.meta.url);
const ts = localRequire("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function load(file, dependencies = {}) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", compiled)(id => dependencies[id] ?? localRequire(id), loadedModule, loadedModule.exports);
  return loadedModule.exports;
}
const tree = load("lib/studio/conversation-tree.ts");
const resources = load("lib/studio/resources.ts");
const validation = load("lib/studio/validation.ts", { "./conversation-tree": tree, "./resources": resources });
const at = "2026-10-05T00:00:00.000Z";
const message = (id, text = id, links = {}) => ({ id, role: "user", text, createdAt: at, ...links });
const conversation = (id, messages, parent) => ({ id, title: id, updatedAt: at, messages, ...(parent ? { parent } : {}), draft: "", modelAnchor: null, sourceSelection: null, selected: "" });
const ref = (conversationId, messageId) => ({ conversationId, messageId });
const document = conversations => ({ version: 1, title: "Study", model: { id: "study", title: "Study", source: { title: "", authors: "", filename: "" }, entities: [], relations: [], procedure: [], variables: [] },
  sources: [], annotations: [], conversations, reviewResponses: {} });

test("nested branch context stops at each fork and excludes siblings", () => {
  const conversations = [
    conversation("main", [message("m1"), message("m2"), message("later")]),
    conversation("side", [message("s1"), message("s2")], ref("main", "m2")),
    conversation("sibling", [message("other")], ref("main", "m2")),
    conversation("nested", [message("n1")], ref("side", "s1")),
  ];
  const saved = validation.validateStudioDocument(document(conversations));
  assert.deepEqual(tree.resolveConversationContext(saved.conversations, "nested").map(item => item.message.id), ["m1", "m2", "s1", "n1"]);
  assert.deepEqual(tree.resolveConversationContext(saved.conversations, "side", "s1").map(item => item.message.id), ["m1", "m2", "s1"]);
  assert.deepEqual(tree.scopeConversationsForPrompt(saved.conversations, "nested").map(item => [item.id, item.messages.map(message => message.id)]),
    [["main", ["m1", "m2"]], ["side", ["s1"]], ["nested", ["n1"]]]);
});

test("broken parent and message references are rejected before persistence", () => {
  const base = [conversation("main", [message("m1")])];
  assert.throws(() => validation.validateStudioDocument(document([...base, conversation("side", [message("s1")], ref("main", "lost"))])), /missing message/);
  assert.throws(() => validation.validateStudioDocument(document([conversation("main", [message("m1", "m1", { mergedFrom: ref("side", "lost") })])])), /missing message/);
  assert.throws(() => validation.validateStudioDocument(document([conversation("main", [message("m1", "m1", { replyTo: ref("other", "m2") })])])), /missing message/);
});

test("cycles reject even when every reference exists", () => {
  const conversations = [conversation("one", [message("a")], ref("two", "b")), conversation("two", [message("b")], ref("one", "a"))];
  assert.throws(() => validation.validateStudioDocument(document(conversations)), /cycle/);
});

test("flat documents still validate, and merge links retain the chosen message", () => {
  const conversations = [conversation("main", [message("m1"), message("merge", "Bring back", { mergedFrom: ref("side", "s1"), replyTo: ref("main", "m1") })]),
    conversation("side", [message("s1")], ref("main", "m1"))];
  const saved = validation.validateStudioDocument(document(conversations));
  assert.deepEqual(saved.conversations[0].messages[1].mergedFrom, ref("side", "s1"));
  assert.deepEqual(validation.validateStudioDocument(document([conversation("legacy", [message("old")])])).conversations[0].messages.map(item => item.id), ["old"]);
});
