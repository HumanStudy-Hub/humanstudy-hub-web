import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function load(file, dependencies) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loadedModule = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => dependencies[name] || require(name), loadedModule, loadedModule.exports);
  return loadedModule.exports;
}

function harness(props, fragment = "") {
  const effects = [], state = [], requests = [], locations = [];
  const component = load("components/studio/confirm-email.tsx", {
    react: { useState: initial => { const index = state.length; state.push(initial); return [initial, value => { state[index] = value; }]; }, useEffect: callback => effects.push(callback) },
    "next/link": { default: "a" },
    "./confirm-email.module.css": { default: {} },
    "./client": { studioApi: async (...args) => requests.push(args) },
  }).default;
  const tree = component(props);
  const prior = global.window;
  global.window = { location: { hash: fragment, replace: url => locations.push(url) }, history: { replaceState: (...args) => locations.push(args[2]) } };
  function restore() { if (prior === undefined) delete global.window; else global.window = prior; }
  return { tree, effects, state, requests, locations, restore };
}

function button(tree) {
  if (!tree || typeof tree !== "object") return undefined;
  if (tree.type === "button") return tree;
  const children = tree.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) { const found = button(child); if (found) return found; }
}

test("opening a custom confirmation page does not consume its token until the user confirms", async () => {
  const h = harness({ tokenHash: "a".repeat(64), invalid: false });
  try {
    h.effects.forEach(effect => effect());
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.locations, ["/auth/confirm"]);
    await button(h.tree).props.onClick();
    assert.deepEqual(JSON.parse(h.requests[0][1].body), { action: "confirm", tokenHash: "a".repeat(64), type: "email" });
    assert.deepEqual(h.locations, ["/auth/confirm", "/build"]);
  } finally { h.restore(); }
});

test("default email callback discards fragment tokens and requires normal sign-in", () => {
  const h = harness({ invalid: false }, "#access_token=untrusted&refresh_token=untrusted");
  try {
    h.effects.forEach(effect => effect());
    assert.equal(h.requests.length, 0);
    assert.equal(button(h.tree), undefined);
    assert.deepEqual(h.locations, ["/auth/confirm"]);
    assert.ok(!JSON.stringify(h.tree).includes("untrusted"));
  } finally { h.restore(); }
});

test("provider redirect errors display expiry guidance without making auth requests", () => {
  const h = harness({ invalid: false }, "#error=access_denied&error_code=otp_expired");
  try {
    h.effects.forEach(effect => effect());
    assert.match(h.state[0], /invalid or has expired/);
    assert.equal(h.requests.length, 0);
  } finally { h.restore(); }
});

test("confirmation server page rejects invalid and non-email tokens before rendering", async () => {
  const page = load("app/auth/confirm/page.tsx", { "@/components/studio/confirm-email": { default: "confirm" } });
  assert.equal(page.dynamic, "force-dynamic");
  assert.equal(page.metadata.referrer, "no-referrer");
  for (const params of [{ token_hash: "short", type: "email" }, { token_hash: "a".repeat(64), type: "recovery" }, { error_code: "otp_expired" }]) {
    const tree = await page.default({ searchParams: Promise.resolve(params) });
    assert.equal(tree.props.invalid, true);
    assert.equal(tree.props.tokenHash, undefined);
  }
});

test("confirmation route is omitted from website metrics", () => {
  const metrics = load("components/SiteMetrics.tsx", {
    "next/navigation": { usePathname: () => "/auth/confirm" },
    "@vercel/speed-insights/next": { SpeedInsights: "speed" },
    "@vercel/analytics/react": { Analytics: "analytics" },
  });
  assert.equal(metrics.default(), null);
  assert.equal(metrics.filterAuthMetrics({ url: "https://app.test/auth/confirm?token_hash=secret" }), null);
  assert.equal(metrics.filterAuthMetrics({ url: "/auth/confirm#access_token=secret" }), null);
  assert.deepEqual(metrics.filterAuthMetrics({ url: "https://app.test/build" }), { url: "https://app.test/build" });
});
