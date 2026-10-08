import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const requireLocal = createRequire(import.meta.url);
const ts = requireLocal("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const sourceId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const eventId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ctx = { user: { id: userId, email: "owner@example.test" }, accessToken: "verified-access" };
const nextServer = { NextResponse: { json: (body, init = {}) => ({ body, status: init.status ?? 200, headers: init.headers ?? {} }) } };

function load(file, dependencies = {}) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loadedModule = { exports: {} };
  const localRequire = id => dependencies[id] || ((id === "./human-program" || id === "@/lib/studio/human-program") ? load("lib/studio/human-program.ts") : id === "./human-program.schema.json" ? JSON.parse(fs.readFileSync(path.join(root,"lib/studio/human-program.schema.json"),"utf8")) : requireLocal(id));
  new Function("require", "module", "exports", compiled)(localRequire, loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

const http = load("lib/studio/http.ts", { "next/server": nextServer });
const resources = load("lib/studio/resources.ts");
const store = load("lib/studio/store.ts", { "./http": http, "./resources": resources });
const jarValues = new Map();
const cookieWrites = [];
const jar = {
  get: key => jarValues.has(key) ? { value: jarValues.get(key) } : undefined,
  set: (key, value, options) => { jarValues.set(key, value); cookieWrites.push({ key, value, options }); },
  delete: key => { jarValues.delete(key); },
};
const auth = load("lib/studio/auth.ts", { "next/headers": { cookies: async () => jar }, "./http": http });

async function withService(run) {
  const prior = {
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_PUBLISHABLE_KEY,
    publicUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    publicKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    fetch: global.fetch,
  };
  process.env.SUPABASE_URL = "https://db.example.test";
  process.env.SUPABASE_PUBLISHABLE_KEY = "publishable-test";
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  jarValues.clear(); cookieWrites.length = 0;
  try { return await run(); }
  finally {
    for (const [key, value] of [["SUPABASE_URL", prior.url], ["SUPABASE_PUBLISHABLE_KEY", prior.key], ["NEXT_PUBLIC_SUPABASE_URL", prior.publicUrl], ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", prior.publicKey]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    global.fetch = prior.fetch;
    jarValues.clear(); cookieWrites.length = 0;
  }
}

const jsonRequest = (body, origin = "https://app.example.test", url = "https://app.example.test/api/studio") =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });

test("missing service configuration returns setup_required before cookie authentication", async () => {
  await withService(async () => {
    delete process.env.SUPABASE_URL; delete process.env.SUPABASE_PUBLISHABLE_KEY;
    await assert.rejects(auth.requireStudioUser(), error => error.status === 503 && error.code === "setup_required");
  });
});

test("access session uses a verified Supabase user and never trusts cookie identity", async () => withService(async () => {
  jarValues.set("studio_access", "access-one");
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json({ id: userId, email: "owner@example.test" });
  };
  assert.deepEqual(await auth.requireStudioUser(), { user: ctx.user, accessToken: "access-one" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://db.example.test/auth/v1/user");
  assert.equal(calls[0].options.headers.Authorization, "Bearer access-one");
  assert.equal(calls[0].options.headers.apikey, "publishable-test");
}));

test("expired session refreshes and verifies the new access token before rotating HttpOnly cookies", async () => withService(async () => {
  jarValues.set("studio_access", "expired"); jarValues.set("studio_refresh", "refresh-one");
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/auth/v1/user") && options.headers.Authorization === "Bearer expired") return new Response(null, { status: 401 });
    if (url.includes("grant_type=refresh_token")) return Response.json({ access_token: "access-two", refresh_token: "refresh-two", expires_in: 3600 });
    return Response.json({ id: userId, email: "owner@example.test" });
  };
  assert.equal((await auth.requireStudioUser()).accessToken, "access-two");
  assert.equal(calls.length, 3);
  assert.equal(JSON.parse(calls[1].options.body).refresh_token, "refresh-one");
  assert.equal(jarValues.get("studio_access"), "access-two");
  assert.equal(jarValues.get("studio_refresh"), "refresh-two");
  assert.ok(cookieWrites.every(write => write.options.httpOnly && write.options.sameSite === "lax" && write.options.path === "/"));
}));

test("rejected refresh clears both cookies and does not create a session", async () => withService(async () => {
  jarValues.set("studio_access", "expired"); jarValues.set("studio_refresh", "bad-refresh");
  global.fetch = async url => url.endsWith("/auth/v1/user") ? new Response(null, { status: 401 }) : new Response(null, { status: 400 });
  await assert.rejects(auth.requireStudioUser(), error => error.status === 401 && error.code === "unauthorized");
  assert.equal(jarValues.size, 0);
}));

test("signup without a Supabase session asks for confirmation without setting cookies", async () => withService(async () => {
  const route = load("app/api/studio/auth/route.ts", {
    "next/server": nextServer, "next/headers": { cookies: async () => jar },
    "@/lib/studio/auth": auth, "@/lib/studio/http": http,
  });
  global.fetch = async url => {
    assert.equal(new URL(url).pathname, "/auth/v1/signup");
    assert.equal(new URL(url).searchParams.get("redirect_to"), "https://app.example.test/auth/confirm");
    return Response.json({ user: { id: userId, email: "owner@example.test" }, session: null });
  };
  const response = await route.POST(jsonRequest({ action: "signup", email: "owner@example.test", password: "correct-horse" }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { user: null, requiresEmailConfirmation: true });
  assert.equal(jarValues.size, 0);
}));

const authRoute = load("app/api/studio/auth/route.ts", {
  "next/server": nextServer, "next/headers": { cookies: async () => jar },
  "@/lib/studio/auth": auth, "@/lib/studio/http": http,
});
const confirmation = { action: "confirm", tokenHash: "a".repeat(64), type: "email" };

test("email confirmation verifies the session owner before setting HttpOnly cookies", async () => withService(async () => {
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith("/verify")) return Response.json({ access_token: "confirmed-access", refresh_token: "confirmed-refresh", expires_in: 3600, user: { id: "untrusted" } });
    assert.equal(options.headers.Authorization, "Bearer confirmed-access");
    return Response.json({ id: userId, email: ctx.user.email });
  };
  const response = await authRoute.POST(jsonRequest(confirmation));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { user: ctx.user });
  assert.equal(requests[0].url, "https://db.example.test/auth/v1/verify");
  assert.deepEqual(JSON.parse(requests[0].options.body), { token_hash: confirmation.tokenHash, type: "email" });
  assert.equal(jarValues.get("studio_access"), "confirmed-access");
  assert.equal(jarValues.get("studio_refresh"), "confirmed-refresh");
  assert.ok(cookieWrites.every(write => write.options.httpOnly && write.options.sameSite === "lax"));
  assert.equal(response.headers["Cache-Control"], "no-store");
  assert.ok(!JSON.stringify(response.body).includes("confirmed-access"));
}));

