import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

function loadTs(file, globals = {}, requireModule = () => { throw new Error("Unexpected import"); }) {
  const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const cjs = { exports: {} };
  vm.runInNewContext(code, { module: cjs, exports: cjs.exports, require: requireModule, ...globals }, { filename: file });
  return cjs.exports;
}

function fakePdf({ pages = 2, text = "hello world", pendingRender = false, invalidDimensions = false, textTransform = [10, 0, 0, 10, 10, 80] } = {}) {
  const made = [];
  const revoked = [];
  const progress = [];
  let destroyed = 0;
  let cleaned = 0;
  let cancelled = 0;
  let rejectRender;
  const page = (number) => ({
    getViewport: ({ scale }) => invalidDimensions
      ? { width: Infinity, height: 100, scale, transform: [scale, 0, 0, -scale, 0, 100 * scale] }
      : { width: 100 * scale, height: 100 * scale, scale, transform: [scale, 0, 0, -scale, 0, 100 * scale] },
    render: () => ({
      promise: pendingRender ? new Promise((_, reject) => { rejectRender = reject; }) : Promise.resolve(),
      cancel: () => { cancelled++; rejectRender?.(new Error("cancelled")); },
    }),
    getTextContent: async () => ({
      items: number === 2 && pages === 2 ? [] : [{ str: text, width: 50, transform: textTransform, fontName: "sans", dir: "ltr" }],
      styles: { sans: { fontFamily: "sans-serif" } },
    }),
    cleanup: () => { cleaned++; },
  });
  const pdfjs = {
    GlobalWorkerOptions: {},
    Util: { transform: (a, b) => [
      a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
    ] },
    getDocument: (options) => {
      assert.equal(options.isEvalSupported, false);
      return {
        promise: Promise.resolve({ numPages: pages, getPage: async (number) => page(number) }),
        destroy: async () => { destroyed++; },
      };
    },
  };
  const globals = {
    window: { document: { createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ measureText: (str) => ({ width: str.length * 10 }) }),
      toBlob: (callback) => callback(new Blob(["image"], { type: "image/webp" })),
    }) } },
    URL: { createObjectURL: () => { const url = `blob:test-${made.length}`; made.push(url); return url; }, revokeObjectURL: (url) => revoked.push(url) },
    Blob, DOMException, Uint8Array, Promise, Math,
  };
  const api = loadTs("lib/studio/pdf-client.ts", globals, (name) => {
    assert.equal(name, "pdfjs-dist");
    return pdfjs;
  });
  return { api, made, revoked, progress, get destroyed() { return destroyed; }, get cleaned() { return cleaned; }, get cancelled() { return cancelled; } };
}

test("PDF page words use viewport percentages and dispose revokes every object URL", async () => {
  const harness = fakePdf();
  const result = await harness.api.loadPdfPages(new ArrayBuffer(20), { onProgress: (done, total) => harness.progress.push([done, total]) });
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages[0].words.length, 2);
  assert.equal(result.pages[0].words[0].t, "hello");
  assert.equal(result.pages[0].words[0].x, 10);
  assert.ok(result.pages[0].words[0].y >= 11 && result.pages[0].words[0].y <= 13);
  assert.ok(result.pages[0].words.every((word) => word.x >= 0 && word.x + word.w <= 100 && word.y >= 0 && word.y + word.h <= 100));
  assert.equal(result.textPages[1].text, "");
  assert.deepEqual(Array.from(result.ocrRequiredPages), [2]);
  assert.deepEqual(harness.progress, [[0, 2], [1, 2], [2, 2]]);
  result.dispose();
  result.dispose();
  assert.deepEqual(harness.revoked, harness.made);
  assert.equal(harness.destroyed, 1);
  assert.equal(harness.cleaned, 2);
});

test("rotated PDF text yields bounded selectable boxes", async () => {
  const harness = fakePdf({ pages: 1, text: "rotated", textTransform: [0, 10, -10, 0, 80, 80] });
  const result = await harness.api.loadPdfPages(new ArrayBuffer(20));
  const [word] = result.pages[0].words;
  assert.equal(word.t, "rotated");
  assert.ok(word.x >= 0 && word.y >= 0 && word.x + word.w <= 100 && word.y + word.h <= 100);
  assert.ok(word.h > word.w);
  result.dispose();
});

