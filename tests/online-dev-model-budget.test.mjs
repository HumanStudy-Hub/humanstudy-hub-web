import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(file, dependencies = {}) {
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', js)(name => dependencies[name] ?? require(name), loaded, loaded.exports);
  return loaded.exports;
}

const model = 'anthropic/claude-haiku-5.5';
const user = '11111111-1111-4111-8111-111111111111';
const lib = load('lib/try-dev-model-budget.ts', { './try-online-config': { tryServiceKey: () => 'fixture-service' } });
const prompt = {
  model, messages: [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(415_758), cache_control: { type: 'ephemeral', ttl: '1h' } }] }],
  max_completion_tokens: 16_384, reasoning: { effort: 'medium', max_tokens: 4096 }, temperature: 0.3, top_p: 0.9,
  parallel_tool_calls: false, tool_choice: { type: 'function', function: { name: 'save_file' } },
  tools: [{ type: 'function', function: { name: 'save_file', description: 'Save file', parameters: { type: 'object' }, strict: true } }],
  stream: true,
};

test('dev reservation preserves large text, output and supported generation settings while pinning provider routing', () => {
  const bounded = lib.boundedDevCompletion(prompt, user);
  const sent = JSON.parse(bounded.wire);
  for (const key of ['messages', 'reasoning', 'tool_choice', 'tools', 'stream']) {
    assert.deepEqual(sent[key], prompt[key]);
  }
  assert.equal(sent.max_tokens, prompt.max_completion_tokens);
  // Haiku 5.5's OpenRouter endpoint lists no temperature/top_p; require_parameters would 404, so they are dropped.
  assert.equal(sent.temperature, undefined);
  assert.equal(sent.top_p, undefined);
  assert.equal(sent.parallel_tool_calls, undefined);
  assert.equal(sent.provider.allow_fallbacks, true); // within the price cap and parameter filter only
  assert.equal(sent.provider.require_parameters, true);
  assert.deepEqual(sent.provider.max_price, { prompt: 0.2, completion: 1, request: 0 });
  for (const key of ['plugins', 'models', 'n']) assert.equal(sent[key], undefined);
  assert.equal(bounded.reservationMicrousd, Math.ceil(2 * ((Buffer.byteLength(bounded.wire) + 4096) * 0.2 + 16_384 * 1)));
  assert.equal(lib.boundedDevCompletion({ ...prompt, max_completion_tokens: 32_768 }, user).model, model);
});

test('Haiku drops sampling parameters its endpoint does not support (simulation runs send temperature); other models keep them', () => {
  const simulation = { model, messages: [{ role: 'user', content: 'hi' }], temperature: 1, seed: 42, frequency_penalty: 0.1, presence_penalty: 0.1, max_tokens: 512 };
  const sent = JSON.parse(lib.boundedDevCompletion(simulation, user).wire);
  for (const key of ['seed', 'frequency_penalty', 'presence_penalty', 'temperature']) assert.equal(sent[key], undefined);
  const deepseek = JSON.parse(lib.boundedDevCompletion({ ...simulation, model: 'deepseek/deepseek-v4.1-flash-1017' }, user).wire);
  assert.equal(deepseek.temperature, 1);
  assert.equal(deepseek.seed, 42);
  assert.equal(sent.provider.require_parameters, true);
  assert.equal(lib.boundedDevCompletion({ ...simulation, seed: 1.5 }, user), null);
});

test('dev reservation rejects oversized input, multimodal content and invalid output without clipping', () => {
  for (const patch of [
    { max_completion_tokens: 32_769 },
    { plugins: [{ id: 'web' }] },
    { models: ['other/model'] },
    { provider: { allow_fallbacks: true } },
    { n: 20 },
    { max_tokens: 100 },
    { reasoning: { max_tokens: 20_000 } },
    { temperature: 3 },
    { tool_choice: 'execute' },
    { model: 'unpriced/model' },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test' } }] }] },
    { messages: [{ role: 'user', content: 'x'.repeat(4_000_001) }] },
  ]) assert.equal(lib.boundedDevCompletion({ ...prompt, ...patch }, user), null);
});

