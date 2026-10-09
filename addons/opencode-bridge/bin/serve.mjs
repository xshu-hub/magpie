#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { OpenCodeBridge, normalizeConfig } from '../lib/bridge.mjs';
import { ApiError } from '../lib/protocol.mjs';

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} needs a value.`);
  return args[index + 1];
};
if (args.includes('--help')) {
  console.log('Usage: magpie-opencode-bridge --config config.json [--port 8787] [--opencode /path/to/v1/executable]\nSet BRIDGE_API_KEY for client authentication. Global mode reuses OpenCode login; isolated mode needs an upstream API key.');
  process.exit(0);
}
const configFile = path.resolve(value('--config', 'config.json'));
const config = normalizeConfig(JSON.parse(await readFile(configFile, 'utf8')), path.dirname(configFile));
if (args.includes('--opencode')) config.command = [path.resolve(value('--opencode'))];
const bridge = new OpenCodeBridge(config);
const key = process.env.BRIDGE_API_KEY;
if (!key) throw new Error('Set BRIDGE_API_KEY before starting the server.');
const port = Number(value('--port', '8787'));
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
const authenticated = (req) => {
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + key);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
};
const controllers = new Set();
const server = http.createServer(async (req, res) => {
  const controller = new AbortController();
  controllers.add(controller);
  const disconnect = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', disconnect);
  try {
    if (!authenticated(req)) return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify(new ApiError('Invalid API key.', 401, null, 'invalid_api_key').body()));
    const buffers = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new ApiError('Request body exceeds 4 MiB.', 413);
      buffers.push(chunk);
    }
    const response = await bridge.fetch('http://127.0.0.1' + req.url, { method: req.method, body: req.method === 'POST' ? Buffer.concat(buffers).toString('utf8') : undefined, signal: controller.signal });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      for await (const chunk of response.body) {
        if (res.destroyed) break;
        if (!res.write(Buffer.from(chunk))) await new Promise((resolve, reject) => {
          const drain = () => { res.off('close', close); resolve(); };
          const close = () => { res.off('drain', drain); reject(new Error('Client disconnected.')); };
          res.once('drain', drain); res.once('close', close);
        });
      }
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      const error = e instanceof ApiError ? e : new ApiError('Bridge request failed.', 502);
      res.writeHead(error.status, { 'content-type': 'application/json' }).end(JSON.stringify(error.body()));
    } else res.destroy();
  } finally { controllers.delete(controller); res.off('close', disconnect); }
});
server.requestTimeout = 30000;
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
console.log(`OpenCode v1 bridge listening on http://127.0.0.1:${server.address().port}/v1`);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  for (const controller of controllers) controller.abort();
  server.close(); server.closeAllConnections();
});
