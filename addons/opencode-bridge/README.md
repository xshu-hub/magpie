# Magpie OpenCode v1 bridge

这个插件向 Magpie 增加 `opencode-bridge` 供应商。每次推理都由**真实的官方 OpenCode v1.18.35 程序**发起，再访问你配置的上游。没有修改 OpenCode 源码或二进制，不使用本机的 v2，也不直接模拟 OpenCode 的鉴权请求。

请求方向：客户端 → Magpie → 插件 → OpenCode v1 → 上游；返回方向相反。插件也提供独立的 OpenAI Chat HTTP 服务。

## 安装

需要 Node.js 22+；Magpie 的插件宿主使用 Bun。GitHub Actions 的 `magpie-opencode-bridge-windows-x64` / `linux-x64` 产物包含 Magpie 二进制、插件 tgz、配置示例和 SHA256SUMS。Windows 产物同时有桌面程序和 CLI。上游原有自动发布流程不用于这个分支。

在下载目录解压插件：

```sh
tar -xzf xshu-hub-magpie-opencode-bridge-0.1.0.tgz
npm install --prefix package --ignore-scripts --no-audit --no-fund
npm install --prefix runtime --no-audit --no-fund opencode-ai@1.18.35
```

这是独立安装，不使用 `npm install -g`，不会替换已有 OpenCode v2。

复制 `package/config.example.json` 到 `package/config.json`，修改：

- `command`：**绝对路径**的 v1 命令数组。Windows 是 `runtime/node_modules/opencode-ai/bin/opencode.exe`；Linux/macOS 是 `runtime/node_modules/opencode-ai/bin/opencode`。Linux/macOS 的 npm launcher 需要 Node 在 PATH。
- `models`：客户端可用的模型别名；`id` 是上游真实模型名。
- `protocol`：`openai-chat`、`openai-responses` 或 `anthropic`。目前自动端到端验收覆盖 `openai-chat`；其他两种是 OpenCode 原生适配路径，尚未用真实供应商验收。
- `baseURL`：供应商 API 基址，不能指回使用这个插件的 Magpie，避免递归。
- `apiKeyEnv`：可选，上游密钥的环境变量名。删除它时，使用你在 Magpie 插件登录中填写的上游 API key。不同模型使用不同密钥时分别指定环境变量。
- `context` / `output`：供应商实际模型限制；请求的 token 上限不能超过 `output`。

不要将带密钥的配置提交到 GitHub。示例只存环境变量名称。

```sh
magpie plugin add ./package
magpie plugin login opencode-bridge
```

登录时填上游 API key；如果所有模型都使用 `apiKeyEnv`，可填占位值。供应商随后出现在 Magpie 的 Providers 页面，模型名为 `opencode-bridge/oc-gpt`（后缀取你的配置别名）。使用现有 Magpie 的网关即可，不必替换主程序。通过 `magpie plugin options` 的 `configFile` 也可以指定配置文件绝对路径；设置前，默认 `package/config.json` 需能成功加载。

客户端示例，网关密钥由你自己的 Magpie 配置决定：

```sh
curl http://127.0.0.1:3425/v1/chat/completions \
  -H 'Authorization: Bearer magpie' -H 'Content-Type: application/json' \
  -d '{"model":"opencode-bridge/oc-gpt","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 独立服务

Windows PowerShell：

```powershell
$env:BRIDGE_API_KEY = 'your-client-key'
$env:UPSTREAM_API_KEY = 'your-upstream-key'
node package/bin/serve.mjs --config package/config.json --port 8787
```

Linux/macOS：

```sh
export BRIDGE_API_KEY='your-client-key'
export UPSTREAM_API_KEY='your-upstream-key'
node package/bin/serve.mjs --config package/config.json --port 8787
```

仅监听 `127.0.0.1`，要求 Bearer 网关密钥。客户端基址为 `http://127.0.0.1:8787/v1`；模型名为 `oc-gpt`。需要远程使用时接到 Magpie 的共享网关，按 Magpie 自身的访问控制配置。

## 实现与兼容范围

每个 API 请求启动一个独立 OpenCode worker，使用自己的临时 HOME、配置、数据库、事件流和 MCP 地址。真实用户的 OpenCode 配置、登录和工程文件不会被读取。并发默认 2，满时返回 429。每次请求的完整客户端历史通过 OpenCode 的官方 `experimental.chat.messages.transform` 接口转换为原生 user/assistant/tool 记录；系统消息、temperature、top_p、输出 token 上限通过标准插件 hooks 设置。内置文件、shell、网络等工具全部禁用。

