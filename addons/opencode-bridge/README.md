# Magpie OpenCode bridge

0.4.0 的默认示例使用**全局 OpenCode**，继承它的登录、订阅认证插件和供应商配置，**不限制版本号**。网关不要求填写上游地址或 API Key；推理与凭证刷新均由真实 OpenCode 程序完成。没有修改 OpenCode 源码或二进制。

请求方向：客户端 → Magpie → 插件 → 全局 OpenCode → 它配置的上游。也可运行独立的 OpenAI Chat HTTP 服务。

## Windows 安装

需要在 PATH 上能够运行的 OpenCode。Magpie GUI 首次加载插件时会自动下载自己的 Bun 宿主；仅独立 Node 服务需要 Node.js 22+。

先检查全局程序：

```powershell
opencode --version
opencode models
```

确认这个全局 OpenCode 自己已能使用目标账号和模型完成对话。本插件不登录或转移供应商账号，不替换全局安装，也不要求升级到指定版本。1.16.2 和 1.18.35 已纳入真实程序测试；其他版本照常尝试接入。兼容性取决于它实际提供的 HTTP API 和插件 hooks，接口缺失时会返回具体错误。

下载构建 ZIP，解压到例如 `C:\Magpie-OpenCode`，将其中的插件 `.tgz` 解压得到 `package` 文件夹。

双击 `magpie-windows-amd64.exe`，在「插件 → 发现」下方选择该 `package` 文件夹并安装，再到「已安装」点击 OpenCode bridge 对应的「登录」启用桥接。无需创建 `config.json`、填写供应商地址或密钥，也无需安装插件的 npm 依赖。首次启动会从真实全局 OpenCode 自动读取模型列表。

也可在解压目录用 CLI 安装：

```powershell
tar -xzf xshu-hub-magpie-opencode-bridge-0.4.0.tgz
.\magpie-cli-windows-amd64.exe plugin add .\package
.\magpie-cli-windows-amd64.exe plugin login opencode-bridge
.\magpie-cli-windows-amd64.exe serve
```

全局模式的 `plugin login` 只是启用桥接，不弹出供应商登录，也不询问上游 API Key。也可以使用已有 Magpie 的插件命令和桌面网关。

未提供 `config.json` 时默认使用全局模式并自动发现模型。文件仅用于高级覆盖，例如指定可执行文件、超时或模型别名；以下配置也是可选的：

```json
{
  "mode": "global",
  "command": ["opencode"],
  "maxConcurrent": 1,
  "timeoutMs": 120000,
  "startupTimeoutMs": 30000
}
```

`command` 使用 PATH 上的全局程序。Windows 官方 npm `.cmd` 包装器会解析为同一安装包声明的原生 bin，不通过 shell 拼接执行；自定义包装器需要明确填写可执行文件路径，或 `["node", "脚本绝对路径"]`。GUI 需要重新打开才能继承刚更新的 PATH。

运行 Magpie 的用户和环境须与全局 OpenCode 一致，才能继承 HOME、XDG 路径、环境变量和登录插件。作为另一用户的服务或在容器中运行，不会自动获得桌面用户的登录。

## 客户端连接

| 配置项 | Magpie 网关 |
| --- | --- |
| API Base URL | `http://127.0.0.1:3425/v1` |
| API Key | 默认本机模式可填 `magpie`；共享模式使用实际网关密钥 |
| 模型 | `opencode-bridge/oc-default` |

`oc-default` 使用 OpenCode 自己的默认模型选择逻辑。0.4.0 默认通过真实全局 OpenCode 的 `/provider` API 自动枚举已连接供应商的文本模型，客户端可直接选择 `opencode-bridge/provider/model`，例如 `opencode-bridge/xshu/gpt-6.1-sol`。OpenCode 报告为可用的免费模型也会列出。模型列表只复制名称、选择 ID 和 token 上限，不复制凭证、上游地址、请求头或供应商 options。

每个插件宿主加载时读取一次模型列表，模型配置更新后重启 Magpie，或停用再启用插件重新加载。显式设置 `models` 时默认仅列出这些别名；设置 `discoverModels: true` 可同时加入自动发现的模型，`discoverModels: false` 可只保留默认别名。需要自定义别名时只指定 OpenCode 已有的模型名，不填上游地址和密钥：

```json
{
  "mode": "global",
  "command": ["opencode"],
  "models": {
    "oc-default": { "name": "OpenCode 默认模型", "context": 128000, "output": 16384 },
    "oc-selected": { "model": "provider/model", "context": 128000, "output": 16384 }
  }
}
```

把 `provider/model` 换成 `opencode models` 中实际可用的名字；`context` 与 `output` 用实际限制。默认别名的桥接输出上限为 16384，OpenCode hook 会进一步遵守实际模型的输出上限。客户端调用 `opencode-bridge/oc-selected` 时，供应商认证仍由 OpenCode 处理。如果 OpenCode 的模型被 Magpie 配成了本桥接自身，应先在 OpenCode 中选择真实上游模型，避免递归。

在另一个 PowerShell 终端测试：

```powershell
$body = @{
  model = 'opencode-bridge/oc-default'
  messages = @(@{ role = 'user'; content = '你好' })
} | ConvertTo-Json -Depth 10
Invoke-RestMethod -Uri 'http://127.0.0.1:3425/v1/chat/completions' -Method Post `
  -Headers @{ Authorization = 'Bearer magpie' } `
  -ContentType 'application/json; charset=utf-8' `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body))