test("invalid, recovery and cross-origin confirmations never call the provider", async () => withService(async () => {
  global.fetch = () => { throw new Error("must not fetch"); };
  for (const payload of [{ ...confirmation, tokenHash: "short" }, { ...confirmation, type: "recovery" }, { ...confirmation, type: "email_change" }]) {
    assert.equal((await authRoute.POST(jsonRequest(payload))).status, 400);
  }
  assert.equal((await authRoute.POST(jsonRequest(confirmation, "https://evil.example.test"))).status, 403);
  assert.equal(jarValues.size, 0);
}));

test("expired or unverifiable confirmations never create a session", async () => withService(async () => {
  global.fetch = async () => Response.json({ code: "otp_expired" }, { status: 403 });
  const expired = await authRoute.POST(jsonRequest(confirmation));
  assert.equal(expired.body.error, "confirmation_expired");
  assert.equal(jarValues.size, 0);
  global.fetch = async url => url.endsWith("/verify") ? Response.json({ access_token: "bad", refresh_token: "bad", expires_in: 3600 }) : new Response(null, { status: 401 });
  assert.equal((await authRoute.POST(jsonRequest(confirmation))).status, 401);
  assert.equal(jarValues.size, 0);
}));

test("resend uses the fixed return URL without requiring a password or revealing account existence", async () => withService(async () => {
  const prior = process.env.STUDIO_AUTH_ORIGIN;
  process.env.STUDIO_AUTH_ORIGIN = "https://stable.example.test";
  try {
    let request;
    global.fetch = async (url, options) => { request = { url: new URL(url), options }; return Response.json({}); };
    assert.equal((await authRoute.POST(jsonRequest({ action: "resend", email: "owner@example.test" }))).status, 200);
    assert.equal(request.url.pathname, "/auth/v1/resend");
    assert.equal(request.url.searchParams.get("redirect_to"), "https://stable.example.test/auth/confirm");
    assert.deepEqual(JSON.parse(request.options.body), { email: "owner@example.test", type: "signup" });
    global.fetch = async () => Response.json({ code: "user_not_found" }, { status: 404 });
    assert.equal((await authRoute.POST(jsonRequest({ action: "resend", email: "unknown@example.test" }))).status, 200);
    assert.equal(jarValues.size, 0);
    process.env.STUDIO_AUTH_ORIGIN = "https://stable.example.test/unsafe?next=other";
    assert.equal((await authRoute.POST(jsonRequest({ action: "resend", email: "owner@example.test" }))).body.error, "auth_redirect_setup_required");
  } finally { if (prior === undefined) delete process.env.STUDIO_AUTH_ORIGIN; else process.env.STUDIO_AUTH_ORIGIN = prior; }
}));