const u32be = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16be = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u16le = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u24le = n => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
const pngHeader = (w, h) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32be(13), Buffer.from('IHDR'), u32be(w), u32be(h), Buffer.from([8, 6, 0, 0, 0])]);
const jpegHeader = (w, h) => Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]), u16be(16), Buffer.from('JFIF\0'), Buffer.alloc(9),
  Buffer.from([0xff, 0xc2]), u16be(17), Buffer.from([8]), u16be(h), u16be(w), Buffer.alloc(10),
]);
const gifHeader = (w, h) => Buffer.concat([Buffer.from('GIF89a'), u16le(w), u16le(h), Buffer.alloc(3)]);
const riff = (chunk, body) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP' + chunk), u32be(0), body]);
const vp8 = (w, h) => riff('VP8 ', Buffer.concat([Buffer.alloc(3), Buffer.from([0x9d, 0x01, 0x2a]), u16le(w), u16le(h)]));
const vp8l = (w, h) => { const b = Buffer.alloc(5); b[0] = 0x2f; b.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1); return riff('VP8L', b); };
const vp8x = (w, h) => riff('VP8X', Buffer.concat([Buffer.alloc(4), u24le(w - 1), u24le(h - 1)]));
const dataUrl = (mime, head, size) => `data:image/${mime};base64,` + Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length))]).toString('base64');
const png = (size = 64, w = 640, h = 480) => dataUrl('png', pngHeader(w, h), size);
const picture = (url, extra = {}) => ({ type: 'image_url', image_url: { url, ...extra } });
const pictures = (...parts) => ({ model, max_tokens: 512, messages: [
  { role: 'system', content: 'You are a study participant.' },
  { role: 'user', content: [{ type: 'text', text: 'Page 1' }, ...parts] },
] });

test('image-capable models accept inline PNG/JPEG/GIF/WebP parts in user messages, passing only a valid detail', () => {
  const jpeg = dataUrl('jpeg', jpegHeader(800, 600), 64);
  const gif = dataUrl('gif', gifHeader(320, 240), 64);
  const webp = dataUrl('webp', vp8x(1024, 768), 64);
  const bounded = lib.boundedDevCompletion(pictures(picture(png(), { detail: 'low' }), picture(jpeg), picture(gif), picture(webp)), user);
  assert.ok(bounded);
  const content = JSON.parse(bounded.wire).messages[1].content;
  assert.deepEqual(content.slice(1), [
    picture(png(), { detail: 'low' }), picture(jpeg), picture(gif), picture(webp),
  ]);
  // Eight pictures of 1,000,000 base64 bytes would exceed the 4,000,000-byte wire; three fit.
  assert.ok(lib.boundedDevCompletion(pictures(...Array.from({ length: 3 }, () => picture(png(750_000)))), user));
  assert.ok(lib.boundedDevCompletion(pictures(...Array.from({ length: 8 }, () => picture(png()))), user));
});