客户端的函数通过远程 MCP 注册给 OpenCode。模型发出工具调用时，OpenCode 发起 MCP 调用并等待。v1 自带的 `OPENCODE_EXPERIMENTAL_NATIVE_LLM=1` 运行时先发布完整 `step-finish`，插件据此返回整批调用并取消 worker，**不会执行客户端工具**。客户端执行后，将 assistant 的 tool_calls 和 role=tool 结果加入下一次普通 OpenAI 请求即可；不需要额外 session ID，也不依赖前一个 worker 还在运行。

| 能力 | 首版行为 |
| --- | --- |
| `/v1/models`、`/v1/chat/completions` | 支持 |
| 文本、多轮角色历史、system/developer | 支持；system/developer 需位于历史开头，按顺序合成系统提示 |
| stream=true/false | 支持；SSE 结束为 `[DONE]`，流中失败发送 error 后关闭，不发送成功结束标志 |
| tools、工具结果续接、同一轮多个调用 | 支持普通 function 工具与文本结果；结果按 tool_call_id 匹配，输出可以逆序提交 |
| temperature、top_p、max_tokens/max_completion_tokens | 通过 OpenCode 参数 hook 设置；最终是否接受仍取决于上游模型 |
| stream_options.include_usage | 支持，计数来自 OpenCode；缓存和推理 token 合回 OpenAI 总数 |
| tool_choice | 只支持 auto/none；none 不注册可用工具 |
| n | 只支持 1 |
| 图片、音频、视频、嵌入、文件内容、JSON schema 输出 | 未实现，返回 400/404 |
| stop、seed、logprobs、penalties、logit_bias、reasoning_effort、strict、指定工具、parallel_tool_calls 参数 | 不支持，明确报错 |
| 原生 OpenAI Responses | 独立服务未实现；Magpie 自带的协议转换可继续使用，但本插件的验收保证限于 Chat 路径 |

与原生 OpenAI 的差异：

1. OpenCode v1 的默认 AI SDK 运行时会先等待 MCP 执行完成，不能用它判断整批工具已生成；因此固定官方 **1.18.35**，开启其原生运行时，不接受 v2 或其他未经验证版本。
2. OpenCode 不发布原始工具 arguments 的逐字 delta；外部工具参数在完整解析后以一个 delta 返回，JSON 空白、字段序和原始字节不会保留。文本仍按事件增量返回。
3. MCP 工具名在上游是确定的 hash 别名，外部恢复原名。OpenCode 把 schema 根级 additionalProperties 设为 false；显式 true 和 strict 模式被拒绝，其他 JSON Schema 仍受 MCP/供应商支持范围限制。
4. 工具结果在 OpenCode 原生消息中与原 assistant 调用关联；多个结果会按调用顺序归组。developer 转成 system，多个系统块可能合并。原生协议的逐字段/逐字节等价不作保证。
5. 每次请求有进程启动和初始化开销、更多内存占用；这是正确性优先的初版，尚无 worker 池。流式慢读可能阻塞事件读取，timeoutMs 是整个请求上限。
6. 不复用 OpenCode 的原有 OAuth 订阅或登录插件；上游是明确配置的 API key。没有验证真实付费供应商账号。当前验收是**真实 OpenCode + 真实 Magpie/Bun 宿主 + 本地模拟供应商**。
7. OpenCode 的错误重试、消息转换和实验接口会影响兼容性；错误统一映射为网关错误，无法保持供应商原始 HTTP 状态和所有扩展字段。

## 开发验证

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
# JSON 命令数组，使用独立安装的官方 v1
TEST_OPENCODE_COMMAND='["/absolute/path/to/opencode-v1"]' npm run test:integration
```

从仓库根目录验证完整网关：

```sh
TEST_OPENCODE_COMMAND='["/absolute/path/to/opencode-v1"]' \
  go test -tags nogui -count=1 -timeout 4m ./internal/gateway -run '^TestOpenCodeV1Bridge$'
```

测试的上游全是 loopback fixture，不使用真实 key，不访问供应商，不执行用户工具。测试覆盖真实 v1 发起请求、完整角色历史和参数、UTF-8 流式返回、并行工具、逆序工具结果与新 worker 续接、取消、满载 429 和无效参数拒绝。GitHub workflow 同时在 Linux、Windows 上跑新测试，并构建对应 Magpie/插件产物；Linux 运行完整 nogui Go suite。
