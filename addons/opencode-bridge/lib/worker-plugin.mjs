import { readFile, writeFile } from 'node:fs/promises';
import { ApiError, clientToolNames, toolPermissions, toNativeHistory } from './protocol.mjs';
import { applyReasoning } from './reasoning.mjs';

// This is loaded through OpenCode's public plugin config, without patching OpenCode.
export const BridgeWorker = async ({ directory }) => {
  let request;
  let injected = false;
  const get = async () => request ??= JSON.parse(await readFile(process.env.MAGPIE_BRIDGE_REQUEST, 'utf8'));
  return {
    config: async cfg => {
      // The final public plugin hook limits only this transient API worker.
      // Existing provider configuration and auth hooks remain intact.
      const permission = toolPermissions((await get()).body);
      cfg.permission = permission;
      cfg.agent ??= {};
      cfg.agent.bridge = { mode: 'primary', prompt: 'Follow the client instructions.', permission };
      cfg.agent.title = { disable: true };
      cfg.snapshot = false;
      cfg.autoupdate = false;
      cfg.share = 'disabled';
      for (const name of Object.keys(cfg.mcp ?? {})) if (name !== 'bridge') cfg.mcp[name] = { ...cfg.mcp[name], enabled: false };
    },
    'tool.execute.before': async ({ tool }) => {
      if (!clientToolNames((await get()).body).includes(tool)) throw new ApiError('OpenCode attempted an unregistered local tool.', 502, null, 'unregistered_tool');
    },
    'experimental.chat.messages.transform': async (_, output) => {
      const r = await get();
      // The standard SDK must settle MCP deferral acknowledgements to publish
      // finish-step. Gate any continuation before another inference can start.
      if (injected) await new Promise(() => {});
      injected = true;
      const sessionID = output.messages[0].info.sessionID;
      const selected = output.messages[0].info.model;
      output.messages.splice(0, output.messages.length, ...toNativeHistory(r.body, sessionID, r.modelID ?? selected.modelID, directory, r.providerID ?? selected.providerID).messages);
    },
    'experimental.chat.system.transform': async (_, output) => {
      const r = await get();
      output.system.splice(0, output.system.length, ...toNativeHistory(r.body, '', r.modelID, directory).system);
    },
    'chat.params': async (input, output) => {
      const { body, outputLimit, global, hookFile } = await get();
      if (!injected) throw new Error('OpenCode did not invoke the required message transformation hook.');
      if (global && (input.model.providerID === 'opencode-bridge' || input.model.id.startsWith('opencode-bridge/'))) throw new Error('OpenCode points back to this bridge. Select an upstream model in OpenCode.');
      output.temperature = body.temperature;
      output.topP = body.top_p;
      output.topK = undefined;
      try {
        const requested = body.max_completion_tokens ?? body.max_tokens;
        if (requested !== undefined && input.model.limit.output > 0 && requested > input.model.limit.output) throw new ApiError('Requested output tokens exceed the OpenCode model limit.', 400, body.max_completion_tokens !== undefined ? 'max_completion_tokens' : 'max_tokens');
        output.maxOutputTokens = requested ?? Math.min(outputLimit, input.model.limit.output || outputLimit);
        output.options = applyReasoning(input.model, output.options, body.reasoning_effort);
      } catch (error) {
        if (error instanceof ApiError) await writeFile(hookFile, JSON.stringify({ error: { status: error.status, ...error.body().error } }), { mode: 0o600 });
        throw error;
      }
      await writeFile(hookFile, JSON.stringify({ history: true, params: true }), { mode: 0o600 });
      // Provider defaults may still add vendor-specific options; request fields are never invented.
    },
  };
};
