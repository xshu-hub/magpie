import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, readdir, cp, rm, symlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenCodeBridge } from '../lib/bridge.mjs';
import { nativeToolName, sseEvents } from '../lib/protocol.mjs';
import { OpenCodeBridgePlugin } from '../index.mjs';

if (!process.env.TEST_OPENCODE_COMMAND) throw new Error('Set TEST_OPENCODE_COMMAND for the real OpenCode global-state test.');
const command = JSON.parse(process.env.TEST_OPENCODE_COMMAND);
const home = await mkdtemp(path.join(os.tmpdir(), 'opencode-global-fixture-'));
const saved = { ...process.env };
const data = path.join(home, 'data', 'opencode');
const configDir = path.join(home, 'config', 'opencode');
const authFile = path.join(data, 'auth.json');
const requests = [];
let refreshes = 0;
let parallelRequests;
const upstream = http.createServer(async (req, res) => {
  if (req.url === '/refresh') {
    refreshes++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access: 'fixture-refreshed-access', refresh: 'fixture-refreshed-refresh', expires: Date.now() + 3600000 }));
    return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push({ auth: req.headers.authorization, body });
  const marker = body.messages.find(m => m.role === 'user' && typeof m.content === 'string' && parallelRequests?.has(m.content))?.content;
  if (marker) {
    const pending = parallelRequests.get(marker);
    pending.started.resolve();
    await pending.release.promise;
    if (res.destroyed) return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (delta, reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason: reason }], ...(usage ? { usage } : {}) })}\n\n`);
  if (body.tools?.length && !body.messages.some(m => m.role === 'tool')) {
    for (const [i, name] of ['weather', 'clock'].entries()) emit({ tool_calls: [{ index: i, id: 'call_' + name, type: 'function', function: { name: nativeToolName(name), arguments: '{"city":"北京"}' } }] });
    emit({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  } else if (marker) {
    emit({ role: 'assistant', content: marker });
    emit({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  } else {
    emit({ role: 'assistant', content: '复用' }); emit({ content: '全局 OpenCode 登录。' });
    emit({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  }
  res.end('data: [DONE]\n\n');
});
await new Promise(r => upstream.listen(0, '127.0.0.1', r));
const baseURL = `http://127.0.0.1:${upstream.address().port}`;
after(async () => {
  upstream.closeAllConnections(); await new Promise(r => upstream.close(r));
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
  Object.assign(process.env, saved);
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
await mkdir(data, { recursive: true });
await mkdir(configDir, { recursive: true });
// Seed only the fixture's global SDK installation. Real user files are untouched.
const sdk = process.env.TEST_OPENCODE_PLUGIN_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.resolve('@opencode-ai/plugin'))), '..');
const manifest = JSON.parse(await readFile(path.join(sdk, 'package.json'), 'utf8'));
await cp(sdk, path.join(configDir, 'node_modules', '@opencode-ai', 'plugin'), { recursive: true });
await writeFile(path.join(configDir, 'package.json'), JSON.stringify({ private: true, dependencies: { '@opencode-ai/plugin': manifest.version } }));
await writeFile(path.join(configDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { '@opencode-ai/plugin': manifest.version } }, 'node_modules/@opencode-ai/plugin': { version: manifest.version } } }));
const loginPlugin = path.join(configDir, 'fixture-auth.mjs');
await writeFile(loginPlugin, `export const FixtureAuth = async ({ client }) => ({
  auth: { provider: 'fixture-oauth', methods: [], loader: async getAuth => ({
    apiKey: 'fixture-sdk-placeholder',
    fetch: async (url, init) => {
      let auth = await getAuth();
      if (auth.expires < Date.now()) {
        const fresh = await fetch(${JSON.stringify(baseURL + '/refresh')}, { method: 'POST' }).then(r => r.json());
        auth = { type: 'oauth', ...fresh };
        await client.auth.set({ path: { id: 'fixture-oauth' }, body: auth });
      }
      const headers = new Headers(init.headers);
      headers.set('authorization', 'Bearer ' + auth.access);
      return fetch(url, { ...init, headers });
    }
  }) }
});\n`);
const globalConfig = {
  $schema: 'https://opencode.ai/config.json',
  model: 'fixture-oauth/mock',
  plugin: [pathToFileURL(loginPlugin).href],
  provider: {
    'fixture-oauth': { npm: '@ai-sdk/openai-compatible', options: { baseURL: baseURL + '/v1' }, models: { mock: { name: 'Subscription fixture', temperature: true, limit: { context: 100000, output: 1000 } } } },
    'fixture-api': { npm: '@ai-sdk/openai-compatible', options: { baseURL: baseURL + '/v1' }, models: { mock: { name: 'Saved key fixture', limit: { context: 100000, output: 1000 } } } },
  },
  // These would be dangerous for the API worker if inherited without restrictions.
  permission: { '*': 'allow' },
  mcp: { unused: { type: 'remote', url: 'http://127.0.0.1:1', enabled: false } },
};
const originalConfig = JSON.stringify(globalConfig);
await writeFile(path.join(configDir, 'opencode.json'), originalConfig);
await writeFile(authFile, JSON.stringify({
  'fixture-oauth': { type: 'oauth', access: 'fixture-expired-access', refresh: 'fixture-refresh', expires: 0 },
  'fixture-api': { type: 'api', key: 'fixture-saved-api-key' },
  untouched: { type: 'api', key: 'fixture-unrelated-key' },
}));
Object.assign(process.env, {
  HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
  XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
  OPENCODE_DISABLE_MODELS_FETCH: '1',
});
for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_AUTH_CONTENT']) delete process.env[key];
let fixtureCommand = command;
if (command.length === 1) {
  const bin = path.join(home, 'global-bin');
  await mkdir(bin);
  if (process.platform === 'win32') {
    const root = path.resolve(path.dirname(command[0]), '..');
    const pkg = await readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse, () => undefined);
    if (pkg?.name === 'opencode-ai') {
      const shimPackage = path.join(bin, 'node_modules', 'opencode-ai');
      await mkdir(shimPackage, { recursive: true });
      await symlink(path.dirname(command[0]), path.join(shimPackage, 'bin'), 'junction');
      // PowerShell-created global manifests may contain a UTF-8 BOM. Follow the
      // package's declared bin without requiring a filename or runtime version.
      await writeFile(path.join(shimPackage, 'package.json'), '\ufeff' + JSON.stringify({ name: 'opencode-ai', version: 'unlisted', bin: { opencode: './bin/' + path.basename(command[0]) } }));
      await writeFile(path.join(bin, 'opencode.cmd'), '@echo off\r\n"%~dp0node_modules\\opencode-ai\\bin\\opencode.exe" %*\r\n');
      fixtureCommand = undefined;
    } else {
      await symlink(command[0], path.join(bin, 'opencode.exe'));
      fixtureCommand = undefined;
    }
  } else {
    await symlink(command[0], path.join(bin, 'opencode'));
    fixtureCommand = undefined;
  }
  process.env.PATH = bin + path.delimiter + (process.env.PATH ?? process.env.Path ?? '');
}
const options = { mode: 'global', ...(fixtureCommand ? { command: fixtureCommand } : {}), timeoutMs: 45000, startupTimeoutMs: 20000, models: { 'oc-default': { context: 100000, output: 1000 } } };
options.onFailure = async ({ phase, output, events }) => {
  console.log('Global OpenCode fixture phase:', phase, 'output:', output, 'events:', events);
  const dir = path.join(data, 'log');
  for (const name of await readdir(dir).catch(() => [])) console.log('Fixture OpenCode log:', (await readFile(path.join(dir, name), 'utf8')).slice(-18000));
};
const bridge = new OpenCodeBridge(options);
const request = (body, instance = bridge) => instance.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'oc-default', ...body }) }, 'not-the-upstream-key');

