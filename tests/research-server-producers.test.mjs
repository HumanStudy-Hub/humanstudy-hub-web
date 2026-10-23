// T08: server-owned research producers, durable outbox and delivery, against an in-memory Supabase
// that implements the RPC, outbox guard, Storage, research_content and research_events semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";

import { sha, ids, now, ctx, model, jobId, contract, producer, outbox, webEvent, fakeSupabase, harness } from "./helpers/research-harness.mjs";

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
  assert.equal(decision.caused_by, review, "T10: a researcher's reply is caused by the answering operation"); assert.equal(decision.metadata.reply, "apply"); assert.equal(decision.action_id, review);
  assert.equal(decision.metadata.permission_id, request.metadata.permission_id); assert.equal(decision.metadata.parent_action_id, ids.action, "inside the turn that proposed it");
  assert.equal(program.metadata.trigger, "agent-proposal");
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
  assert.equal(program.metadata.trigger, "human-save");
  const [autosave] = h.byType("action.invoke");
  assert.equal(program.action_id, autosave.id, "an autosave no browser operation named is one system operation");
  assert.equal(autosave.metadata.via, "system"); assert.equal(autosave.target, "workspace.autosave");
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

// ---- forged outbox payloads: the service-role drain re-validates what RLS would refuse ----------

function forgedOutbox(mutate) {
  const supa = fakeSupabase();
  globalThis.fetch = (url, init) => supa.handle(url, init);
  const p = { ownerId: ids.owner, projectId: ids.workspace, at: new Date().toISOString() };
  const batch = producer.buildServerBatch(p, "chat.submit", "forged", producer.submitEvents(p, { requestId: ids.request, conversationId: ids.conversation, text: "Long text ".repeat(1200), mode: "discuss", jobId: jobId() }));
  const row = structuredClone(outbox.outboxRow(ids.owner, batch));
  mutate?.(row.payload, supa);
  // Inserted directly by the owner (the RLS insert policy allows any payload shape).
  supa.db.outbox.set(row.id, { ...row, attempts: 0, last_attempt_at: null, last_error: null, delivered_at: null, created_at: new Date().toISOString() });
  return { supa, row };
}
const service = { url: "https://db.test", apikey: "service-key", bearer: "service-key" };
const message = payload => payload.events.find(e => e.event_type === "conversation.message");

test("service drain delivers a valid outbox batch after re-validating it", async () => {
  const { supa, row } = forgedOutbox();
  assert.deepEqual(await outbox.drainAll(service), { checked: 1, delivered: 1, pending: 0, rejected: 0 });
  assert.equal(supa.db.events.size, row.event_count);
});

for (const [label, mutate] of [
  ["wrong surface", payload => { for (const e of payload.events) e.surface = "desktop"; }],
  ["another owner's rows", payload => { message(payload).owner_id = "99999999-9999-4999-8999-999999999999"; }],
  ["foreign content path", (payload, supa) => {
    const other = "99999999-9999-4999-8999-999999999999", foreign = sha(Buffer.from("someone else's paper"));
    supa.db.objects.set(`${other}/${foreign}`, Buffer.from("x"));
    message(payload).content_refs.push({ role: "source", sha256: foreign, bytes: 20, mime: "application/pdf" });
  }],
  ["content bytes that do not match their hash", payload => { payload.content[0].text += " tampered"; }],
  ["future timestamp", payload => { message(payload).occurred_at = new Date(Date.now() + 3_600_000).toISOString(); }],
  ["timestamp before the collector existed", payload => { message(payload).occurred_at = "2025-06-01T00:00:00.000Z"; }],
  ["banned continuous stream type", payload => { message(payload).event_type = "pointer.move"; }],
  ["credential in metadata", payload => { message(payload).metadata.note = "sk-or-v1-abcdefghijklmnopqrstuvwxyz0123"; }],
  ["home directory path", payload => { message(payload).metadata.note = "see /Users/researcher/private/notes.txt"; }],
  ["another research session", payload => { message(payload).research_session_id = ids.second; }],
  ["consent version the owner never accepted", payload => { for (const e of payload.events) e.consent_version = 2; }],
  ["extra column", payload => { message(payload).received_at = "2026-01-02T00:00:00.000Z"; }],
]) {
  test(`service drain rejects a forged outbox payload whole: ${label}`, async () => {
    const { supa, row } = forgedOutbox(mutate);
    const result = await outbox.drainAll(service);
    assert.equal(result.rejected, 1, label);
    assert.equal(supa.db.events.size, 0, "nothing of the batch is delivered");
    assert.equal(supa.db.content.size, 0, "no content is stored for a rejected batch");
    const stored = supa.db.outbox.get(row.id);
    assert.match(stored.last_error, /^rejected:/, "quarantined: visible as rejected in research_server_outbox_delivery");
    assert.ok(stored.payload, "payload kept for review");
    assert.deepEqual(await outbox.drainAll(service), { checked: 0, delivered: 0, pending: 0, rejected: 0 }, "not retried automatically");
  });
}

test("drain without the owner's web agreement leaves the batch pending", async () => {
  const { supa, row } = forgedOutbox((_p, s) => { s.fail.consent = null; });
  assert.equal((await outbox.drainAll(service)).pending, 1);
  assert.equal(supa.db.events.size, 0);
  assert.match(supa.db.outbox.get(row.id).last_error, /^consent_missing$/);
});

test("validateOutboxPayload mirrors the research_text_is_clean check", () => {
  assert.equal(outbox.researchTextIsClean("https://example.org/Users/x/y and C:/tmp"), true);
  assert.equal(outbox.researchTextIsClean("/home/alice/secret.txt"), false);
  assert.equal(outbox.researchTextIsClean("C:\\Users\\Alice\\file"), false);
});
