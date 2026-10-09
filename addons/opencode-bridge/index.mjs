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
  return {
    config: async (cfg) => {
      const models = await bridge.loadModels();
      cfg.provider ??= {};
      cfg.provider[id] = {
        name: 'OpenCode bridge', npm: '@ai-sdk/openai-compatible', api: 'http://opencode-bridge.local/v1',
        models: Object.fromEntries(Object.entries(models).map(([name, model]) => [name, { name: model.name ?? name, limit: { context: model.context, output: model.output }, modalities: { input: ['text'], output: ['text'] } }])),
      };
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
        apiKey: 'opencode-bridge', baseURL: 'http://opencode-bridge.local/v1',
        fetch: async (url, init) => {
          const auth = await getAuth();
          return bridge.fetch(url, init, auth?.type === 'api' ? auth.key : undefined);
        },
      }),
    },
  };
};
