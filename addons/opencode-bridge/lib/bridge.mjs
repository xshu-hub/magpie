import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm, symlink, cp, readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { ApiError, validateRequest, toolName, nativeToolName, usageOf, sseEvents } from './protocol.mjs';

export const OPENCODE_VERSION = '1.18.35';
const SDK = { 'openai-chat': '@ai-sdk/openai-compatible', 'openai-responses': '@ai-sdk/openai', anthropic: '@ai-sdk/anthropic' };
const delay = (ms, signal) => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

export function normalizeConfig(input, directory = process.cwd()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('Bridge configuration must be an object.', 500);
  const mode = input.mode ?? 'isolated';
  if (!['isolated', 'global'].includes(mode)) throw new ApiError('mode must be global or isolated.', 500);
  const configuredCommand = input.command ?? ['opencode'];
  if (!Array.isArray(configuredCommand) || !configuredCommand.length || configuredCommand.some(x => typeof x !== 'string' || !x)) throw new ApiError('command must be an executable and optional argument array.', 500);
  const command = [...configuredCommand];
  if (command[0].includes('/') || command[0].includes('\\')) command[0] = path.resolve(directory, command[0]);
  const models = input.models ?? (mode === 'global' ? { 'oc-default': { name: 'OpenCode default model', context: 128000, output: 16384 } } : undefined);
  if (!models || Array.isArray(models) || typeof models !== 'object' || !Object.keys(models).length) throw new ApiError('Configure at least one model.', 500);
  for (const [alias, model] of Object.entries(models)) {
    if (!alias || !model || typeof model !== 'object' || Array.isArray(model)) throw new ApiError('Each model must be an object.', 500);
    if (mode === 'global') {
      if (['id', 'protocol', 'baseURL', 'apiKeyEnv'].some(k => model[k] !== undefined)) throw new ApiError('Global mode uses OpenCode credentials and providers; use model="provider/model" only to select a model.', 500);
      if (model.model !== undefined && (typeof model.model !== 'string' || !/^[^/\s]+\/\S+$/.test(model.model))) throw new ApiError('Global model must be provider/model, or omitted for the OpenCode default.', 500);
    } else {
      if (typeof model.id !== 'string' || !model.id || !Object.hasOwn(SDK, model.protocol)) throw new ApiError('Each isolated model needs id and protocol (openai-chat, openai-responses, anthropic).', 500);
      let url;
      try { url = new URL(model.baseURL); } catch { throw new ApiError('Each model needs an absolute upstream baseURL.', 500); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ApiError('Invalid upstream baseURL.', 500);
      if (model.apiKeyEnv !== undefined && (typeof model.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(model.apiKeyEnv))) throw new ApiError('apiKeyEnv must name an environment variable.', 500);
    }
    for (const key of ['context', 'output']) if (!Number.isInteger(model[key]) || model[key] <= 0) throw new ApiError('Each model needs positive integer context and output limits.', 500);
  }
  const config = { ...input, mode, command: [...command], models, maxConcurrent: input.maxConcurrent ?? (mode === 'global' ? 1 : 2), timeoutMs: input.timeoutMs ?? 120000, startupTimeoutMs: input.startupTimeoutMs ?? 30000 };
  for (const key of ['maxConcurrent', 'timeoutMs', 'startupTimeoutMs']) if (!Number.isInteger(config[key]) || config[key] <= 0) throw new ApiError(`${key} must be a positive integer.`, 500);
  if (mode === 'global' && config.maxConcurrent !== 1) throw new ApiError('Global mode requires maxConcurrent=1 because OpenCode shares its login and refresh state.', 500);
  return config;
}

async function executableCommand(command) {
  if (process.platform !== 'win32') return command;
  // Node cannot spawn a .cmd/.ps1 shim without a shell. Follow the official npm
  // package's bin entry instead, preserving PATH selection without shell quoting.
  let selected = command[0];
  if (!selected.includes('/') && !selected.includes('\\')) {
    for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
      if (!dir) continue;
      const candidates = path.extname(selected) ? [selected] : [selected + '.exe', selected + '.com', selected + '.cmd', selected + '.bat', selected];
      const found = await Promise.all(candidates.map(async name => {
        const file = path.join(dir.replace(/^"|"$/g, ''), name);
        return await access(file).then(() => file, () => undefined);
      }));
      if (found.some(Boolean)) { selected = found.find(Boolean); break; }
    }
  }
  if (/\.(cmd|bat|ps1)$/i.test(selected)) {
    for (const root of [path.join(path.dirname(selected), 'node_modules', 'opencode-ai'), path.resolve(path.dirname(selected), '..', 'opencode-ai')]) {
      const pkg = await readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse, () => undefined);
      const bin = typeof pkg?.bin === 'string' ? pkg.bin : pkg?.bin?.opencode;
      if (pkg?.name === 'opencode-ai' && typeof bin === 'string') return [path.resolve(root, bin), ...command.slice(1)];
    }
    throw new ApiError('Cannot resolve this Windows OpenCode shim. Set command to the actual OpenCode executable or a node/script array.', 503, null, 'opencode_unavailable');
  }
  return [selected, ...command.slice(1)];
}

