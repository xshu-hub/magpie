import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { sseEvents } from '../lib/protocol.mjs';

test('packaged addon on official Magpie supports cwd, tools, SSE and independent concurrent OpenCode sessions', { timeout: 150000 }, async () => {
  for (const name of ['TEST_MAGPIE_COMMAND', 'TEST_BRIDGE_PACKAGE', 'TEST_OPENCODE_COMMAND', 'TEST_OPENCODE_PLUGIN_DIR']) assert.ok(process.env[name], name + ' is required');
  const official = JSON.parse(process.env.TEST_MAGPIE_COMMAND);
  assert.equal(official.length, 1);
  const command = JSON.parse(process.env.TEST_OPENCODE_COMMAND);
  const profile = await mkdtemp(path.join(os.tmpdir(), 'bridge-official-magpie-'));
  const executable = path.join(profile, process.platform === 'win32' ? 'magpie.exe' : 'magpie');
  const workspace = path.join(profile, 'workspace 中文 with spaces');
  const recordsFile = path.join(profile, 'directories.jsonl');
  let server, serverLogs = '', running = [];
  let calls = 0;
  const pending = new Set();
  const overlapping = Promise.withResolvers();
  const upstream = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer fixture-key');
      calls++;
      const marker = body.messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('parallel-'))?.content;
      if (marker) {
        pending.add(marker);
        if (pending.size === 4) overlapping.resolve();
        await overlapping.promise;
        if (res.destroyed) return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null, usage) => res.write(`data: ${JSON.stringify({ id: 'official-fixture', object: 'chat.completion.chunk', created: 1, model: 'mock', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
      if (body.tools?.length && !body.messages.some(m => m.role === 'tool')) {
        emit({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: body.tools[0].function.name, arguments: '{"city":"Beijing"}' } }] });
        emit({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      } else {
        emit({ role: 'assistant', content: marker ?? 'Through official Magpie and real OpenCode.' });
        emit({}, 'stop', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { res.destroy(error); }
  });
  try {
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'keep.txt'), 'user-owned workspace');
    await writeFile(path.join(workspace, 'opencode.json'), '{"model":"project-must-not-load/missing"}');
    await copyFile(official[0], executable);
    await chmod(executable, 0o755);
    const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
    assert.equal(await hash(executable), await hash(official[0]), 'The official binary must be byte-for-byte unmodified');
    await writeFile(path.join(profile, '.portable'), '');
    const unpack = spawnSync('tar', ['-xzf', path.resolve(process.env.TEST_BRIDGE_PACKAGE), '-C', profile], { windowsHide: true, encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr);
    const addon = path.join(profile, 'package');
    const pkg = JSON.parse(await readFile(path.join(addon, 'package.json'), 'utf8'));
    assert.equal(await access(path.join(addon, 'node_modules')).then(() => true, () => false), false);
    const configDir = path.join(profile, 'config', 'opencode');
    const dataDir = path.join(profile, 'data', 'opencode');
    await mkdir(configDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    const sdk = path.resolve(process.env.TEST_OPENCODE_PLUGIN_DIR);
    const manifest = JSON.parse(await readFile(path.join(sdk, 'package.json'), 'utf8'));
    await cp(sdk, path.join(configDir, 'node_modules', '@opencode-ai', 'plugin'), { recursive: true });
    const dependencies = { '@opencode-ai/plugin': manifest.version };
    await writeFile(path.join(configDir, 'package.json'), JSON.stringify({ private: true, dependencies }));
    await writeFile(path.join(configDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies }, 'node_modules/@opencode-ai/plugin': { version: manifest.version } } }));
    const recorder = path.join(configDir, 'directory-fixture.mjs');
    await writeFile(recorder, `import { appendFile } from 'node:fs/promises';\nexport const DirectoryFixture = async ({directory}) => { await appendFile(${JSON.stringify(recordsFile)}, JSON.stringify({cwd:process.cwd(), directory, db:process.env.OPENCODE_DB}) + '\\n'); return {}; };\n`);
    await new Promise(r => upstream.listen(0, '127.0.0.1', r));
    const config = JSON.stringify({ $schema: 'https://opencode.ai/config.json', model: 'fixture/mock', plugin: [pathToFileURL(recorder).href], provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${upstream.address().port}/v1` }, models: { mock: { limit: { context: 100000, output: 1000 } } } } } });
    await writeFile(path.join(configDir, 'opencode.json'), config);
    await writeFile(path.join(dataDir, 'auth.json'), JSON.stringify({ fixture: { type: 'api', key: 'fixture-key' } }));
    const bridgeConfig = path.join(profile, 'bridge.json');
    await writeFile(bridgeConfig, JSON.stringify({ mode: 'global', command, workingDirectory: './' + path.basename(workspace), timeoutMs: 60000 }));
    const probe = http.createServer();
    await new Promise(r => probe.listen(0, '127.0.0.1', r));
    const port = probe.address().port;
    await new Promise(r => probe.close(r));
    const locate = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['bun'], { encoding: 'utf8', windowsHide: true });
    assert.equal(locate.status, 0, 'Bun is required for the official Magpie host');
    const env = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'appdata'), LOCALAPPDATA: path.join(profile, 'localappdata'), XDG_CONFIG_HOME: path.join(profile, 'config'), XDG_DATA_HOME: path.join(profile, 'data'), XDG_CACHE_HOME: path.join(profile, 'cache'), XDG_STATE_HOME: path.join(profile, 'state'), MAGPIE_BUN: locate.stdout.trim().split(/\r?\n/)[0], MAGPIE_ADDR: `127.0.0.1:${port}`, MAGPIE_OPENCODE_CONFIG: bridgeConfig, OPENCODE_DISABLE_MODELS_FETCH: '1' };
    for (const key of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_AUTH_CONTENT']) delete env[key];
    const run = (args) => new Promise((resolve, reject) => {
      const child = spawn(executable, args, { env, cwd: profile, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
      const timer = setTimeout(() => child.kill(), 60000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error(`Official Magpie ${args[0]} failed: ${output.slice(-6000)}`)); });
    });
    const magpieVersion = await run(['--version']);
    await run(['plugin', 'add', addon]);
    await run(['plugin', 'login', 'opencode-bridge']);
    server = spawn(executable, ['serve'], { env, cwd: profile, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', b => { serverLogs = (serverLogs + b).slice(-8000); });
    server.stderr.on('data', b => { serverLogs = (serverLogs + b).slice(-8000); });
    const base = `http://127.0.0.1:${port}/v1`;
    const headers = { authorization: 'Bearer magpie', 'content-type': 'application/json' };
    let models;
    for (const deadline = Date.now() + 30000; Date.now() < deadline;) {
      try {
        const response = await fetch(base + '/models', { headers, signal: AbortSignal.timeout(1000) });
        if (response.ok) {
          models = await response.json();
          if (models.data.some(m => m.id === 'opencode-bridge/fixture/mock')) break;
        }
      } catch {}
      await delay(100);
    }
    assert.ok(models?.data.some(m => m.id === 'opencode-bridge/fixture/mock'), serverLogs);
    const ask = async body => {
      const response = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ model: 'opencode-bridge/fixture/mock', ...body }), signal: AbortSignal.timeout(60000) });
      assert.equal(response.status, 200, response.status === 200 ? undefined : await response.text());
      return body.stream ? Array.fromAsync(sseEvents(response.body)) : response.json();
    };
    const messages = [{ role: 'user', content: 'Hello' }];
    const ordinary = await ask({ messages });
    assert.equal(ordinary.choices[0].message.content, 'Through official Magpie and real OpenCode.');
    const stream = await ask({ messages, stream: true });
    assert.equal(stream.map(c => c.choices?.[0]?.delta.content ?? '').join(''), ordinary.choices[0].message.content);
    const tools = [{ type: 'function', function: { name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } } }];
    const tool = await ask({ messages, tools });
    assert.equal(tool.choices[0].finish_reason, 'tool_calls');
    assert.equal(tool.choices[0].message.tool_calls[0].function.name, 'weather');
    const continuation = await ask({ messages: [...messages, tool.choices[0].message, { role: 'tool', tool_call_id: 'call_fixture', content: '23C' }], tools });
    assert.equal(continuation.choices[0].finish_reason, 'stop');
    running = [0, 1, 2, 3].map(async i => {
      const marker = 'parallel-' + i;
      const body = { messages: [{ role: 'user', content: marker }], stream: i % 2 === 0 };
      const result = await ask(body);
      const content = body.stream ? result.map(c => c.choices?.[0]?.delta.content ?? '').join('') : result.choices[0].message.content;
      assert.equal(content, marker);
    });
    await Promise.all(running);
    assert.equal(pending.size, 4, 'All four inferences overlap before any receives output');
    assert.equal(calls, 8, 'Every request causes exactly one real OpenCode inference');
    const records = (await readFile(recordsFile, 'utf8')).trim().split('\n').map(JSON.parse);
    const databases = new Set(records.map(r => r.db));
    assert.ok(databases.size >= 9, 'Discovery and every request must have their own databases');
    for (const record of records) {
      assert.equal(await realpath(record.cwd), await realpath(workspace));
      assert.equal(await realpath(record.directory), await realpath(workspace));
      await assert.rejects(() => stat(record.db), { code: 'ENOENT' });
    }
    assert.equal(await readFile(path.join(workspace, 'keep.txt'), 'utf8'), 'user-owned workspace');
    assert.equal(await readFile(path.join(workspace, 'opencode.json'), 'utf8'), '{"model":"project-must-not-load/missing"}');
    assert.equal(await readFile(path.join(configDir, 'opencode.json'), 'utf8'), config);
    const report = { addonVersion: pkg.version, magpieVersion, officialMagpieUnmodified: true, officialMagpieSHA256: await hash(executable), addonSHA256: await hash(process.env.TEST_BRIDGE_PACKAGE), opencodeVersion: process.env.TEST_OPENCODE_VERSION, upstream: 'loopback fixture with saved global API key', modelsDiscovered: true, ordinaryResponse: true, streaming: true, toolsAndContinuation: true, concurrentRequests: 4, independentDatabases: databases.size, actualDirectoryObservedByOpenCodePlugin: true, existingWorkspaceFilesPreserved: true, projectConfigDisabled: true, userGlobalConfigurationUntouched: true, passed: true };
    if (process.env.TEST_MAGPIE_REPORT) await writeFile(process.env.TEST_MAGPIE_REPORT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    overlapping.resolve();
    await Promise.allSettled(running);
    if (server && server.exitCode === null) {
      const exited = new Promise(r => server.once('exit', r));
      server.kill(); await exited;
    }
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise(r => upstream.close(r));
    assert.ok(profile.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