test("auth distinguishes pending confirmation, email delivery setup and send rate limits", async () => withService(async () => {
  for (const [code, expected] of [["email_not_confirmed", "email_not_confirmed"], ["email_address_not_authorized", "email_delivery_setup_required"], ["over_email_send_rate_limit", "rate_limited"]]) {
    global.fetch = async () => Response.json({ code }, { status: 400 });
    const response = await authRoute.POST(jsonRequest({ action: "signin", email: "owner@example.test", password: "correct-horse" }));
    assert.equal(response.body.error, expected);
    assert.equal(jarValues.size, 0);
  }
}));

test("mutation origin accepts public proxy origin and rejects unrelated or absent origins", () => {
  const proxied = new Request("http://internal.local/api/studio", { method: "POST", headers: {
    origin: "https://app.example.test", host: "internal.local", "x-forwarded-host": "app.example.test", "x-forwarded-proto": "https",
  } });
  assert.doesNotThrow(() => http.assertSameOrigin(proxied));
  assert.throws(() => http.assertSameOrigin(jsonRequest({}, "https://evil.example.test")), error => error.status === 403);
  assert.throws(() => http.assertSameOrigin(new Request("https://app.example.test/api", { method: "POST" })), error => error.status === 403);
});

test("JSON reader rejects lookalike MIME, malformed JSON, declared and streamed oversize bodies", async () => {
  await assert.rejects(http.readJsonBody(new Request("https://app.example.test", { method: "POST", headers: { "content-type": "application/jsonp" }, body: "{}" })), error => error.status === 415);
  await assert.rejects(http.readJsonBody(new Request("https://app.example.test", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })), error => error.status === 400);
  await assert.rejects(http.readJsonBody(new Request("https://app.example.test", { method: "POST", headers: { "content-type": "application/json", "content-length": "999" }, body: "{}" }), 8), error => error.status === 413);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{" + "x".repeat(100) + "}")); controller.close(); } });
  await assert.rejects(http.readJsonBody(new Request("https://app.example.test", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" }), 16), error => error.status === 413);
});

test("workspace reads carry verified owner/token and stale save uses CAS RPC", async () => withService(async () => {
  const calls = [];
  const latest = { id: workspaceId, revision: 2, title: "Study", document: { title: "Study", sources: [] } };
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.includes("/rpc/") ? [] : [latest]);
  };
  const document = { title: "Study", sources: [] };
  assert.deepEqual(await store.saveWorkspace(ctx, workspaceId, document, 1), { conflict: true, latest });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://db.example.test/rest/v1/rpc/studio_cas_workspace");
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_id: workspaceId, p_expected_revision: 1, p_document: document });
  assert.equal(calls[0].options.headers.Authorization, "Bearer verified-access");
  assert.match(calls[1].url, new RegExp(`owner_id=eq\\.${userId}`));
}));

