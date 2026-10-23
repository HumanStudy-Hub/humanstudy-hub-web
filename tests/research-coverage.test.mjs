// T10 coverage check for the web surface, analogous to humanstudy-desktop
// app/src/main/research-coverage.test.mjs: a scripted source-to-program session drives the real
// browser operation tracker (lib/research-data/web-operations.ts) and browser queue through the
// events route, and the real server producers through the studio routes, against a mocked Supabase.
// The delivered rows are checked against docs/research-coverage-map.json (web column).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { load, ids, ctx, model, source, jobId, contract, producer, harness } from "./helpers/research-harness.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAP = JSON.parse(fs.readFileSync(path.join(root, "docs/research-coverage-map.json"), "utf8"));
const operations = load("lib/research-data/web-operations.ts");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
const EMAIL = ctx.user.email, API_KEY = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789", HOME_FILE = "/Users/researcher/Private/notes.txt";

test("coverage map lists every contract event type once, with a web capture point, gap or not_applicable", () => {
  const listed = Object.entries(MAP.data_types).flatMap(([type, spec]) => Object.keys(spec.event_types).map(e => [e, type]));
  assert.deepEqual(new Set(Object.keys(MAP.data_types)), new Set(contract.DATA_TYPES));
  assert.equal(new Set(listed.map(([e]) => e)).size, listed.length);
  assert.deepEqual(listed.map(([e]) => e).sort(), Object.keys(contract.EVENTS).sort());
  for (const [e, type] of listed) assert.equal(contract.EVENTS[e].dataType, type, `${e} belongs to ${type}`);
  for (const spec of Object.values(MAP.data_types)) for (const [e, surfaces] of Object.entries(spec.event_types))
    for (const s of ["desktop", "headless", "web"]) assert.ok(surfaces[s], `${e} states its ${s} capture point, gap or not_applicable`);
});

/** The browser half: the hook's event queue, delivered through the real events route. */
function browser(h) {
  const queue = [], session = crypto.randomUUID(), install = "browser-install-test";
  let seq = 0;
  const ops = operations.createWebOperations({
    emit: (type, fields) => queue.push({ id: crypto.randomUUID(), sessionId: session, type, at: new Date().toISOString(), research: { installId: install, seq: ++seq }, ...fields }),
    uuid: () => crypto.randomUUID(), now: () => Date.now(), later: (fn, ms) => setTimeout(fn, ms), cancel: handle => clearTimeout(handle), microtask: fn => queueMicrotask(fn),
  });
  const passive = (type, fields) => queue.push({ id: crypto.randomUUID(), sessionId: session, type, at: new Date().toISOString(), research: { installId: install, seq: ++seq }, ...fields });
  async function deliver() {
    while (queue.length) {
      const batch = queue.splice(0, 50);
      const response = await h.routes.events.POST(h.req("/events", { events: batch }), h.routeContext);
      assert.equal(response.status, 200, `events route accepted the browser batch: ${await response.clone().text()}`);
    }
  }
  return { ops, passive, deliver, queue };
}

function storedText(db) {
  return [...db.objects.values()].map(bytes => { try { return gunzipSync(bytes).toString("utf8"); } catch { return bytes.toString("utf8"); } }).join("\n");
}

