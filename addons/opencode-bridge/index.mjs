import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OpenCodeBridge, normalizeConfig } from './lib/bridge.mjs';

// Export only the provider plugin; Magpie calls every exported entry function.
export const OpenCodeBridgePlugin = async (_, options = {}) => {
  const file = options.configFile ?? process.env.MAGPIE_OPENCODE_CONFIG ?? fileURLToPath(new URL('./config.json', import.meta.url));
  const content = await readFile(file, 'utf8').catch(error => {
    if (error.code === 'ENOENT' && options.configFile === undefined && process.env.MAGPIE_OPENCODE_CONFIG === undefined) return '{"mode":"global"}';
    throw error;
  });
  const config = normalizeConfig(JSON.parse(content.replace(/^\uFEFF/, '')), path.dirname(path.resolve(file)));
  const bridge = new OpenCodeBridge(config);
  const id = 'opencode-bridge';
  const api = 'http://opencode-bridge.local/v1';
  const variants = model => Object.fromEntries((model.reasoningEfforts ?? []).map(effort => [effort, {}]));
  const definitions = models => Object.fromEntries(Object.entries(models).map(([name, model]) => [name, { name: model.name ?? name, limit: { context: model.context, output: model.output }, modalities: { input: ['text'], output: ['text'] }, temperature: model.temperature !== false, tool_call: model.toolcall !== false, reasoning: model.reasoning === true, variants: variants(model) }]));
  return {
    dispose: async () => bridge.close(),
    config: async (cfg) => {
      cfg.provider ??= {};
      cfg.provider[id] = {
        name: 'OpenCode bridge', npm: '@ai-sdk/openai-compatible', api,
        models: definitions(config.models),
      };
      // Register the transport before discovery. A startup failure must remain
      // a catalog/startup error instead of becoming a missing gateway endpoint.
      cfg.provider[id].models = definitions(await bridge.loadModels());
      void bridge.prewarm().catch(() => { if (config.diagnostics) console.error('[opencode-bridge] Worker prewarm failed; requests will use a fresh worker.'); });
    },
    provider: {
      id,
      models: async provider => Object.fromEntries(Object.entries(await bridge.loadModels()).map(([name, model]) => [name, {
        ...(provider.models?.[name] ?? {}), id: name, providerID: id, name: model.name ?? name,
        api: { id: name, url: api, npm: '@ai-sdk/openai-compatible' },
        limit: { context: model.context, output: model.output },
        capabilities: { temperature: model.temperature !== false, toolcall: model.toolcall !== false, reasoning: model.reasoning === true, input: { text: true }, output: { text: true } },
        variants: variants(model),
      }])),
    },
    auth: {
      provider: id,
      methods: config.mode === 'global'
        ? [{ type: 'oauth', label: 'Use the current global OpenCode login', authorize: async () => ({
          url: '', instructions: 'Uses OpenCode\'s existing login and plugins. No upstream API key is needed.', method: 'auto',
          callback: async () => ({ type: 'success', key: 'opencode-global' }),
        }) }]
        : [{ type: 'api', label: 'Upstream API key (or placeholder when apiKeyEnv is configured)' }],
      loader: async (getAuth) => ({
        apiKey: 'opencode-bridge', baseURL: api,
        fetch: async (url, init) => {
          const auth = await getAuth();
          return bridge.fetch(url, init, auth?.type === 'api' ? auth.key : undefined);
        },
      }),
    },
  };
};