test("PDF text and canvas stay within persistence and rendering limits", async () => {
  const harness = fakePdf({ pages: 40, text: "a".repeat(40_000) });
  const result = await harness.api.loadPdfPages(new ArrayBuffer(20));
  assert.equal(result.pages.length, 40);
  assert.ok(result.textPages.every((page) => page.text.length <= 30_000));
  assert.ok(result.textPages.reduce((sum, page) => sum + page.text.length, 0) <= 990_000);
  assert.equal(result.ocrRequiredPages.length, 0);
  result.dispose();
  assert.equal(harness.revoked.length, 40);

  const oversized = fakePdf({ invalidDimensions: true });
  await assert.rejects(oversized.api.loadPdfPages(new ArrayBuffer(20)), /invalid dimensions/);
  assert.equal(oversized.destroyed, 1);
  assert.equal(oversized.made.length, 0);
});

test("PDF abort cancels rendering and destroys the loading task", async () => {
  const harness = fakePdf({ pendingRender: true });
  const controller = new AbortController();
  const loading = harness.api.loadPdfPages(new ArrayBuffer(20), { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(loading, (error) => error.name === "AbortError");
  assert.equal(harness.cancelled, 1);
  assert.equal(harness.destroyed, 1);
  assert.equal(harness.revoked.length, 0);
});

class FakeElement {
  constructor({ tag = "div", attrs = {}, scrollHeight = 0, clientHeight = 0, scrollTop = 0 } = {}) {
    this.tagName = tag.toUpperCase();this.attrs = { ...attrs };this.scrollHeight = scrollHeight;this.clientHeight = clientHeight;this.scrollTop = scrollTop;
  }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  hasAttribute(name) { return name in this.attrs; }
  closest(selector) {
    const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attr) return attr[1] in this.attrs && (attr[2] === undefined || this.attrs[attr[1]] === attr[2]) ? this : null;
    return this;
  }
}

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (key) => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

function fakeTelemetry(fetchImpl, { storage, idOffset = 0, indexedDB } = {}) {
  let cleanup;
  let effectIndex=0;
  const effects=[];
  let state = { droppedEvents: 0, deliveryError: null };
  let nextId = idOffset;
  let refIndex = 0;
  const refs = [];
  const timers = new Map();
  const listeners = new Map();
  const makeRoot = () => {
    const events = new Map();
    return {
      events,
      getAttribute: () => "workspace-1",
      addEventListener: (type, listener) => { events.set(type, listener); listeners.set(`root:${type}`, listener); },
      removeEventListener: (type) => { events.delete(type); listeners.delete(`root:${type}`); },
      contains: () => true,
    };
  };
  let root = makeRoot();
  const doc = {
    visibilityState: "visible",
    querySelectorAll: () => [root],
    addEventListener: (type, listener) => listeners.set(`document:${type}`, listener),
    removeEventListener: (type) => listeners.delete(`document:${type}`),
  };
  const win = {
    addEventListener: (type, listener) => listeners.set(`window:${type}`, listener),
    removeEventListener: (type) => listeners.delete(`window:${type}`),
  };
  const react = {
    useCallback: (fn) => fn,
    useEffect: (fn, deps) => {
      const i=effectIndex++,previous=effects[i];
      if (previous && deps.every((item,index)=>Object.is(item,previous.deps[index]))) return;
      previous?.cleanup?.();
      effects[i]={cleanup:fn(),deps};
      cleanup=()=>effects.forEach(effect=>effect.cleanup?.());
    },
    useRef: (value) => refs[refIndex++] ??= { current: value },
    useState: (value) => [value, (next) => { state = typeof next === "function" ? next(state) : next; }],
  };
  const globals = {
    document: doc, window: win, Element: FakeElement, ...(storage ? { localStorage: storage } : {}), ...(indexedDB ? { indexedDB } : {}),
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}` },
    fetch: fetchImpl, AbortController, Date, Promise, queueMicrotask,
    HTMLInputElement: class {}, HTMLLabelElement: class {}, HTMLTextAreaElement: class {},
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => ++nextId,
    clearInterval: () => {},
  };
  const api = loadTs("lib/studio/use-telemetry.ts", globals, (name) => {
    if (name === "./telemetry-store") return loadTs("lib/studio/telemetry-store.ts", globals);
    if (name === "../research-data/web-operations") return loadTs("lib/research-data/web-operations.ts", globals);
    assert.equal(name, "react");
    return react;
  });
  let hook;
  const render = (surfaceVersion = 0, workspaceRevision = 1) => {
    refIndex = 0;effectIndex=0;
    hook = api.useStudioTelemetry({ workspaceId: "workspace-1", enabled: true, surfaceVersion, workspaceRevision });
  };
  render();
  return {
    get hook() { return hook; }, timers, listeners, get root() { return root; }, get state() { return state; },
    replaceRoot: () => { const previous = root; root = makeRoot(); return previous; },
    render,
    cleanup: () => cleanup?.(),
  };
}

test("telemetry batches 50 events, retries with stable IDs, and sends a bounded final keepalive", async () => {
  const requests = [];
  let failures = 1;
  const harness = fakeTelemetry((url, options) => {
    requests.push({ url, options, events: JSON.parse(options.body).events });
    if (failures--) return Promise.reject(new Error("offline"));
    return Promise.resolve({ ok: true, status: 200 });
  });
  for (let i = 0; i < 49; i++) harness.hook.action("composer.send", { type: "chat", metadata: { action: "send", ignoredText: "private content" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].events.length, 50);
  assert.equal(requests[0].events[1].metadata.ignoredText, undefined);
  assert.equal(harness.state.deliveryError, "Telemetry delivery is retrying.");
  const retry = [...harness.timers.values()].find((timer) => timer.delay === 1000);
  assert.ok(retry);
  retry.fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].events.map((event) => event.id), requests[0].events.map((event) => event.id));
  assert.equal(harness.state.deliveryError, null);
  harness.cleanup();
  assert.ok(requests.slice(2).every((request) => request.events.length <= 50 && request.options.keepalive));
});

test("telemetry preserves all offline events and bounds every unload batch", async () => {
  const requests = [];
  const harness = fakeTelemetry((url, options) => {
    requests.push({ url, options, events: JSON.parse(options.body).events });
    return new Promise(() => {});
  });
  for (let i = 0; i < 5100; i++) harness.hook.action("proposal.apply", { type: "review", metadata: { status: "open" } });
  assert.equal(harness.state.droppedEvents, 0, "no count-based pruning");
  harness.listeners.get("window:pagehide")();
  const unload = requests.slice(1);
  assert.ok(unload.length > 0);
  assert.ok(unload.every((request) => request.events.length <= 50 && request.options.keepalive));
  assert.ok(unload.reduce((sum, request) => sum + request.options.body.length, 0) <= 60_000);
  harness.cleanup();
});

test("telemetry quarantines single rejected events without dropping the rest of a batch", async () => {
  const requests = [], storage=fakeStorage();
  const harness = fakeTelemetry(async (url, options) => {
    const events=JSON.parse(options.body).events;requests.push(events);
    return {ok:events.length===1&&events[0].type!=="visibility",status:events.length===1&&events[0].type!=="visibility"?200:400};
  },{storage});
  for (let i=0;i<49;i++)harness.hook.action("composer.send",{type:"chat",metadata:{action:"send"}});
  await settle();
  assert.equal(harness.state.droppedEvents,0);
  assert.equal(requests.length,51);
  assert.equal([...storage.data.keys()].filter(k=>k.includes(':rejected:')).length,1);
  assert.equal([...storage.data.keys()].filter(k=>k.includes(':event:')).length,0);
  assert.match(harness.state.deliveryError,/retained locally/);
  harness.cleanup();
});

test("telemetry rebinds to a remounted workspace root without changing session", async () => {
  const requests = [];
  const harness = fakeTelemetry((_url, options) => {
    requests.push(JSON.parse(options.body).events);
    return Promise.resolve({ ok: true, status: 200 });
  });
  harness.hook.track("layout", { action: "collapse", area: "source" });
  const oldRoot = harness.replaceRoot();
  harness.render(1);
  assert.equal(oldRoot.events.size, 0, "old workspace listeners must be removed");
  assert.ok(harness.root.events.has("click"), "new workspace root must receive listeners");
  harness.hook.track("selection", { area: "source", selectionLength: 8 });
  harness.cleanup();
  await new Promise((resolve) => setImmediate(resolve));
  const events = requests.flat();
  const layout = events.find(event => event.type === "layout");
  const selection = events.find(event => event.type === "selection");
  assert.ok(layout && selection);
  assert.equal(layout.sessionId, selection.sessionId);
});

test('telemetry keeps the displayed revision of each event while an autosave advances the workspace',async()=>{
 const sent=[];const h=fakeTelemetry(async(_,options)=>{sent.push(JSON.parse(options.body));return new Response(null,{status:200});});
 h.hook.track('selection',{entityId:'design'});h.render(0,2);h.hook.track('selection',{entityId:'analysis'});h.cleanup();await new Promise(resolve=>setImmediate(resolve));
 const selections=sent.flatMap(batch=>batch.events).filter(e=>e.type==='selection');
 assert.deepEqual(selections.map(e=>e.displayRevision),[1,2]);assert.equal(selections[0].sessionId,selections[1].sessionId);
});

const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
const runTimers = (harness, delay) => { for (const [id, timer] of [...harness.timers]) if (timer.delay === delay) { harness.timers.delete(id); timer.fn(); } };

test("telemetry never listens to pointer movement and sends no coordinates", async () => {
  const sent = [];
  const h = fakeTelemetry(async (_url, options) => { sent.push(...JSON.parse(options.body).events); return { ok: true, status: 200 }; });
  assert.equal(h.root.events.has("pointermove"), false);
  assert.equal([...h.root.events.keys()].some((type) => type.startsWith("pointer") || type.startsWith("mouse") || type.startsWith("key")), false);
  const pane = new FakeElement({ attrs: { "data-event": "source-pane" }, scrollHeight: 2000, clientHeight: 1000 });
  for (const top of [100, 400, 900, 700]) { pane.scrollTop = top; h.root.events.get("scroll")({ target: pane }); }
  h.listeners.get("window:pagehide")();
  await settle();
  assert.ok(sent.every((event) => event.type !== "pointer" && event.x === undefined && event.y === undefined));
});

test("telemetry summarizes a scroll once it settles instead of recording every event", async () => {
  const sent = [];
  const h = fakeTelemetry(async (_url, options) => { sent.push(...JSON.parse(options.body).events); return { ok: true, status: 200 }; });
  const pane = new FakeElement({ attrs: { "data-event": "source-pane" }, scrollHeight: 2000, clientHeight: 1000 });
  for (const top of [100, 200, 500, 900, 600]) { pane.scrollTop = top; h.root.events.get("scroll")({ target: pane }); }
  assert.equal([...h.timers.values()].filter((timer) => timer.delay === 800).length, 1, "one pending settle timer per container");
  runTimers(h, 800);
  pane.scrollTop = 0; h.root.events.get("scroll")({ target: pane });
  h.render(1); // view change ends the open run
  h.cleanup();
  await settle();
  const scrolls = sent.filter((event) => event.type === "scroll");
  assert.equal(scrolls.length, 2);
  assert.deepEqual(scrolls[0].metadata, { status: "settled", startDepth: 100, endDepth: 600, maxDepth: 900 });
  assert.equal(scrolls[0].target, "source-pane");
  assert.ok(Number.isInteger(scrolls[0].durationMs));
  assert.deepEqual(scrolls[1].metadata, { status: "view", startDepth: 600, endDepth: 0, maxDepth: 600 });
});

test("a click handled by a semantic event is recorded once", async () => {
  const sent = [];
  const h = fakeTelemetry(async (_url, options) => { sent.push(...JSON.parse(options.body).events); return { ok: true, status: 200 }; });
  const send = new FakeElement({ tag: "button", attrs: { "data-event": "chat-send" } });
  h.root.events.get("click")({ target: send });
  await Promise.resolve();
  const id = h.hook.action("composer.send", { type: "chat", metadata: { action: "send" } });
  runTimers(h, 300);
  const other = new FakeElement({ tag: "button", attrs: { "data-event": "tab-sources" } });
  h.root.events.get("click")({ target: other });
  await Promise.resolve();
  h.hook.track("layout", { action: "collapse" });
  runTimers(h, 300);
  h.listeners.get("window:pagehide")();
  await settle();
  const actions = sent.filter((event) => event.type === "click" || event.type === "chat");
  assert.deepEqual(actions.map((event) => [event.type, event.target, event.metadata.via]), [["chat", "composer.send", "pointer"], ["click", "tab-sources", "pointer"]]);
  assert.equal(actions[0].id, id, "the send names the click's operation; its id is the action id");
  assert.equal(sent.find((event) => event.type === "layout").actionId, actions[1].id, "the layout change links to the generic click");
});

test("telemetry keeps failed events with backoff, persists them, and resends the same ids next visit", async () => {
  const storage = fakeStorage();
  const attempts = [];
  const offline = fakeTelemetry(async (_url, options) => { attempts.push(JSON.parse(options.body).events); throw new Error("offline"); }, { storage });
  for (let i = 0; i < 49; i++) offline.hook.action("proposal.apply", { type: "review", metadata: { status: "open" } });
  for (let i = 0; i < 8; i++) {
    await settle();
    const retry = [...offline.timers].find(([, timer]) => timer.delay >= 1000 && timer.delay !== 1500);
    assert.ok(retry, `retry ${i} scheduled`);
    offline.timers.delete(retry[0]);retry[1].fn();
  }
  await settle();
  assert.equal(offline.state.droppedEvents, 0);
  assert.ok(attempts.length >= 9);
  offline.listeners.get("window:pagehide")();
  const stored = [...storage.data.entries()].filter(([key]) => key.startsWith("hs-studio-telemetry:workspace-1:"));
  assert.ok(stored.length >= 51);
  const storedIds = stored.map(([,value]) => JSON.parse(value).id);
  assert.ok(storedIds.length >= 51);
  const delivered = [];
  const online = fakeTelemetry(async (_url, options) => { delivered.push(...JSON.parse(options.body).events); return { ok: true, status: 200 }; }, { storage, idOffset: 1_000_000 });
  await settle();
  for (const id of storedIds) assert.ok(delivered.some((event) => event.id === id), "stored event resent with its original id");
  runTimers(online, 1500);
  assert.equal([...storage.data.keys()].filter((key) => key.startsWith("hs-studio-telemetry:")).length, 0, "delivered events leave storage");
});

test("telemetry works when storage throws", async () => {
  const sent = [];
  const broken = { get length() { throw new Error("denied"); }, key() { throw new Error("denied"); }, getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  const h = fakeTelemetry(async (_url, options) => { sent.push(...JSON.parse(options.body).events); return { ok: true, status: 200 }; }, { storage: broken });
  h.hook.track("layout", { action: "collapse" });
  h.cleanup();
  await settle();
  assert.ok(sent.some((event) => event.type === "layout"));
});


// ---- T08: IndexedDB-backed durable queue ---------------------------------------------------
/** Minimal IndexedDB: object stores keyed by keyPath, transactions completing in a microtask. */
function fakeIndexedDB({ failPut = () => false } = {}) {
  const stores = new Map();
  const request = (result) => { const r = { result, onsuccess: null, onerror: null }; queueMicrotask(() => r.onsuccess?.()); return r; };
  const db = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore: (name) => { stores.set(name, new Map()); },
    transaction(name) {
      const tx = { oncomplete: null, onerror: null, onabort: null, error: null };
      let failed = false;
      tx.objectStore = () => ({
        put(value) { if (failPut()) { failed = true; tx.error = new Error("QuotaExceededError"); } else stores.get(name).set(value.key, JSON.parse(JSON.stringify(value))); return request(undefined); },
        delete(key) { stores.get(name).delete(key); return request(undefined); },
        getAll() { return request([...stores.get(name).values()]); },
      });
      queueMicrotask(() => (failed ? tx.onabort?.() : tx.oncomplete?.()));
      return tx;
    },
  };
  return { stores, open() { const r = { result: db }; queueMicrotask(() => { if (!stores.size) r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; } };
}
const idbEvents = (idb) => [...(idb.stores.get("events")?.values() ?? [])];

test("telemetry stores undelivered events in IndexedDB, not localStorage, and resends them after a restart", async () => {
  const idb = fakeIndexedDB(), storage = fakeStorage();
  const offline = fakeTelemetry(async () => { throw new Error("offline"); }, { storage, indexedDB: idb });
  for (let i = 0; i < 10; i++) offline.hook.action("proposal.apply", { type: "review", metadata: { status: "open" } });
  await settle();
  const saved = idbEvents(idb).map((row) => row.event.id);
  assert.ok(saved.length >= 11, "every event, including the visibility record, is durable in IndexedDB");
  assert.equal([...storage.data.keys()].filter((k) => k.includes(":event:")).length, 0, "localStorage stays free");
  const delivered = [];
  const online = fakeTelemetry(async (_url, options) => { delivered.push(...JSON.parse(options.body).events); return { ok: true, status: 200 }; }, { storage, indexedDB: idb, idOffset: 1_000_000 });
  await settle(); await settle();
  for (const id of saved) assert.ok(delivered.some((event) => event.id === id), "original id resent");
  await settle();
  assert.equal(idbEvents(idb).filter((row) => saved.includes(row.event.id)).length, 0, "acknowledged ids are removed");
  online.cleanup(); offline.cleanup();
});

test("telemetry falls back to localStorage when IndexedDB refuses a write (quota)", async () => {
  const idb = fakeIndexedDB({ failPut: () => true }), storage = fakeStorage();
  const h = fakeTelemetry(async () => { throw new Error("offline"); }, { storage, indexedDB: idb });
  h.hook.track("layout", { action: "collapse" });
  await settle();
  assert.equal(idbEvents(idb).length, 0);
  assert.ok([...storage.data.keys()].filter((k) => k.includes(":event:")).length >= 2, "kept in the fallback store");
  assert.notEqual(h.state.deliveryError, "Local research storage is full or unavailable. Keep this page open until delivery succeeds.");
  h.cleanup();
});

test("telemetry shows a storage failure when neither store accepts an event, and drops nothing", async () => {
  const idb = fakeIndexedDB({ failPut: () => true });
  const full = { ...fakeStorage(), get length() { return 0; }, key: () => null, getItem: () => null, setItem() { throw new Error("QuotaExceededError"); }, removeItem() {} };
  const sent = [];
  let online = false;
  const h = fakeTelemetry(async (_url, options) => { if (!online) throw new Error("offline"); sent.push(...JSON.parse(options.body).events); return { ok: true, status: 200 }; }, { storage: full, indexedDB: idb });
  for (let i = 0; i < 49; i++) h.hook.action("proposal.apply", { type: "review", metadata: { status: "open" } });
  await settle();
  assert.equal(h.state.deliveryError, "Local research storage is full or unavailable. Keep this page open until delivery succeeds.");
  assert.equal(h.state.droppedEvents, 0);
  online = true;
  const retry = [...h.timers].find(([, timer]) => timer.delay >= 1000);
  h.timers.delete(retry[0]); retry[1].fn();
  await settle();
  assert.equal(sent.filter((event) => event.type === "review").length, 49, "the in-memory queue still delivers every event");
  h.cleanup();
});

test("two tabs share durable storage without deleting each other's records", async () => {
  const idb = fakeIndexedDB(), storage = fakeStorage();
  const globals = { indexedDB: idb, localStorage: storage };
  const a = loadTs("lib/studio/telemetry-store.ts", globals).createTelemetryStore("workspace-1");
  const b = loadTs("lib/studio/telemetry-store.ts", globals).createTelemetryStore("workspace-1");
  const ev = (id) => ({ id, sessionId: "s", type: "review", at: new Date().toISOString() });
  assert.equal(await a.put([ev("a1"), ev("a2")]), "indexeddb");
  await b.put([ev("b1")]);
  assert.deepEqual([...(await b.all())].map((e) => e.id).sort(), ["a1", "a2", "b1"], "adoption reads everything");
  assert.equal(idbEvents(idb).length, 3, "reading never deletes");
  await b.remove(["b1", "a1"]);
  assert.deepEqual(idbEvents(idb).map((row) => row.event.id), ["a2"], "only acknowledged ids are removed");
  const other = loadTs("lib/studio/telemetry-store.ts", globals).createTelemetryStore("workspace-2");
  assert.equal((await other.all()).length, 0, "workspaces are isolated");
});
