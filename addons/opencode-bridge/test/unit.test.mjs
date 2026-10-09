import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, toNativeHistory, nativeToolName, usageOf, sseEvents } from '../lib/protocol.mjs';
import { normalizeConfig } from '../lib/bridge.mjs';
const models = { test: { output: 100 } };
const base = () => ({ model: 'test', messages: [{ role: 'user', content: 'Hello' }] });
test('global mode needs no supplier configuration or upstream key and serializes shared auth', () => {
  const config = normalizeConfig({ mode: 'global' });
  assert.deepEqual(config.command, ['opencode']);
  assert.equal(config.maxConcurrent, 1);
  assert.equal(config.discoverModels, true);
  assert.equal(normalizeConfig({ mode: 'global', models: { selected: { model: 'provider/model', context: 1, output: 1 } } }).discoverModels, false);
  assert.throws(() => normalizeConfig({ mode: 'global', discoverModels: 'yes' }), /discoverModels/);
  assert.deepEqual(Object.keys(config.models), ['oc-default']);
  assert.equal(config.models['oc-default'].model, undefined);
  assert.throws(() => normalizeConfig({ mode: 'global', maxConcurrent: 2 }), /shared|shares/);
  assert.throws(() => normalizeConfig({ mode: 'global', models: { test: { baseURL: 'https://api.example/v1', context: 1, output: 1 } } }), /credentials/);
  assert.throws(() => normalizeConfig({ mode: 'global', models: { test: { model: 'missing-provider', context: 1, output: 1 } } }), /provider\/model/);
});
test('reject unsupported API semantics before inference', () => {
  for (const extra of [{ n: 2 }, { response_format: { type: 'json_object' } }, { tool_choice: 'required' }, { parallel_tool_calls: false }, { max_tokens: 101 }, { stop: ['x'] }, { stream: 'yes' }, { temperature: -1 }]) assert.throws(() => validateRequest({ ...base(), ...extra }, models));
  assert.throws(() => validateRequest({ ...base(), messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image' } }] }] }, models));
  assert.throws(() => validateRequest({ ...base(), tools: [{ type: 'function', function: { name: 'x', strict: true } }] }, models));
  assert.throws(() => validateRequest({ ...base(), model: '__proto__' }, models));
  assert.equal(validateRequest({ ...base(), temperature: 0, max_tokens: 100, tools: [], tool_choice: 'none' }, models).temperature, 0);
});
test('preserve role history and associate reversed parallel tool results by id', () => {
  const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{"city":"北京"}' } });
  const request = { model: 'test', messages: [{ role: 'system', content: 'Only answer in Chinese.' }, { role: 'user', content: 'Weather?' }, { role: 'assistant', content: 'Checking.', tool_calls: [call('a', 'weather'), call('b', 'time')] }, { role: 'tool', tool_call_id: 'b', content: '10:00' }, { role: 'tool', tool_call_id: 'a', content: 'Sunny' }] };
  validateRequest(request, models);
  const history = toNativeHistory(request, 'ses_test', 'upstream-model', '/sandbox');
  assert.deepEqual(history.system, ['Only answer in Chinese.']);
  assert.deepEqual(history.messages.map(m => m.info.role), ['user', 'assistant']);
  const tools = history.messages[1].parts.filter(p => p.type === 'tool');
  assert.equal(tools[0].tool, nativeToolName('weather'));
  assert.equal(tools[0].state.output, 'Sunny');
  assert.equal(tools[1].state.output, '10:00');
  assert.equal(tools[0].state.input.city, '北京');
  assert.throws(() => validateRequest({ ...request, messages: request.messages.slice(0, -1) }, models));
  assert.throws(() => validateRequest({ ...request, messages: [...request.messages, request.messages.at(-1)] }, models));
});
test('cache and reasoning tokens map to OpenAI totals', () => {
  assert.deepEqual(usageOf({ input: 10, output: 3, reasoning: 2, cache: { read: 7, write: 5 } }), { prompt_tokens: 22, completion_tokens: 5, total_tokens: 27, prompt_tokens_details: { cached_tokens: 7 }, completion_tokens_details: { reasoning_tokens: 2 } });
});
test('SSE survives every UTF-8/CRLF split and rejects incomplete tails', async () => {
  const bytes = Buffer.from('data: {"text":"你好"}\r\n\r\ndata: {"text":"ok"}\n\n');
  async function* input() { for (const b of bytes) yield Buffer.from([b]); }
  assert.deepEqual(await Array.fromAsync(sseEvents(input())), [{ text: '你好' }, { text: 'ok' }]);
  async function* cut() { yield Buffer.from('data: {"text":'); }
  await assert.rejects(async () => { for await (const _ of sseEvents(cut())) {} }, /mid-frame/);
});