test("store rejects foreign source paths and invalid revisions before calling storage", async () => withService(async () => {
  global.fetch = () => { throw new Error("must not fetch"); };
  const source = { id: sourceId, name: "paper.pdf", path: `other-user/${workspaceId}/${sourceId}.pdf`, mimeType: "application/pdf", size: 100 };
  await assert.rejects(store.saveWorkspace(ctx, workspaceId, { title: "Study", sources: [source] }, 1), error => error.status === 400 && error.code === "invalid_sources");
  await assert.rejects(store.saveWorkspace(ctx, workspaceId, { title: "Study", sources: [] }, 0), error => error.status === 400 && error.code === "invalid_revision");
  await assert.rejects(store.getWorkspace(ctx, "not-a-uuid"), error => error.status === 404);
}));

const eventRoute = load("app/api/studio/workspaces/[id]/events/route.ts", {
  "next/server": nextServer, "@/lib/studio/auth": { requireStudioUser: async () => ctx },
  "@/lib/studio/http": http, "@/lib/studio/store": { getWorkspaceMetadata: async () => ({ id: workspaceId, revision: 7 }) }, "@/lib/studio/resources": resources,
});
const eventContext = { params: Promise.resolve({ id: workspaceId }) };
const validEvent = () => ({ id: eventId, sessionId: "session_1", type: "click", at: new Date().toISOString(), target: "button[role-tab]", metadata: { area: "source" } });

test("event batch uses owner from verified context and idempotent insert preference", async () => withService(async () => {
  let sent;
  global.fetch = async (url, options) => { sent = { url, options }; return new Response(null, { status: 201 }); };
  const response = await eventRoute.POST(jsonRequest({ events: [validEvent(), validEvent()] }), eventContext);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { accepted: 2 });
  assert.equal(sent.options.headers.Prefer, "resolution=ignore-duplicates,return=minimal");
  const rows = JSON.parse(sent.options.body);
  assert.equal(rows[0].owner_id, userId);
  assert.equal(rows[0].workspace_id, workspaceId);
  assert.equal(rows[0].workspace_revision, 7);
  assert.equal(rows[0].id, rows[1].id);
  assert.equal(rows[0].target, "button[role-tab]");
  assert.equal(rows[0].metadata.area, "source");
}));

test("semantic layout and selection events persist bounded metadata with server revision", async () => withService(async () => {
  let rows;
  global.fetch = async (_url, options) => { rows = JSON.parse(options.body); return new Response(null, { status: 201 }); };
  const events = [
    { ...validEvent(), id: crypto.randomUUID(), type: "selection", metadata: { area: "source", mode: "text", page: 3, selectionLength: 42, sourceId, }, workspaceRevision: 999 },
    { ...validEvent(), id: crypto.randomUUID(), type: "layout", metadata: { area: "agent", action: "resize", mode: "expanded", count: 35 }, workspaceRevision: 999 },
  ];
  const response = await eventRoute.POST(jsonRequest({ events }), eventContext);
  assert.equal(response.status, 200);
  assert.deepEqual(rows.map(row => row.event_type), ["selection", "layout"]);
  assert.deepEqual(rows.map(row => row.workspace_revision), [7, 7]);
  assert.ok(rows.every(row => !Object.hasOwn(row, "workspaceRevision")));
  assert.equal(rows[0].metadata.selectionLength, 42);
  assert.equal(rows[1].metadata.count, 35);
}));

test("event route rejects raw DOM text, oversized batches, and cross-origin input before insert", async () => withService(async () => {
  global.fetch = () => { throw new Error("must not fetch"); };
  const rawText = { ...validEvent(), metadata: { text: "participant answer" } };
  assert.equal((await eventRoute.POST(jsonRequest({ events: [rawText] }), eventContext)).status, 400);
  assert.equal((await eventRoute.POST(jsonRequest({ events: [{ ...validEvent(), type: "selection", metadata: { selectionLength: 100_001 } }] }), eventContext)).status, 400);
  assert.equal((await eventRoute.POST(jsonRequest({ events: [{ ...validEvent(), type: "layout", metadata: { count: -1 } }] }), eventContext)).status, 400);
  assert.equal((await eventRoute.POST(jsonRequest({ events: [{ ...validEvent(), target: "Submit password" }] }), eventContext)).status, 400);
  assert.equal((await eventRoute.POST(jsonRequest({ events: Array.from({ length: 101 }, validEvent) }), eventContext)).status, 400);
  assert.equal((await eventRoute.POST(jsonRequest({ events: [validEvent()], padding: "x".repeat(130_000) }), eventContext)).status, 413);
  assert.equal((await eventRoute.POST(jsonRequest({ events: [validEvent()] }, "https://evil.example.test"), eventContext)).status, 403);
}));

