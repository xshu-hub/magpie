import { readFile } from 'node:fs/promises';
import { toNativeHistory } from './protocol.mjs';

// This is loaded through OpenCode's public plugin config, without patching OpenCode.
export const BridgeWorker = async ({ directory }) => {
  let request;
  const get = async () => request ??= JSON.parse(await readFile(process.env.MAGPIE_BRIDGE_REQUEST, 'utf8'));
  return {
    'experimental.chat.messages.transform': async (_, output) => {
      const r = await get();
      const sessionID = output.messages[0].info.sessionID;
      output.messages.splice(0, output.messages.length, ...toNativeHistory(r.body, sessionID, r.modelID, directory).messages);
    },
    'experimental.chat.system.transform': async (_, output) => {
      const r = await get();
      output.system.splice(0, output.system.length, ...toNativeHistory(r.body, '', r.modelID, directory).system);
    },
    'chat.params': async (_, output) => {
      const { body, outputLimit } = await get();
      output.temperature = body.temperature;
      output.topP = body.top_p;
      output.topK = undefined;
      output.maxOutputTokens = body.max_completion_tokens ?? body.max_tokens ?? outputLimit;
      // Provider defaults may still add vendor-specific options; request fields are never invented.
    },
  };
};