test('real global v1 loads its configured OAuth plugin, refreshes its own login and uses its default model', { timeout: 60000 }, async () => {
  const fetchOriginal = globalThis.fetch;
  let subscriptions = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/global/health')) {
      const response = await fetchOriginal(url, init);
      if (!response.ok) return response;
      return Response.json({ ...await response.json(), version: 'unlisted-test-build' });
    }
    if (String(url).endsWith('/event') && subscriptions++ === 0) {
      assert.equal(requests.length, 0, 'No inference until the event subscription works');
      return new Response('', { headers: { 'content-type': 'text/event-stream' } });
    }
    return fetchOriginal(url, init);
  };
  let response, chunks;
  try {
    response = await request({ messages: [{ role: 'system', content: 'Global system' }, { role: 'user', content: 'Hello' }], stream: true });
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    chunks = await Array.fromAsync(sseEvents(response.body));
  } finally { globalThis.fetch = fetchOriginal; }
  assert.ok(subscriptions >= 2, 'An empty event response is retried before inference');
  assert.equal(response.status, 200, JSON.stringify(chunks));
  assert.equal(response.headers.get('x-opencode-version'), 'unlisted-test-build', 'An unknown reported version must not prevent inference');
  assert.equal(chunks.some(c => c.error), false, JSON.stringify(chunks));
  assert.equal(chunks.map(c => c.choices[0]?.delta.content ?? '').join(''), '复用全局 OpenCode 登录。');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].auth, 'Bearer fixture-refreshed-access');
  assert.equal(requests[0].body.model, 'mock');
  assert.equal(refreshes, 1);
  const auth = JSON.parse(await readFile(authFile, 'utf8'));
  assert.equal(auth['fixture-oauth'].refresh, 'fixture-refreshed-refresh');
  assert.equal(auth.untouched.key, 'fixture-unrelated-key');
  assert.equal(await readFile(path.join(configDir, 'opencode.json'), 'utf8'), originalConfig);
  assert.equal((await readdir(data)).some(n => n.endsWith('.sqlite')), false, 'API sessions use a temporary database');
});
test('any provider SDK can return complete tool batches without local execution or a second inference', { timeout: 120000 }, async () => {
  const before = requests.length;
  const tools = ['weather', 'clock'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } } }));
  const body = { model: 'oc-default', messages: [{ role: 'user', content: 'Call the tools' }], tools, stream: true, stream_options: { include_usage: true } };
  const run = await bridge.prepare(body);
  try {
    const deadline = Date.now() + 10000;
    while (requests.length === before && Date.now() < deadline) await delay(50);
    // Slow event consumption must never allow OpenCode to infer using a deferral acknowledgement.
    await delay(1000);
    assert.equal(requests.length, before + 1);
    assert.deepEqual(requests.at(-1).body.tools.map(t => t.function.name).sort(), ['weather', 'clock'].map(nativeToolName).sort(), 'No global built-in or unrelated MCP tool reaches the model');
    const chunks = await Array.fromAsync(bridge.chunks(body, run, { id: 'test', created: 0, model: 'oc-default' }));
    const calls = chunks.flatMap(c => c.choices[0]?.delta.tool_calls ?? []);
    assert.deepEqual(calls.map(c => c.function.name), ['weather', 'clock']);
    assert.equal(chunks.find(c => c.choices[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls');
    assert.equal(requests.length, before + 1);
    assert.equal(chunks.at(-1).usage.total_tokens, 15);
    const response = await request({ messages: [...body.messages, { role: 'assistant', content: null, tool_calls: calls.map(({ index, ...c }) => c) }, { role: 'tool', tool_call_id: 'call_clock', content: '10:00' }, { role: 'tool', tool_call_id: 'call_weather', content: '北京 23C' }], tools });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.deepEqual(requests.at(-1).body.messages.map(m => m.role), ['user', 'assistant', 'tool', 'tool']);
    assert.equal(requests.at(-1).body.messages.at(-1).content, '10:00');
    assert.equal(requests.length, before + 2);
  } finally { await run.cleanup(); }
});
test('explicit model selection still uses the global saved key and ignores a Magpie login key', { timeout: 60000 }, async () => {
  const selected = new OpenCodeBridge({ ...options, models: { 'oc-default': { ...options.models['oc-default'], model: 'fixture-api/mock' } } });
  const response = await request({ messages: [{ role: 'user', content: 'Hello' }] }, selected);
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.equal(requests.at(-1).auth, 'Bearer fixture-saved-api-key');
  assert.equal(refreshes, 1, 'Refreshed credentials survive a new worker');
});

test('Cherry Studio multi-turn history with empty, null or nonempty reasoning goes through real global OpenCode', { timeout: 120000 }, async () => {
  for (const reasoning_content of ['', null, 'GLOBAL_PRIOR_REASONING_SENTINEL']) {
    const before = requests.length;
    const response = await request({ messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Previous answer', reasoning_content },
      { role: 'user', content: 'Continue' },
    ] });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.choices[0].message.content, '复用全局 OpenCode 登录。');
    assert.equal(requests.length, before + 1);
    const sent = requests.at(-1).body.messages;
    assert.deepEqual(sent.map(m => m.role), ['user', 'assistant', 'user']);
    assert.equal(sent[1].content, 'Previous answer');
    assert.equal(sent[1].reasoning_content || '', reasoning_content || '');
    assert.equal(sent[2].content, 'Continue');
  }
});