```

流式请求设置 `stream: true`。工具调用使用普通 OpenAI `tools`；客户端执行函数后，把 assistant 的 `tool_calls` 与对应 `role: tool` 消息加入下一次请求。不需要额外 session ID。

## 全局模式的运行方式

每个请求启动同一全局安装中的 OpenCode 程序，工作目录与会话数据库是临时文件。HOME、配置、登录和认证插件保留原路径，所以 token 刷新由 OpenCode 写回真实登录文件，不是复制一份快照再丢弃。桥接代码不解析或发送供应商 token。

两个模式均使用 OpenCode 的标准 AI SDK 运行时，使全局模式中供应商插件的 `auth.loader` 与 `fetch` 保持生效。既有插件会照常执行，OpenCode 本身可能维护配置目录的依赖、缓存、日志或配置格式；桥接不改写供应商配置。

内置工具和其他 MCP 服务在这个 API worker 内禁用。客户端函数以 MCP 形式注册；调用时只返回“交由客户端执行”的内部确认，不执行函数。标准 SDK 完成整批调用后发布 `step-finish`。公开的消息 hook 阻止下一轮模型推理，网关据该事件返回工具调用并取消 worker；该内部确认不会发送给客户端，也不会被用于下一次供应商推理。下一次请求重新注入完整历史和客户端的真实结果。

共享登录文件可能发生并发刷新，所以全局模式仅允许一个活动请求，满时返回 429。其他同时运行的 OpenCode 实例仍可能共享这个文件，其并发写入行为由 OpenCode 本身决定。

## 兼容范围与差异

| 能力 | 当前行为 |
| --- | --- |
| `/v1/models`、`/v1/chat/completions` | 支持；默认列出 OpenCode 已连接供应商的文本模型及 oc-default |
| 文本、多轮角色历史、system/developer | 支持；system/developer 位于历史开头，按顺序合成系统提示 |
| stream=true/false | 支持；成功 SSE 以 `[DONE]` 结束，失败发送 error 后关闭 |
| tools、同轮多个调用、工具结果续接 | 支持普通 function 工具与文本结果；结果按 tool_call_id 匹配 |
| temperature、top_p、max_tokens/max_completion_tokens | 通过 OpenCode 参数 hook 设置；最终接受范围由实际模型决定 |
| stream_options.include_usage | 支持；计数来自 OpenCode |
| tool_choice | auto/none；none 不注册工具 |
| n | 仅 1 |
| 图片、音频、视频、嵌入、文件、JSON schema 输出 | 未实现，返回 400/404 |
| stop、seed、logprobs、penalties、logit_bias、reasoning_effort、strict=true、指定工具、parallel_tool_calls 参数 | 不支持，明确报错 |
| 原生 Responses | 独立服务未实现；Magpie 既有转换可用，但验收保证限于 Chat |

工具参数在完整解析后返回，不保留原始逐字 delta、JSON 空白或字段顺序。MCP 使用哈希工具名，外部恢复原名；schema 根级 `additionalProperties=true` 和 strict 模式被拒绝。developer 会转成 system，工具结果可能按原调用顺序归组。供应商的所有扩展字段和原始 HTTP 状态不保证透传。

每次请求有启动开销，未实现 worker 池。超时包含初始化时间。启动检查会确认 HTTP 事件连接，并确认消息与参数 hooks 已执行；不检查版本白名单。`x-opencode-version` 响应头记录服务器实际报告的版本，未报告时省略。历史注入与事件转换仍依赖 OpenCode 的公开实验 hooks，因此不限制版本不等于已经验证所有版本。程序若不提供这些能力，将返回接口或 hook 兼容错误。

接入不要求指定某家供应商。自动验收使用真实官方 1.16.2 / 1.18.35、真实 Magpie/Bun 宿主，以及临时全局登录文件和本地模拟供应商；覆盖已存 API Key、自定义 OAuth 插件的 token 刷新、标准 SDK 的工具批次与结果续接。另外已在 Windows 上用现有全局 1.16.2 和真实自定义供应商完成普通回复、SSE 流式、工具调用、工具结果续接四项联网测试，全局供应商配置未变。发现的 Windows npm manifest UTF-8 BOM 解析问题已修复并加入回归测试。真实订阅账号、每个第三方认证插件和其他版本没有全部验证；目标账号首先须能在同一个全局 OpenCode 中正常推理。

## 独立服务

```powershell
$env:BRIDGE_API_KEY = 'your-client-key'
node package/bin/serve.mjs --config package/config.json --port 8787
```

仅监听 `127.0.0.1`，要求 Bearer 网关密钥。客户端基址 `http://127.0.0.1:8787/v1`，模型名 `oc-default`。全局模式不需要 `UPSTREAM_API_KEY`。

## 保留首版隔离模式

需要独立进程环境与明确配置的上游 API Key 时，使用 `config.isolated.example.json`，`mode: isolated`。该模式不会读取真实 OpenCode 的登录或配置，使用显式 `protocol/baseURL/id/apiKeyEnv`。旧的未填 mode 的配置仍按隔离模式处理。它同样没有版本限制；OpenCode 如需匹配自身版本的插件 SDK，会在临时环境中自行维护依赖。

## 开发验证

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
TEST_OPENCODE_COMMAND='["/absolute/path/to/opencode"]' npm run test:integration
```

完整网关检查（仓库根目录）：

```sh
TEST_OPENCODE_COMMAND='["/absolute/path/to/opencode"]' \
  go test -tags nogui -count=1 -timeout 4m ./internal/gateway -run '^TestOpenCodeV1Bridge$'
```

测试全部使用临时 HOME 和 loopback fixture，不接触真实登录。GitHub workflow 在 Windows/Linux 上分别验证 1.16.2 和 1.18.35，构建两种平台产物；Linux 运行完整 nogui Go suite。测试其他版本时可用 `TEST_OPENCODE_PLUGIN_DIR` 指定测试安装中的真实 SDK 目录，`TEST_OPENCODE_VERSION` 用于核验版本响应头；这些变量没有运行版本白名单。
