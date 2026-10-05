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

function fakeTelemetry(fetchImpl) {
  let cleanup;
  let state = { droppedEvents: 0, deliveryError: null };
  let nextId = 0;
  const timers = new Map();
  const listeners = new Map();
  const root = {
    getAttribute: () => "workspace-1",
    addEventListener: (type, listener) => listeners.set(`root:${type}`, listener),
    removeEventListener: (type) => listeners.delete(`root:${type}`),
    contains: () => true,
  };
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
    useEffect: (fn) => { cleanup = fn(); },
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, (next) => { state = typeof next === "function" ? next(state) : next; }],
  };
  const globals = {
    document: doc, window: win, Element: class {},
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}` },
    fetch: fetchImpl, AbortController, Date, Promise,
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => ++nextId,
    clearInterval: () => {},
  };
  const api = loadTs("lib/studio/use-telemetry.ts", globals, (name) => {
    assert.equal(name, "react");
    return react;
  });
  const hook = api.useStudioTelemetry({ workspaceId: "workspace-1", enabled: true });
  return { hook, timers, listeners, get state() { return state; }, cleanup: () => cleanup?.() };
}

test("telemetry batches 50 events, retries with stable IDs, and sends a bounded final keepalive", async () => {
  const requests = [];
  let failures = 1;
  const harness = fakeTelemetry((url, options) => {
    requests.push({ url, options, events: JSON.parse(options.body).events });
    if (failures--) return Promise.reject(new Error("offline"));
    return Promise.resolve({ ok: true, status: 200 });
  });
  for (let i = 0; i < 49; i++) harness.hook.track("chat", { action: "send", ignoredText: "private content" });
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

test("telemetry caps an offline queue and every unload batch", async () => {
  const requests = [];
  const harness = fakeTelemetry((url, options) => {
    requests.push({ url, options, events: JSON.parse(options.body).events });
    return new Promise(() => {});
  });
  for (let i = 0; i < 600; i++) harness.hook.track("review", { status: "open" });
  assert.ok(harness.state.droppedEvents >= 50);
  harness.listeners.get("window:pagehide")();
  const unload = requests.slice(1);
  assert.ok(unload.length > 0);
  assert.ok(unload.every((request) => request.events.length <= 50 && request.options.keepalive));
  assert.ok(unload.reduce((sum, request) => sum + request.options.body.length, 0) <= 60_000);
  harness.cleanup();
});

test("telemetry drops rejected batches without retrying a client error", async () => {
  const requests = [];
  const harness = fakeTelemetry((url, options) => {
    requests.push({ url, options });
    return Promise.resolve({ ok: false, status: 400 });
  });
  for (let i = 0; i < 49; i++) harness.hook.track("chat", { action: "send" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(harness.state.droppedEvents, 50);
  assert.equal(harness.state.deliveryError, "Telemetry delivery failed; some events were dropped.");
  assert.equal([...harness.timers.values()].filter((timer) => timer.delay === 1000).length, 0);
  harness.cleanup();
});