const sourceRoute = load("app/api/studio/workspaces/[id]/sources/route.ts", {
  "next/server": nextServer, "@/lib/studio/auth": { requireStudioUser: async () => ctx },
  "@/lib/studio/http": http, "@/lib/studio/store": { getWorkspace: async () => ({ id: workspaceId }) }, "@/lib/studio/resources": resources,
});

test("signed upload uses owner/workspace PDF path, token, size cap, and authenticated signer", async () => withService(async () => {
  let call;
  global.fetch = async (url, options) => {
    call = { url, options };
    return Response.json({ url: "/object/upload/sign/studio-sources/path?token=upload-token" });
  };
  const response = await sourceRoute.POST(jsonRequest({ name: "paper.pdf", mimeType: "application/pdf", size: 500 }), eventContext);
  assert.equal(response.status, 201);
  assert.match(response.body.source.path, new RegExp(`^${userId}/${workspaceId}/[0-9a-f-]{36}\\.pdf$`));
  assert.equal(response.body.uploadUrl, `https://db.example.test/storage/v1/object/upload/sign/studio-sources/${response.body.source.path}?token=upload-token`);
  assert.equal(response.body.method, "PUT");
  assert.equal(response.body.headers["Content-Type"], "application/pdf");
  assert.equal(call.url, `https://db.example.test/storage/v1/object/upload/sign/studio-sources/${response.body.source.path}`);
  assert.equal(call.options.headers.Authorization, "Bearer verified-access");
  assert.equal((await sourceRoute.POST(jsonRequest({ name: "large.pdf", mimeType: "application/pdf", size: 25 * 1024 * 1024 + 1 }), eventContext)).status, 400);
  const resource = await sourceRoute.POST(jsonRequest({ name: "notes.txt", mimeType: "text/plain", size: 500 }), eventContext);
  assert.equal(resource.status, 201);
  assert.equal(resource.body.source.kind, "resource");
  assert.match(resource.body.source.path, /[.]txt$/);
  assert.equal(resource.body.headers["Content-Type"], "text/plain");
  assert.equal((await sourceRoute.POST(jsonRequest({ name: "script.html", mimeType: "text/html", size: 500 }), eventContext)).status, 400);
}));

test("download signing rejects source metadata outside authenticated owner prefix", async () => withService(async () => {
  const source = { id: sourceId, name: "paper.pdf", path: `other-user/${workspaceId}/${sourceId}.pdf`, mimeType: "application/pdf", size: 500 };
  const route = load("app/api/studio/workspaces/[id]/sources/[sourceId]/route.ts", {
    "next/server": nextServer, "@/lib/studio/auth": { requireStudioUser: async () => ctx },
    "@/lib/studio/http": http, "@/lib/studio/store": { getWorkspace: async () => ({ document: { sources: [source] } }) }, "@/lib/studio/resources": resources,
  });
  global.fetch = () => { throw new Error("must not fetch"); };
  const response = await route.GET(new Request("https://app.example.test/api"), { params: Promise.resolve({ id: workspaceId, sourceId }) });
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: "not_found" });
}));