function sandboxEnv(home) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'windir', 'COMSPEC', 'PATHEXT', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'OPENCODE_GIT_BASH_PATH']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'),
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_STATE_HOME: path.join(home, 'state'),
    TMP: home, TEMP: home, TMPDIR: home,
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_AUTOCOMPACT: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', OPENCODE_EXPERIMENTAL_NATIVE_LLM: '1',
  });
  return env;
}

function globalEnv(home) {
  return {
    ...process.env,
    // Preserve HOME, XDG paths and authentication plugins. Isolate API sessions,
    // while refreshes remain owned by OpenCode in its genuine shared auth store.
    OPENCODE_DB: path.join(home, 'opencode.sqlite'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '0', OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
    OPENCODE_DISABLE_AUTOCOMPACT: '1', OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: '1', OPENCODE_EXPERIMENTAL_NATIVE_LLM: '0',
  };
}

async function seedPluginDependency(home) {
  // OpenCode installs its plugin SDK when it sees a plugin, even one with no imports.
  // Reuse the genuine, pinned npm dependency so isolated requests need no npm network call.
  const entry = fileURLToPath(import.meta.resolve('@opencode-ai/plugin'));
  const source = path.resolve(path.dirname(entry), '..');
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  if (manifest.version !== OPENCODE_VERSION) throw new ApiError('The OpenCode plugin SDK dependency must match the pinned v1 version.', 503);
  const dir = path.join(home, 'config', 'opencode');
  const scoped = path.join(dir, 'node_modules', '@opencode-ai');
  await mkdir(scoped, { recursive: true });
  const target = path.join(scoped, 'plugin');
  try { await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { await cp(source, target, { recursive: true }); }
  const dependencies = { '@opencode-ai/plugin': manifest.version };
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ private: true, dependencies }));
  await writeFile(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies }, 'node_modules/@opencode-ai/plugin': { version: manifest.version } } }));
}