test('image parts are refused outside their limits', () => {
  const cases = {
    'remote URL': pictures(picture('https://example.test/a.png')),
    'wrong mime': pictures(picture(png().replace('image/png', 'image/svg+xml'))),
    'non-image data URL': pictures(picture('data:text/html;base64,PGh0bWw+')),
    'content not matching its mime': pictures(picture(png().replace('image/png', 'image/jpeg'))),
    'invalid base64': pictures(picture('data:image/png;base64,iVBORw0KGgo*AAAA')),
    'unpadded base64': pictures(picture('data:image/png;base64,iVBORw0KGgoAAA')),
    'bad detail': pictures(picture(png(), { detail: 'ultra' })),
    'image in a system message': { ...pictures(), messages: [{ role: 'system', content: [{ type: 'text', text: 'x' }, picture(png())] }, { role: 'user', content: 'p' }] },
    'image in an assistant message': { ...pictures(), messages: [{ role: 'user', content: 'p' }, { role: 'assistant', content: [picture(png())] }] },
    'image for DeepSeek': { ...pictures(picture(png())), model: 'deepseek/deepseek-v4.1-flash' },
    'too many images': pictures(...Array.from({ length: 9 }, () => picture(png()))),
    'oversized image': pictures(picture(png(750_001))),
    '9,000 x 9,000 PNG': pictures(picture(png(64, 9000, 9000))),
    'PNG 8,001 px wide': pictures(picture(png(64, 8001, 10))),
    'JPEG over 8,000 px tall': pictures(picture(dataUrl('jpeg', jpegHeader(100, 8001), 64))),
    'WebP VP8L over 8,000 px': pictures(picture(dataUrl('webp', vp8l(9000, 100), 64))),
    'PNG without IHDR': pictures(picture(dataUrl('png', pngHeader(10, 10).subarray(0, 12), 64))),
    'JPEG with no frame header': pictures(picture(dataUrl('jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), 64))),
    'zero-sized GIF': pictures(picture(dataUrl('gif', gifHeader(0, 10), 64))),
    'whole wire over 4,000,000 bytes': pictures(...Array.from({ length: 5 }, () => picture(png(749_000)))),
  };
  for (const [name, body] of Object.entries(cases)) assert.equal(lib.boundedDevCompletion(body, user), null, name);
});

test('picture dimensions are read from PNG, GIF, JPEG and WebP headers', () => {
  const size = (mime, head) => lib.imageSize(mime, Buffer.concat([head, Buffer.alloc(32)]));
  assert.deepEqual(size('png', pngHeader(9000, 9000)), { width: 9000, height: 9000 });
  assert.deepEqual(size('gif', gifHeader(320, 240)), { width: 320, height: 240 });
  assert.deepEqual(size('jpeg', jpegHeader(800, 600)), { width: 800, height: 600 });
  assert.deepEqual(size('webp', vp8(1000, 700)), { width: 1000, height: 700 });
  assert.deepEqual(size('webp', vp8l(8000, 16)), { width: 8000, height: 16 });
  assert.deepEqual(size('webp', vp8x(4000, 3000)), { width: 4000, height: 3000 });
  assert.equal(size('jpeg', pngHeader(10, 10)), null);
  assert.ok(lib.boundedDevCompletion(pictures(picture(png(64, 8000, 8000))), user), '8,000 px is the limit, inclusive');
});

test('a request with pictures stays under 100,000 estimated input tokens (standard price tier); text-only is unchanged', () => {
  const text = n => ({ type: 'text', text: 'a'.repeat(n) });
  // 8 pictures = 40,000 tokens; about 60,000 bytes of other wire fits, 61,000 more does not.
  const fits = pictures(...Array.from({ length: 8 }, () => picture(png())), text(59_000));
  assert.ok(lib.boundedDevCompletion(fits, user));
  const over = pictures(...Array.from({ length: 8 }, () => picture(png())), text(61_000));
  assert.equal(lib.boundedDevCompletion(over, user), null);
  assert.ok(lib.boundedDevCompletion({ ...pictures(text(500_000)) }, user), 'text-only keeps the 4,000,000-byte limit');
});

test('a picture reserves a fixed 5,000 input tokens, not its base64 bytes', () => {
  const url = png(600_000);
  const bounded = lib.boundedDevCompletion(pictures(picture(url), picture(url)), user);
  const bytes = Buffer.byteLength(bounded.wire);
  const base64 = 2 * (url.length - 'data:image/png;base64,'.length);
  assert.equal(bounded.reservationMicrousd, Math.ceil(2 * ((bytes - base64 + 2 * 5000 + 4096) * 0.2 + 512 * 1)));
  const bytesBased = Math.ceil(2 * ((bytes + 4096) * 0.2 + 512 * 1));
  assert.ok(bounded.reservationMicrousd < bytesBased / 20, `${bounded.reservationMicrousd} vs ${bytesBased}`);
});

test('dev model route forwards only after reservation; production forwards its existing payload', async t => {
  const env = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, VERCEL_ENV: process.env.VERCEL_ENV };
  process.env.VERCEL_ENV = 'preview';
  process.env.OPENROUTER_API_KEY = 'fixture-provider';
  t.after(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  let dev = true, allowed = false, reserves = 0, forwards = 0;
  const route = load('app/api/desktop/v1/chat/completions/route.ts', {
    '@/lib/hosted-model-quota': { hostedQuotaEnvironment: () => null },
    '@/lib/provider-usage-settlement': load('lib/provider-usage-settlement.ts'),
    '@/lib/bounded-request': load('lib/bounded-request.ts'),
    'next/server': { NextResponse: { json: (value, init) => Response.json(value, init) } },
    '@/lib/desktop-access': { bearer: () => 'fixture', verifyDesktopKey: () => user, DESKTOP_MODELS: [model] },
    '@/lib/try-dev-models': { devModelAccess: () => true, isDevPreview: () => dev },
    '@/lib/try-dev-model-budget': {
      boundedDevCompletion: lib.boundedDevCompletion,
      reserveDevCompletion: async (account, selected, amount) => {
        assert.equal(account, user);
        assert.equal(selected, model);
        assert.ok(amount > 0);
        reserves++;
        return allowed;
      },
    },
  });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    forwards++;
    const wire = JSON.parse(init.body);
    assert.equal(wire.provider !== undefined, dev);
    assert.equal(wire.user, 'hsd:' + user);
    return Response.json({ ok: true });
  });
  t.mock.method(console, 'log', () => {});
  const call = () => route.POST(new Request('https://example.test/api/desktop/v1/chat/completions', {
    method: 'POST', body: JSON.stringify(prompt),
  }));
  assert.equal((await call()).status, 429);
  assert.equal(forwards, 0);
  allowed = true;
  assert.equal((await call()).status, 200);
  assert.equal(reserves, 2);
  assert.equal(forwards, 1);
  dev = false;
  assert.equal((await call()).status, 503);
  assert.equal(forwards, 1);
  process.env.VERCEL_ENV = 'production';
  assert.equal((await call()).status, 200);
  assert.equal(reserves, 2);
  assert.equal(forwards, 2);
});

test('database admits one account and only the requests its singleton budget can debit', async () => {
  const db = new PGlite();
  const other = '22222222-2222-4222-8222-222222222222';
  const rpc = (id, selected, amount) => db.query(
    'select public.online_reserve_dev_model_budget($1, $2, $3) as value', [id, selected, amount],
  ).then(result => result.rows[0].value);
  try {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users (id uuid primary key);');
    await db.exec(fs.readFileSync(new URL('../supabase/migrations/20261112181142_online_dev_model_budget.sql', import.meta.url), 'utf8'));
    await db.query('insert into auth.users values ($1), ($2)', [user, other]);
    await db.exec('set role service_role');
    assert.equal(await rpc(user, model, 10), false);
    await assert.rejects(db.query('insert into public.online_dev_model_budget values (true,$1,array[$2],now(),1,1)', [user, model]), /permission denied/);
    await db.exec('reset role');
    await db.query("insert into public.online_dev_model_budget values (true,$1,array[$2],now()+interval '1 hour',125,3)", [user, model]);
    await db.exec('set role authenticated');
    await assert.rejects(rpc(user, model, 10), /permission denied/);
    await assert.rejects(db.query('select * from public.online_dev_model_budget'), /permission denied/);
    await db.exec('set role service_role');
    assert.equal(await rpc(other, model, 10), false);
    assert.equal(await rpc(user, 'other/model', 10), false);
    assert.equal(await rpc(user, model, 0), false);
    const allocations = await Promise.all(Array.from({ length: 5 }, () => rpc(user, model, 50)));
    assert.equal(allocations.filter(Boolean).length, 2);
    assert.equal(await rpc(user, model, 20), true);
    assert.equal(await rpc(user, model, 1), false);
    assert.deepEqual((await db.query('select remaining_microusd, remaining_requests from public.online_dev_model_budget')).rows[0], {
      remaining_microusd: 5, remaining_requests: 0,
    });
    await db.exec("reset role; update public.online_dev_model_budget set expires_at=now()-interval '1 second', remaining_requests=1; set role service_role");
    assert.equal(await rpc(user, model, 1), false);
  } finally {
    await db.close();
  }
});