function checkCoverage(rows, db, expected) {
  const byId = new Map(rows.map(r => [r.id, r]));
  const primaries = rows.filter(r => r.event_type === "action.invoke");
  assert.deepEqual(rows.flatMap(r => contract.validateResearchEvent(r).map(e => `${r.event_type}: ${e}`)), [], "every delivered row satisfies the contract");
  assert.ok(rows.every(r => r.surface === "web"));

  // Every agreed data type that applies to the web surface is present.
  for (const [type, spec] of Object.entries(MAP.data_types)) {
    if (Object.values(spec.event_types).every(s => /^not_applicable/.test(s.web))) continue;
    assert.ok(rows.some(r => r.data_type === type), `web: data type ${type} is present`);
  }
  // One primary action per operation.
  assert.equal(new Set(primaries.map(r => r.id)).size, primaries.length, "no duplicate primary actions");
  for (const p of primaries) { assert.equal(p.action_id, p.id); assert.ok(contract.ACTION_VIA.includes(p.metadata.via), `${p.target} via ${p.metadata.via}`); }
  for (const [id, label] of expected) assert.equal(primaries.filter(p => p.id === id).length, 1, `exactly one action.invoke for ${label}`);
  assert.equal(primaries.length, expected.size, `one action.invoke per operation, no generic duplicates (${primaries.map(p => p.target).join(", ")})`);

  // Causality: links resolve; downstream records are linked or explicitly labelled.
  const linkage = Object.fromEntries(Object.values(MAP.data_types).flatMap(spec => Object.keys(spec.event_types).map(t => [t, spec.linkage])));
  for (const r of rows) {
    if (r.action_id) assert.equal(byId.get(r.action_id)?.event_type, "action.invoke", `${r.event_type}.action_id resolves to a primary action (no orphan)`);
    if (r.caused_by) assert.ok(byId.has(r.caused_by), `${r.event_type}.caused_by resolves`);
    if (r.metadata.parent_action_id) assert.equal(byId.get(r.metadata.parent_action_id)?.event_type, "action.invoke", `${r.event_type} parent resolves`);
    const rule = linkage[r.event_type];
    assert.ok(rule, `${r.event_type} is in the coverage map`);
    if (rule === "required") assert.ok(r.action_id || r.metadata.trigger === "external", `${r.event_type} carries its initiating action`);
    if (rule === "required_or_labelled") assert.ok(r.action_id || ["baseline", "external"].includes(r.metadata.trigger), `${r.event_type} is linked or labelled (${r.metadata.trigger})`);
    const nav = MAP.data_types.navigation.event_types[r.event_type];
    if (nav && /passive/.test(nav.web)) assert.ok(!r.action_id, "passive navigation is never linked");
    if (r.data_type === "knowledge_artifact") assert.ok(["human-save", "baseline", "agent-proposal", "agent-tool"].includes(r.metadata.trigger), `${r.artifact_id} trigger ${r.metadata.trigger}`);
  }
  // Web-native identities.
  for (const r of rows.filter(r => r.event_type === "tool.start" || r.event_type === "tool.end")) {
    assert.match(r.tool_call_id, /^studio-/); assert.equal(r.target, "humanstudy.pipeline");
    if (r.event_type === "tool.start") assert.equal(r.metadata.native_id_reported, true);
  }
  for (const r of rows.filter(r => r.data_type === "agent_execution" || r.data_type === "conversation")) assert.equal(r.thread_id, ids.conversation);
  const committed = new Set(db.workspace.document.conversations.flatMap(c => c.messages.map(m => m.id)));
  for (const r of rows.filter(r => r.event_type === "conversation.message")) assert.ok(committed.has(r.message_id), "message ids are the committed message ids");

  // Prohibited streams and private values are absent from rows and stored content.
  assert.ok(!rows.some(r => contract.PROHIBITED_EVENT_RE.test(r.event_type)), "no pointer/keystroke/recording types");
  assert.ok(rows.every(r => contract.EVENTS[r.event_type]), "only contract event types");
  assert.ok(!rows.some(r => /^shortcut:[a-z0-9]$|^key/.test(r.target ?? "")), "no bare keystrokes");
  const everything = JSON.stringify(rows) + "\n" + storedText(db);
  for (const secret of [ctx.accessToken, API_KEY, EMAIL, "/Users/researcher", "token=secret"]) assert.ok(!everything.includes(secret), `absent from the dataset: ${secret.slice(0, 12)}…`);
  return { primaries, byId };
}