function start(command, args, options) {
  const child = spawn(command[0], [...command.slice(1), ...args], { ...options, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let error;
  let output = '';
  const collect = (c) => { output = (output + c.toString()).slice(-16000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  child.on('error', e => { error = e; });
  // A Bun subprocess can exit before all inherited handles close on Windows.
  // Wait for its exit, not a pipe's close, and explicitly destroy our read handles.
  const done = new Promise(resolve => {
    child.once('error', () => resolve({ code: null, error, output }));
    child.once('exit', code => { child.stdout.destroy(); child.stderr.destroy(); resolve({ code, error, output }); });
  });
  return { child, done, get error() { return error; }, get output() { return output; } };
}

async function stop(process) {
  if (!process || process.child.exitCode !== null || process.error) return;
  process.child.kill();
  let timer;
  const ended = await Promise.race([process.done.then(() => true), new Promise(r => { timer = setTimeout(() => r(false), 2000); })]);
  clearTimeout(timer);
  if (!ended) { process.child.kill('SIGKILL'); await process.done; }
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(r => server.close(r));
  return port;
}

function mcpServer(body, token, deferred) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url !== '/' + token) return res.writeHead(404).end();
      if (req.method !== 'POST') return res.writeHead(405).end();
      const buffers = [];
      let size = 0;
      for await (const b of req) {
        size += b.length;
        if (size > 4 * 1024 * 1024) return res.writeHead(413).end();
        buffers.push(b);
      }
      const rpc = JSON.parse(Buffer.concat(buffers).toString('utf8'));
      if (!Object.hasOwn(rpc, 'id')) return res.writeHead(202).end();
      let result;
      switch (rpc.method) {
        case 'initialize':
          result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'magpie-opencode-bridge', version: '0.2.0' } };
          break;
        case 'ping': result = {}; break;
        case 'tools/list':
          result = { tools: (body.tool_choice === 'none' ? [] : body.tools ?? []).map(t => ({ name: toolName(t.function.name), description: t.function.description ?? t.function.name, inputSchema: t.function.parameters ?? { type: 'object', properties: {} } })) };
          break;
        case 'tools/call':
          // OpenCode owns execution, but the client must supply the result in its next API request.
          // Park until the model's step-finish event; the worker is then aborted and discarded.
          if (!deferred) return;
          // Acknowledge deferral only. No client function runs here. This lets
          // the standard SDK publish finish-step for every provider; the public
          // message hook blocks a second model step until this worker is aborted.
          result = { content: [{ type: 'text', text: 'Tool execution deferred to the API client.' }], isError: false };
          break;
        default:
          return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
  return server;
}

export class OpenCodeBridge {
  constructor(config) {
    this.config = normalizeConfig(config);
    this.active = 0;
  }
  models() {
    return { object: 'list', data: Object.keys(this.config.models).map(id => ({ id, object: 'model', created: 0, owned_by: 'opencode-bridge' })) };
  }
  async prepare(body, apiKey, signal) {
    validateRequest(body, this.config.models);
    signal?.throwIfAborted();
    if (this.active >= this.config.maxConcurrent) throw new ApiError('All OpenCode workers are busy. Retry later.', 429, null, 'worker_busy');
    const model = this.config.models[body.model];
    const global = this.config.mode === 'global';
    const upstreamKey = model.apiKeyEnv ? process.env[model.apiKeyEnv] : apiKey;
    if (!global && !upstreamKey) throw new ApiError('Upstream API key is missing. Set the configured apiKeyEnv or sign in to the Magpie plugin.', 503, null, 'missing_upstream_key');
    this.active++;
    let home, mcp, version, worker, sessionID, eventController;
    let phase = 'creating sandbox';
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timeout = setTimeout(() => controller.abort(new ApiError(`OpenCode request timed out during ${phase}.`, 504, null, 'opencode_timeout')), this.config.timeoutMs);
    let closing;
    let api;
    const cleanup = () => closing ??= (async () => {
      clearTimeout(timeout);
      eventController?.abort();
      if (sessionID && api) await api(`/session/${sessionID}/abort`, {}, AbortSignal.timeout(2000)).catch(() => {});
      await stop(version);
      await stop(worker);
      if (mcp) { mcp.closeAllConnections(); await new Promise(r => mcp.close(r)); }
      if (home) await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      this.active--;
    })();
    try {
      home = await mkdtemp(path.join(os.tmpdir(), 'magpie-oc-v1-'));
      const directory = path.join(home, 'workspace');
      await mkdir(directory);
      if (!global) await seedPluginDependency(home);
      const env = global ? globalEnv(home) : sandboxEnv(home);
      const command = await executableCommand(this.config.command);
      phase = 'version check';
      version = start(command, ['--version'], { env, cwd: directory, signal: combined });
      const checked = await version.done;
      if (checked.error || checked.code !== 0) throw new ApiError('Cannot start configured OpenCode v1 executable.', 503, null, 'opencode_unavailable');
      if (checked.output.trim() !== OPENCODE_VERSION) throw new ApiError(`This bridge requires official OpenCode v${OPENCODE_VERSION}; configured executable reports ${checked.output.trim().slice(0, 100)}.`, 503, null, 'opencode_version');
      const token = randomBytes(24).toString('hex');
      mcp = mcpServer(body, token, global);
      const mcpPort = await listen(mcp);
      const port = await freePort();
      const password = randomBytes(24).toString('hex');
      const providerID = global ? model.model?.split('/')[0] : 'opencode-bridge';
      const modelID = global ? model.model?.slice(providerID.length + 1) : model.id;
      const requestFile = path.join(home, 'request.json');
      await writeFile(requestFile, JSON.stringify({ body, modelID, providerID, outputLimit: model.output, global }), { mode: 0o600 });
      const permissions = { '*': 'deny', 'bridge_*': 'allow' };
      const config = {
        ...(global
          ? (model.model ? { model: model.model } : {})
          : { model: 'opencode-bridge/' + modelID, small_model: 'opencode-bridge/' + modelID,
            provider: { 'opencode-bridge': { name: 'Bridge upstream', npm: SDK[model.protocol], options: { baseURL: model.baseURL, apiKey: upstreamKey }, models: { [modelID]: { name: modelID, temperature: true, limit: { context: model.context, output: model.output } } } } } }),
        permission: permissions, snapshot: false, autoupdate: false, share: 'disabled',
        plugin: [pathToFileURL(fileURLToPath(new URL('./worker-plugin.mjs', import.meta.url))).href],
        mcp: { bridge: { type: 'remote', url: `http://127.0.0.1:${mcpPort}/${token}`, oauth: false, timeout: this.config.timeoutMs } },
        agent: { bridge: { mode: 'primary', prompt: 'Follow the client instructions.', permission: permissions }, title: { disable: true } },
      };
      Object.assign(env, { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_SERVER_PASSWORD: password, MAGPIE_BRIDGE_REQUEST: requestFile });
      worker = start(command, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { env, cwd: directory, signal: combined });
      phase = 'server startup';
      const headers = { authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64'), 'content-type': 'application/json' };
      const base = 'http://127.0.0.1:' + port;
      api = async (endpoint, payload, requestSignal = combined) => {
        const r = await fetch(base + endpoint, { headers, signal: requestSignal, ...(payload !== undefined ? { method: 'POST', body: JSON.stringify(payload) } : {}) });
        if (!r.ok) throw new ApiError(`OpenCode server returned HTTP ${r.status}.`, 502, null, 'opencode_server_error');
        return r.status === 204 ? null : r.json();
      };
      const deadline = Date.now() + this.config.startupTimeoutMs;
      while (true) {
        combined.throwIfAborted();
        if (worker.error || worker.child.exitCode !== null) throw new ApiError('OpenCode server exited during startup.', 503, null, 'opencode_startup');
        // A connection accepted while v1 attaches its HTTP handlers can remain unanswered.
        // Bound each probe so that an early connection cannot consume the request's whole timeout.
        try {
          const health = await api('/global/health', undefined, AbortSignal.any([combined, AbortSignal.timeout(1000)]));
          if (health.version !== OPENCODE_VERSION) throw new ApiError('OpenCode server version differs from the pinned v1 executable.', 503, null, 'opencode_version');
          break;
        } catch (error) {
          if (error instanceof ApiError && error.code === 'opencode_version') throw error;
          if (Date.now() >= deadline) throw new ApiError('OpenCode server startup timed out.', 503, null, 'opencode_startup');
          await delay(100, combined);
        }
      }
      phase = 'MCP initialization';
      const status = await api('/mcp');
      if (status.bridge?.status !== 'connected') throw new ApiError('OpenCode could not connect to the client tool bridge.', 502, null, 'mcp_unavailable');
      phase = 'session creation';
      const session = await api('/session', { title: 'OpenAI API bridge' });
      sessionID = session.id;
      eventController = new AbortController();
      const eventSignal = AbortSignal.any([combined, eventController.signal]);
      const events = await fetch(base + '/event', { headers, signal: eventSignal });
      if (!events.ok || !events.body) throw new ApiError('OpenCode event stream is unavailable.', 502);
      phase = 'inference';
      await api(`/session/${sessionID}/prompt_async`, { ...(providerID ? { model: { providerID, modelID } } : {}), agent: 'bridge', parts: [{ type: 'text', text: 'Complete the current client request.' }] });
      return { events: events.body, sessionID, cleanup, signal: combined, abort: () => api(`/session/${sessionID}/abort`, {}, AbortSignal.timeout(2000)),
        diagnose: async details => { if (typeof this.config.onFailure === 'function') await this.config.onFailure({ phase, home, output: worker?.output ?? '', ...details }).catch(() => {}); },
      };
    } catch (error) {
      if (typeof this.config.onFailure === 'function') await this.config.onFailure({ phase, home, output: worker?.output ?? version?.output ?? '' }).catch(() => {});
      await cleanup();
      throw combined.aborted ? combined.reason : error;
    }
  }
  async fetch(url, init = {}, apiKey) {
    try {
      const endpoint = new URL(url).pathname.replace(/\/$/, '');
      if (endpoint === '/v1/models' && (!init.method || init.method === 'GET')) return Response.json(this.models());
      if (endpoint !== '/v1/chat/completions' || init.method !== 'POST') throw new ApiError('Only /v1/models and /v1/chat/completions are supported.', 404, null, 'unsupported_endpoint');
      let body;
      try { body = JSON.parse(init.body); } catch { throw new ApiError('Malformed JSON request.'); }
      const run = await this.prepare(body, apiKey, init.signal);
      const id = 'chatcmpl-' + randomUUID();
      const created = Math.floor(Date.now() / 1000);
      const chunks = this.chunks(body, run, { id, created, model: body.model });
      if (!body.stream) {
        let content = '', reasoning = '', calls = [], finish, usage;
        for await (const chunk of chunks) {
          const choice = chunk.choices[0];
          if (choice) {
            content += choice.delta.content ?? '';
            reasoning += choice.delta.reasoning_content ?? '';
            for (const call of choice.delta.tool_calls ?? []) calls[call.index] = { id: call.id, type: 'function', function: call.function };
            if (choice.finish_reason) finish = choice.finish_reason;
          }
          if (chunk.usage) usage = chunk.usage;
        }
        const message = { role: 'assistant', content: content || null, ...(calls.length ? { tool_calls: calls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}) };
        return Response.json({ id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message, finish_reason: finish, logprobs: null }], usage });
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const next = await chunks.next();
            if (next.done) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
            else controller.enqueue(encoder.encode('data: ' + JSON.stringify(next.value) + '\n\n'));
          } catch (e) {
            const error = e instanceof ApiError ? e : new ApiError('OpenCode stream failed.', 502, null, 'opencode_stream_error');
            controller.enqueue(encoder.encode('data: ' + JSON.stringify(error.body()) + '\n\n'));
            controller.close();
          }
        },
        async cancel() { await run.cleanup(); await chunks.return(); },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-opencode-version': OPENCODE_VERSION } });
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError(init.signal?.aborted ? 'Request cancelled.' : 'OpenCode bridge failed.', init.signal?.aborted ? 499 : 502, null, 'opencode_error');
      return Response.json(error.body(), { status: error.status, ...(error.status === 429 ? { headers: { 'retry-after': '1' } } : {}) });
    }
  }
  async* chunks(body, run, meta) {
    const chunk = (delta, finish_reason = null, usage) => ({ ...meta, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason, logprobs: null }], ...(usage ? { usage } : {}) });
    const names = new Map((body.tools ?? []).map(t => [nativeToolName(t.function.name), t.function.name]));
    const toolIDs = new Set();
    const textParts = new Map();
    const assistantIDs = new Set();
    const trace = [];
    let finished = false;
    try {
      yield chunk({ role: 'assistant', content: '' });
      for await (const event of sseEvents(run.events)) {
        run.signal.throwIfAborted();
        const p = event.properties ?? {};
        if (typeof this.config.onFailure === 'function') {
          trace.push({ type: event.type, session: p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID, role: p.info?.role, part: p.part?.type, reason: p.part?.reason });
          if (trace.length > 50) trace.shift();
        }
        if (p.sessionID !== run.sessionID && p.part?.sessionID !== run.sessionID && p.info?.sessionID !== run.sessionID) continue;
        if (event.type === 'message.updated' && p.info?.role === 'assistant') {
          assistantIDs.add(p.info.id);
          if (p.info.error) throw new ApiError(p.info.error.data?.message ?? 'OpenCode inference failed.', 502, null, 'opencode_inference_error');
        }
        if (event.type === 'session.error') throw new ApiError(p.error?.data?.message ?? 'OpenCode session failed.', 502, null, 'opencode_session_error');
        if (event.type === 'permission.asked' || event.type === 'question.asked') throw new ApiError('OpenCode asked for interactive input.', 502, null, 'opencode_interactive');
        if (event.type === 'session.status' && p.status?.type === 'retry') throw new ApiError('OpenCode upstream is retrying; this bridge returns the failure to the client.', 502, null, 'opencode_retry');
        if (event.type === 'session.idle') throw new ApiError('OpenCode ended without a model completion.', 502);
        if (event.type === 'message.part.delta' && assistantIDs.has(p.messageID) && p.field === 'text') {
          const state = textParts.get(p.partID);
          if (state) { state.sent += p.delta; yield chunk({ [state.type === 'reasoning' ? 'reasoning_content' : 'content']: p.delta }); }
        }
        if (event.type !== 'message.part.updated' || !assistantIDs.has(p.part?.messageID)) continue;
        const part = p.part;
        if (['text', 'reasoning'].includes(part.type)) {
          const state = textParts.get(part.id) ?? { type: part.type, sent: '' };
          if (!part.text.startsWith(state.sent)) throw new ApiError('OpenCode rewrote text already streamed to the client.', 502, null, 'opencode_text_rewrite');
          const delta = part.text.slice(state.sent.length);
          state.sent = part.text;
          textParts.set(part.id, state);
          if (delta) yield chunk({ [part.type === 'reasoning' ? 'reasoning_content' : 'content']: delta });
        }
        if (part.type === 'tool' && part.state.status === 'running' && !toolIDs.has(part.callID)) {
          const name = names.get(part.tool);
          if (!name) throw new ApiError('OpenCode attempted an unregistered local tool.', 502, null, 'unregistered_tool');
          const index = toolIDs.size;
          toolIDs.add(part.callID);
          yield chunk({ tool_calls: [{ index, id: part.callID, type: 'function', function: { name, arguments: JSON.stringify(part.state.input) } }] });
        }
        if (part.type === 'tool' && part.state.status === 'error') throw new ApiError('OpenCode rejected the tool call before returning it.', 502, null, 'opencode_tool_error');
        if (part.type === 'step-finish') {
          if (part.reason === 'tool-calls' && !toolIDs.size) throw new ApiError('OpenCode finished a tool batch without usable calls.', 502);
          if (!['stop', 'length', 'tool-calls'].includes(part.reason)) throw new ApiError(`Unsupported OpenCode finish reason: ${part.reason}.`, 502);
          // The native v1 runtime publishes this before waiting for client-owned MCP calls.
          await run.abort();
          const usage = usageOf(part.tokens);
          const reason = part.reason === 'tool-calls' ? 'tool_calls' : part.reason;
          yield chunk({}, reason, body.stream ? undefined : usage);
          if (body.stream && body.stream_options?.include_usage) yield { ...meta, object: 'chat.completion.chunk', choices: [], usage };
          finished = true;
          break;
        }
      }
      if (!finished) throw new ApiError('OpenCode disconnected before completion.', 502, null, 'incomplete_stream');
    } catch (error) { await run.diagnose?.({ events: trace }); throw error; }
    finally { await run.cleanup(); }
  }
}