test('global model discovery lists connected providers and calls the selected model without copying credentials', { timeout: 60000 }, async () => {
  const discovered = new OpenCodeBridge({ ...options, discoverModels: true });
  const before = requests.length;
  const listing = await discovered.fetch('http://bridge/v1/models');
  const models = await listing.json();
  assert.equal(listing.status, 200, JSON.stringify(models));
  for (const id of ['oc-default', 'fixture-api/mock', 'fixture-oauth/mock']) assert.ok(models.data.some(m => m.id === id), id + ' must be selectable');
  assert.equal(requests.length, before, 'Listing models must not initiate inference');
  for (const value of Object.values(discovered.config.models)) assert.deepEqual(Object.keys(value).sort().filter(k => ['apiKey', 'baseURL', 'options', 'headers'].includes(k)), []);
  const response = await discovered.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'fixture-api/mock', messages: [{ role: 'user', content: 'Hello' }] }) });
  assert.equal(response.status, 200, JSON.stringify(await response.json()));
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1).auth, 'Bearer fixture-saved-api-key');
  assert.equal(requests.at(-1).body.model, 'mock');
});

test('a plugin with no config.json uses global OpenCode and discovers its models', { timeout: 60000 }, async () => {
  const configured = process.env.MAGPIE_OPENCODE_CONFIG;
  delete process.env.MAGPIE_OPENCODE_CONFIG;
  let plugin;
  try { plugin = await OpenCodeBridgePlugin({}); }
  finally { if (configured !== undefined) process.env.MAGPIE_OPENCODE_CONFIG = configured; }
  const cfg = {};
  await plugin.config(cfg);
  assert.ok(cfg.provider['opencode-bridge'].models['fixture-api/mock']);
  assert.ok(cfg.provider['opencode-bridge'].models['fixture-oauth/mock']);
  assert.equal(plugin.auth.methods[0].type, 'oauth');
  await assert.rejects(() => OpenCodeBridgePlugin({}, { configFile: path.join(home, 'missing-explicit-config.json') }), { code: 'ENOENT' });
});