test("web: scripted source-to-program session has one primary action per operation and linked records", async () => {
  const h = harness();
  const db = h.supa.db, b = browser(h), { ops } = b, expected = new Map();
  const op = (label, id) => { expected.set(id, label); return id; };
  db.sources.set(source().path, Buffer.from("%PDF-1.4 abc"));
  const buildRequest = crypto.randomUUID(), discussRequest = crypto.randomUUID();
  const status = new Map();
  h.github.readOwnedStudioJob = async id => ({ ...h.job, id, status: status.get(id) ?? "queued", packageReady: status.get(id) === "review", updatedAt: "2026-01-03T00:00:00.000Z" });

  // 1. Import: choosing the file in the system picker is the operation; the archive links to it.
  const imported = op("source.import", ops.action("source.import", { via: "pointer", metadata: { action: "upload" } }));
  assert.equal((await h.routes.researchSource.POST(h.req("/research-source", { sourceId: ids.source, actionId: imported }), h.routeContext)).status, 200);

  // 2. Navigate: a tab click whose only record is the layout change -> one generic primary + linked layout.
  await tick(); const tab = op("tab click", ops.input("tab-sources", "pointer")); await tick();
  ops.record("layout", { action: "focus", area: "source", mode: "maximize" });
  await sleep(350);

  // 3. Select text without a click (standalone), then click a program card (generic click + linked selection).
  ops.record("selection", { mode: "text", page: 1, selectionLength: 40, sourceId: ids.source });
  await tick(); const card = op("card click", ops.input("button", "pointer")); await tick();
  ops.record("selection", { mode: "entity", area: "model", count: 1 });
  await sleep(350);

  // 4. Build: the button's handler names the click; the server references the browser's primary.
  await tick(); ops.input("button", "pointer"); await tick();
  const build = op("build.start", ops.action("build.start", { type: "chat", metadata: { action: "build", sourceId: ids.source } }));
  assert.equal((await h.send({ actionId: build, requestId: buildRequest, intent: "build", text: `Build this study. My key is ${API_KEY}, mail ${EMAIL}, notes ${HOME_FILE}.` })).status, 202);
  await h.runAfter();

  // 5. Composer Enter while the build turn runs: the send is its own operation inside the build.
  await tick(); ops.input("composer.enter", "keyboard", { fallback: false }); await tick();
  const send = op("composer.send", ops.action("composer.send", { type: "chat", metadata: { action: "send", parentActionId: build } }));
  assert.equal((await h.send({ actionId: send, requestId: discussRequest, intent: "discuss", text: "What sample size was reported?" })).status, 202);
  await h.runAfter();

  // 6. Results arrive (polling is not an operation): the package, then the discussion reply with a proposal.
  status.set(jobId(buildRequest), "review"); status.set(jobId(discussRequest), "complete");
  h.turn = { requestId: discussRequest, reply: "A more specific title.", model: model("Revised title") };
  assert.equal((await h.poll()).status, 200); await h.runAfter();

  // 7. Apply the discussion proposal (click): decision, program version, package sync dispatch.
  const proposal = db.workspace.document.conversations.flatMap(c => c.messages).find(m => m.proposal?.jobId === jobId(discussRequest)).proposal;
  await tick(); ops.input("button", "pointer"); await tick();
  const review = op("proposal.apply", ops.action("proposal.apply", { type: "review", metadata: { action: "apply", reviewId: proposal.id, parentActionId: send } }));
  assert.equal((await h.routes.proposals.POST(h.req("/proposals", { proposalId: proposal.id, decision: "apply", revision: db.workspace.revision, actionId: review }), h.routeContext)).status, 200);
  await h.runAfter();

  // 8. Save by shortcut: the save names the shortcut operation; the version links to it.
  const save = async (actionId) => {
    const d = structuredClone(db.workspace.document); d.model.title = `Edited ${Math.random()}`;
    const r = await h.routes.workspace.PATCH(h.req("", { document: d, expectedRevision: db.workspace.revision, ...(actionId ? { actionId } : {}) }, "PATCH"), h.routeContext);
    assert.equal(r.status, 200); await h.runAfter();
  };
  await tick(); ops.input("shortcut:cmd+s", "shortcut"); await tick();
  const saved = op("workspace.save", ops.action("workspace.save")); await save(saved);
  // 9. An autosave no operation named: one server system operation, recorded only because it committed a version.
  op("workspace.autosave (server)", producer.serverEventId(ids.owner, `action:save:${ids.workspace}:${db.workspace.revision + 1}`)); await save();

  // 10. An unclaimed shortcut (palette open) records its name once; choosing a palette command is via menu.
  await tick(); const palette = op("palette shortcut", ops.input("shortcut:cmd+shift+p", "shortcut")); await sleep(350);
  await tick(); ops.input("workspace.command.export", "menu"); await tick();
  const exported = op("workspace.export", ops.action("workspace.export"));
  // A second semantic name for the same operation is not a second primary.
  assert.equal(ops.action("workspace.export"), exported);

  // 11. Passive summaries.
  b.passive("scroll", { target: "source-pane", durationMs: 900, metadata: { status: "settled", startDepth: 0, endDepth: 400, maxDepth: 400 } });
  b.passive("visibility", { durationMs: 5000, metadata: { status: "hidden" } });
  await sleep(350); ops.settleAll(); await b.deliver(); await h.runAfter();

  const rows = [...db.events.values()];
  const { byId } = checkCoverage(rows, db, expected);
  const by = (type, f = () => true) => rows.filter(r => r.event_type === type && f(r));
  const primary = id => byId.get(id);
  assert.equal(primary(tab).target, "tab-sources", "generic click only because nothing semantic claimed it");
  assert.equal(by("layout.commit")[0].action_id, tab);
  const [standalone, linked] = by("selection.commit").sort((x, y) => x.client_seq - y.client_seq);
  assert.ok(!standalone.action_id, "a selection without a click is a standalone completion record");
  assert.equal(linked.action_id, card);
  assert.equal(by("source.import")[0].action_id, imported); assert.equal(by("source.import")[0].metadata.trigger, "import");
  assert.equal(primary(build).target, "build.start"); assert.equal(primary(build).metadata.via, "pointer");
  assert.equal(primary(send).metadata.via, "keyboard"); assert.equal(primary(send).metadata.parent_action_id, build);
  const discussStart = by("agent.turn_start", r => r.action_id === send)[0];
  assert.equal(discussStart.metadata.parent_action_id, build, "a message sent while the build runs happens inside it");
  assert.equal(by("conversation.message", r => r.action_id === send && r.metadata.role === "user")[0].metadata.status, "submitted_while_busy");
  const files = by("artifact.version", r => r.artifact_id.startsWith("package/"));
  assert.ok(files.length && files.every(f => f.action_id === build && f.metadata.trigger === "agent-tool" && byId.get(f.caused_by).event_type === "tool.end"));
  const decision = by("permission.decision")[0];
  assert.equal(decision.action_id, review); assert.equal(decision.caused_by, review); assert.equal(decision.metadata.parent_action_id, send);
  const [applied, human, autosave] = by("program.version").sort((x, y) => x.artifact_version - y.artifact_version);
  assert.equal(applied.metadata.trigger, "agent-proposal"); assert.equal(applied.caused_by, decision.id);
  assert.equal(human.action_id, saved); assert.equal(human.metadata.trigger, "human-save"); assert.equal(primary(saved).metadata.via, "shortcut");
  assert.equal(primary(autosave.action_id).metadata.via, "system"); assert.equal(primary(autosave.action_id).target, "workspace.autosave");
  assert.equal(by("tool.start", r => r.metadata.mode === "sync")[0].action_id, review, "the package sync the decision started links to it");
  assert.equal(primary(palette).target, "shortcut:cmd+shift+p");
  assert.equal(primary(exported).metadata.via, "menu"); assert.equal(primary(exported).target, "workspace.export");
  assert.ok(!by("action.invoke").some(r => r.target === "composer.enter"), "a composer Enter is never a record of its own");
});