test("download signer returns only the owned PDF's Supabase signed URL", async () => withService(async () => {
  const source = { id: sourceId, name: "paper.pdf", path: `${userId}/${workspaceId}/${sourceId}.pdf`, mimeType: "application/pdf", size: 500 };
  const route = load("app/api/studio/workspaces/[id]/sources/[sourceId]/route.ts", {
    "next/server": nextServer, "@/lib/studio/auth": { requireStudioUser: async () => ctx },
    "@/lib/studio/http": http, "@/lib/studio/store": { getWorkspace: async () => ({ document: { sources: [source] } }) }, "@/lib/studio/resources": resources,
  });
  let sent;
  global.fetch = async (url, options) => {
    sent = { url, options };
    return Response.json({ signedURL: `/object/sign/studio-sources/${source.path}?token=download-token` });
  };
  const response = await route.GET(new Request("https://app.example.test/api"), { params: Promise.resolve({ id: workspaceId, sourceId }) });
  assert.equal(response.status, 200);
  assert.equal(response.body.url, `https://db.example.test/storage/v1/object/sign/studio-sources/${source.path}?token=download-token`);
  assert.equal(sent.url, `https://db.example.test/storage/v1/object/sign/studio-sources/${source.path}`);
  assert.equal(sent.options.headers.Authorization, "Bearer verified-access");
  assert.deepEqual(JSON.parse(sent.options.body), { expiresIn: 3600 });
}));

test('events preserve an observed display revision distinct from the server revision',async()=>withService(async()=>{
 let rows;global.fetch=async(_,options)=>{rows=JSON.parse(options.body);return new Response(null,{status:201});};
 const result=await eventRoute.POST(jsonRequest({events:[{...validEvent(),displayRevision:3}]}),eventContext);
 assert.equal(result.status,200);assert.equal(rows[0].display_revision,3);assert.equal(rows[0].workspace_revision,7);
 assert.equal((await eventRoute.POST(jsonRequest({events:[{...validEvent(),displayRevision:8}]}),eventContext)).status,400);
}));

const researchRoute=load('app/api/studio/workspaces/[id]/research-data/route.ts',{'next/server':nextServer,'@/lib/studio/auth':{requireStudioUser:async()=>ctx},'@/lib/studio/http':http,'@/lib/studio/store':{getWorkspaceMetadata:async()=>({id:workspaceId,revision:7})}});
test('research exports paginate by scientific revision and stable event cursor with ownership filters',async()=>withService(async()=>{
 let queried;global.fetch=async(url)=>{queried=new URL(url);const isHistory=queried.pathname.endsWith('studio_research_history');return new Response(JSON.stringify(Array.from({length:101},(_,i)=>isHistory?{revision:i+1,knowledge:{}}:{id:eventId,created_at:'2026-10-07T00:00:00.123456+00:00'})),{headers:{'content-type':'application/json'}});};
 const request=(query)=>new Request(`https://studio.test/api/studio/workspaces/${workspaceId}/research-data?${query}`);
 const h=await researchRoute.GET(request('dataset=knowledge'),eventContext);assert.equal(h.status,200);assert.equal(h.body.records.length,1);assert.equal(h.body.nextCursor,'1');assert.equal(queried.searchParams.get('owner_id'),`eq.${userId}`);
 await researchRoute.GET(request('dataset=knowledge&after=100'),eventContext);assert.equal(queried.searchParams.get('revision'),'gt.100');
 const e=await researchRoute.GET(request('dataset=use'),eventContext);assert(e.body.nextCursor);await researchRoute.GET(request(`dataset=use&after=${e.body.nextCursor}`),eventContext);assert.match(queried.searchParams.get('or'),/123456/);assert.match(queried.searchParams.get('or'),new RegExp(eventId));
 assert.equal((await researchRoute.GET(request('dataset=use&after=not-json'),eventContext)).status,400);
 assert.equal((await researchRoute.GET(request('dataset=knowledge&after=1,owner_id.eq.other'),eventContext)).status,400);
}));

test('frequent telemetry ownership lookup reads no study content',async()=>withService(async()=>{
 let requested;global.fetch=async(url)=>{requested=new URL(url);return new Response(JSON.stringify([{id:workspaceId,revision:3}]),{headers:{'content-type':'application/json'}});};
 assert.deepEqual(await store.getWorkspaceMetadata(ctx,workspaceId),{id:workspaceId,revision:3});
 assert.equal(requested.searchParams.get('select'),'id,revision');assert.equal(requested.searchParams.get('owner_id'),`eq.${userId}`);
}));