test('global workers infer concurrently and cancelling one does not cancel the other sessions', { timeout: 90000 }, async () => {
  const instance = new OpenCodeBridge({ ...options, models: {
    ...options.models,
    'saved-api': { model: 'fixture-api/mock', context: 100000, output: 1000 },
  } });
  const labels = ['parallel-cancel', 'parallel-json', 'parallel-stream', 'parallel-oauth'];
  parallelRequests = new Map(labels.map(label => [label, { started: Promise.withResolvers(), release: Promise.withResolvers() }]));
  const controllers = labels.map(() => new AbortController());
  const before = requests.length;
  const jobs = labels.map(async (label, i) => {
    const body = { model: i % 2 ? 'saved-api' : 'oc-default', messages: [{ role: 'user', content: label }], stream: i % 2 === 0, stream_options: { include_usage: true } };
    const response = await instance.fetch('http://bridge/v1/chat/completions', { method: 'POST', body: JSON.stringify(body), signal: controllers[i].signal }, 'not-the-upstream-key');
    assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
    if (!body.stream) {
      const result = await response.json();
      return { content: result.choices[0].message.content, finish: result.choices[0].finish_reason, usage: result.usage };
    }
    const chunks = await Array.fromAsync(sseEvents(response.body));
    if (i === 0 && controllers[0].signal.aborted) return { cancelled: true };
    assert.equal(chunks.some(c => c.error), false, JSON.stringify(chunks));
    return { content: chunks.map(c => c.choices[0]?.delta.content ?? '').join(''), finish: chunks.find(c => c.choices[0]?.finish_reason)?.choices[0].finish_reason, usage: chunks.at(-1).usage };
  });
  const settled = Promise.allSettled(jobs);
  let deadline;
  try {
    const started = Promise.all([...parallelRequests.values()].map(p => p.started.promise));
    const earlyFailure = Promise.all(jobs).then(() => { throw new Error('Workers completed before all four upstream calls overlapped'); });
    const timedOut = new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('All four global workers must reach inference concurrently')), 45000); });
    await Promise.race([started, earlyFailure, timedOut]);
    assert.equal(requests.length, before + 4, 'All four inferences start before any result is released');
    for (const [i, label] of labels.entries()) {
      const upstreamRequest = requests.slice(before).find(r => r.body.messages.some(m => m.content === label));
      assert.ok(upstreamRequest, label);
      assert.equal(upstreamRequest.auth, i % 2 ? 'Bearer fixture-saved-api-key' : 'Bearer fixture-refreshed-access');
    }
    controllers[0].abort();
    await jobs[0];
    for (const label of labels) parallelRequests.get(label).release.resolve();
    const results = await Promise.all(jobs);
    for (let i = 1; i < results.length; i++) {
      assert.equal(results[i].content, labels[i], 'Sessions must not receive another request\'s response');
      assert.equal(results[i].finish, 'stop');
      assert.equal(results[i].usage.total_tokens, 15);
    }
    assert.equal(refreshes, 1, 'Concurrent workers reuse the login already refreshed by OpenCode');
    assert.equal(await readFile(path.join(configDir, 'opencode.json'), 'utf8'), originalConfig);
    const auth = JSON.parse(await readFile(authFile, 'utf8'));
    assert.equal(auth.untouched.key, 'fixture-unrelated-key');
    assert.equal((await readdir(data)).some(n => n.endsWith('.sqlite')), false);
  } finally {
    clearTimeout(deadline);
    for (const controller of controllers) controller.abort();
    for (const pending of parallelRequests.values()) pending.release.resolve();
    await settled;
    parallelRequests = undefined;
  }
});