test("web operations: fallback window, joins, records and system actions", async () => {
  const emitted = [];
  const ops = operations.createWebOperations({ emit: (type, fields) => emitted.push({ type, ...fields }), uuid: () => crypto.randomUUID(), now: () => Date.now(),
    later: (fn, ms) => setTimeout(fn, ms), cancel: h => clearTimeout(h), microtask: fn => queueMicrotask(fn) });
  // A semantic handler that awaits briefly (< 300 ms) still names the click.
  const click = ops.input("button", "pointer"); await sleep(100);
  assert.equal(ops.action("composer.send", { type: "chat" }), click);
  // A synthetic click inside the same dispatch joins the operation in progress.
  const key = ops.input("shortcut:cmd+b", "shortcut");
  assert.equal(ops.input("button", "pointer"), key, "same dispatch");
  await tick(); assert.equal(ops.input("button", "pointer", { join: true }), key, "synthetic click from the shortcut handler");
  await sleep(350);
  assert.deepEqual(emitted.map(e => [e.type, e.target, e.metadata.via]), [["chat", "composer.send", "pointer"], ["click", "shortcut:cmd+b", "shortcut"]]);
  // Without a user input in progress an action is a system operation.
  await sleep(350); const sys = ops.action("package.sync"); assert.notEqual(sys, key, "after the decided operation's window");
  assert.equal(emitted.at(-1).metadata.via, "system");
  // An unclaimed composer Enter leaves no record; its completion records stand alone.
  emitted.length = 0; ops.input("composer.enter", "keyboard", { fallback: false }); await tick(); ops.record("layout", { action: "x" }); await sleep(350);
  assert.deepEqual(emitted.map(e => [e.type, e.actionId]), [["layout", undefined]]);
  assert.equal(operations.shortcutName({ key: "s", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }), "cmd+s");
  assert.equal(operations.shortcutName({ key: "a", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false }), null, "plain keys are never named");
});
