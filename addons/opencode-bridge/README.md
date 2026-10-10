# Magpie OpenCode bridge

0.11.0 默认使用短模型 ID。默认示例使用**全局 OpenCode**，继承它的登录、订阅认证插件和供应商配置，**不限制版本号和并发请求数**。支持 `reasoning_effort` 思考强度，也可通过 `workingDirectory` 指定工作目录。网关不要求填写上游地址或 API Key；推理与凭证刷新均由真实 OpenCode 程序完成。没有修改 OpenCode 源码或二进制。

请求方向：客户端 → Magpie → 插件 → 全局 OpenCode → 它配置的上游。也可运行独立的 OpenAI Chat HTTP 服务。

## Windows 安装

需要在 PATH 上能够运行的 OpenCode。Magpie GUI 首次加载插件时会自动下载自己的 Bun 宿主；仅独立 Node 服务需要 Node.js 22+。

先检查全局程序：

```powershell
opencode --version
opencode models
```

确认这个全局 OpenCode 自己已能使用目标账号和模型完成对话。本插件不登录或转移供应商账号，不替换全局安装，也不要求升级到指定版本。1.16.2 和 1.18.35 已纳入真实程序测试；其他版本照常尝试接入。兼容性取决于它实际提供的 HTTP API 和插件 hooks，接口缺失时会返回具体错误。

下载插件 `.tgz`，解压到例如 `C:\Magpie-OpenCode`，得到 `package` 文件夹。构建产物只包含插件和说明文件，不包含 Magpie EXE；使用已有的 Magpie。

打开已有 Magpie，在「插件 → 发现」下方选择该 `package` 文件夹并安装，再到「已安装」点击 OpenCode bridge 对应的「登录」启用桥接。无需创建 `config.json`、填写供应商地址或密钥，也无需安装插件的 npm 依赖。首次启动会从真实全局 OpenCode 自动读取模型列表。

也可在解压目录用已有 CLI 安装（`magpie` 替换为本机 CLI 的实际命令或 EXE 路径）：

```powershell
tar -xzf xshu-hub-magpie-opencode-bridge-0.11.0.tgz
magpie plugin add .\package
magpie plugin login opencode-bridge
magpie serve
```

全局模式的 `plugin login` 只是启用桥接，不弹出供应商登录，也不询问上游 API Key。也可以使用已有 Magpie 的桌面网关。插件使用现有供应商插件接口，无需替换 Magpie 本体。旧版 GUI 的本地插件冷启动可能不显示登录按钮，此时用同一 Magpie 配置下的 CLI 执行 `plugin login opencode-bridge` 初始化宿主并启用插件。

未提供 `config.json` 时默认使用全局模式并自动发现模型。文件仅用于高级覆盖，例如指定可执行文件、超时或模型别名；以下配置也是可选的：

```json
{
  "mode": "global",
  "command": ["opencode"],
  "maxConcurrent": 0,
  "timeoutMs": 0,
  "firstOutputTimeoutMs": 120000,
  "idleTimeoutMs": 180000,
  "startupTimeoutMs": 30000
}
```

`command` 使用 PATH 上的全局程序。0.8.0 跟随选中 Windows `.cmd` / `.ps1` 启动脚本中的实际安装路径，支持 `opencode-ai` 和 `@opencode/opencode-ai` 等 scoped 布局，并保留旧 npm manifest 与重命名 bin 的解析。原生 EXE 直接启动，Node 脚本使用对应安装位置或 PATH 中的 Node；解析过程不执行包装器内容，也不按 OpenCode 版本号选择程序。存在旧安装时，优先使用所选脚本真正指向的程序。动态或无法识别的自定义包装器需要明确填写可执行文件路径，或 `["node", "脚本绝对路径"]`。GUI 需要重新打开才能继承刚更新的 PATH。

模型发现前先注册本地插件 endpoint。OpenCode 启动失败时，模型 hook 报出真实发现错误，Magpie 可按自己的缓存规则保留之前列表；请求会返回该启动错误，不会再因 config hook 中断而变成 `opencode-bridge has no endpoint configured`。此类错误发生在读取 OpenCode 模型目录之前，不能通过重填上游供应商地址解决。旧版需要临时绕过包装器时，可在可选 `config.json` 中把 `command` 设置为那台机器上的真实 OpenCode EXE 绝对路径，并保持 `mode: "global"`。

运行 Magpie 的用户和环境须与全局 OpenCode 一致，才能继承 HOME、XDG 路径、环境变量和登录插件。作为另一用户的服务或在容器中运行，不会自动获得桌面用户的登录。

## 客户端连接

| 配置项 | Magpie 网关 |
| --- | --- |
| API Base URL | `http://127.0.0.1:3425/v1` |
| API Key | 默认本机模式可填 `magpie`；共享模式使用实际网关密钥 |
| 模型 | `opencode-bridge/oc-default` |

`oc-default` 使用 OpenCode 自己的默认模型选择逻辑。0.4.0 默认通过真实全局 OpenCode 的 `/provider` API 自动枚举已连接供应商的文本模型，0.11.0 默认把唯一模型列为 `opencode-bridge/model`，例如 `opencode-bridge/gpt-6.1-sol`；同名模型来自多个供应商时保留 `opencode-bridge/provider/model`，避免选错供应商。原来的长 ID 仍作为兼容入口接受，但不重复出现在模型列表。OpenCode 报告为可用的免费模型也会列出。模型列表只复制名称、选择 ID 和 token 上限，不复制凭证、上游地址、请求头或供应商 options。

`opencode-bridge/` 是 Magpie 的供应商路由前缀，插件保留它。独立服务不加此前缀，唯一模型可直接使用 `gpt-6.1-sol`。设置可选的 `modelIdStyle: "qualified"` 可以恢复原来的完整列表；默认值为 `"short"`。显式 `models` 别名保持原样、优先于自动名称。模型原有 ID 中的斜杠不会盲目截掉；如果短名会覆盖另一个模型的完整 ID，也保留完整路径。新增供应商导致短名重名时，重载后使用带供应商的 ID；需要长期固定名称可配置明确别名。

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

### 思考强度

0.10.0 起接受 `reasoning_effort` 的 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。例如：

```json
{
  "model": "opencode-bridge/DeepSeek-V4.1-Flash-line2-maas",
  "messages": [{ "role": "user", "content": "你好" }],
  "reasoning_effort": "high",
  "stream": true
}
```

模型名换成网关实际列出的完整 ID。0.9.0 及更早版本会拒绝此参数；当 Magpie 把这个拒绝描述为模型不接受 `high` 时，实际原因可能是旧桥接尚未接入该字段。

桥接在真实 OpenCode 的 `chat.params` hook 中优先应用该模型当前的同名 variant，保留其中的 thinking 预算、推理选项和嵌套设置。显式请求覆盖模型默认值以及此前 hook 的默认设置。没有同名 variant 的 `@ai-sdk/openai-compatible`、`@ai-sdk/openai` 和 `@ai-sdk/azure` 模型使用原生 `reasoningEffort` 选项，由 OpenCode 的 SDK 序列化为上游协议；其他 SDK 缺少可用同名 variant 时返回 `400 unsupported_reasoning_effort`，字段为 `reasoning_effort`，不会静默忽略，也不会猜测供应商的 thinking 预算。

未指定 `reasoning_effort` 时保留 OpenCode 原有默认选项。`none` 也是明确的请求值；关闭推理的具体语义由对应 variant、SDK 和上游负责。这里接受某个值不代表每个模型都支持它，最终可用档位和供应商限制仍由目标模型决定。

自动模型发现同步 OpenCode 的 reasoning 标记和标准强度的 variant 名称，使 Magpie 可展示模型实际提供的档位；不复制 variant 的选项、凭证或 headers。`oc-default` 未明确绑定模型时不猜测档位。显式别名启用 `discoverModels` 后可继承它所选模型的公开思考能力。更新插件后重新加载，以刷新模型目录。

## 全局模式的运行方式

每个请求启动同一全局安装中的 OpenCode 程序。默认工作目录是系统临时目录下的 `magpie-oc-<随机字符>/workspace`；模型发现使用 `magpie-oc-models-<随机字符>/workspace`。请求结束、取消或失败后清理这些临时文件。HOME、配置、登录和认证插件保留原路径，所以 token 刷新由 OpenCode 写回真实登录文件，不是复制一份快照再丢弃。桥接代码不解析或发送供应商 token。原有 `OPENCODE_CONFIG_CONTENT`（JSON/JSONC）会保留供应商、插件和选项，再叠加临时 worker 设置，使模型发现与推理使用一致的环境配置；无效内容明确报错。

0.9.0 起可在插件 `package` 目录的 `config.json` 中指定已经存在的工作目录：

```json
{
  "mode": "global",
  "workingDirectory": "D:/workspace",
  "maxConcurrent": 0
}
```

已有 `config.json` 时添加 `workingDirectory` 字段即可，保留其他配置。保存后重启 Magpie，或停用再启用插件。Windows 可使用上述正斜杠路径，也可写 `"D:\\workspace"`。相对路径以配置文件所在目录为基准；路径不展开 `%TEMP%`、`$HOME` 或 `~`。未设置时保持临时目录行为。目录必须存在，不能是文件；无效目录返回包含路径的 `503 opencode_working_directory`，不会自动创建或退回临时目录。独立服务和隔离模式也支持该字段。

指定目录同时用于真实 OpenCode 的模型发现与推理进程 cwd。会话数据库、请求文件和 hooks 确认文件放在 worker 的临时目录，清理不会删除指定目录及其现有文件。成功请求删除会话与请求文件、释放 OpenCode 实例后可复用进程；并发请求的进程、会话数据库、MCP 服务和取消信号各自独立。该设置由网关管理员控制，客户端不能通过 Chat API 选择服务器目录。

指定工作目录不启用项目级 `opencode.json` / `.opencode` 配置读取；桥接仍设置 `OPENCODE_DISABLE_PROJECT_CONFIG=1`，全局模式复用全局供应商配置和登录。它也不打开内置文件、终端或其他本地工具；客户端 function 工具仍由客户端执行。OpenCode 及已加载的全局插件自身可能对目录执行额外操作，这部分行为由它们负责。

两个模式均使用 OpenCode 的标准 AI SDK 运行时，使全局模式中供应商插件的 `auth.loader` 与 `fetch` 保持生效。既有插件会照常执行，OpenCode 本身可能维护配置目录的依赖、缓存、日志或配置格式；桥接不改写供应商配置。

内置工具和其他 MCP 服务在这个 API worker 内禁用。0.11.0 将工具权限收窄为本次请求注册的精确客户端工具名，并在工具执行前再次检查；全局插件中仅以 `bridge_` 开头的本地工具不会因此获得权限。`tool_choice: none` 不放行任何客户端工具。客户端函数以 MCP 形式注册；调用时只返回“交由客户端执行”的内部确认，不执行函数。标准 SDK 完成整批调用后发布 `step-finish`。公开的消息 hook 阻止下一轮模型推理，网关据该事件返回工具调用并取消 worker；该内部确认不会发送给客户端，也不会被用于下一次供应商推理。下一次请求重新注入完整历史和客户端的真实结果。

默认不限制并发。每个活动请求独占 OpenCode 进程、会话数据库、MCP 服务和取消信号；成功后可复用空闲进程，每次重建实例及新会话。未指定工作目录时使用 worker 临时 cwd。取消一个请求只清理它独占的 worker。`maxConcurrent` 省略或设为 `0` 均表示不限；只有显式设置正整数时才限制活动请求数，满时返回 429。升级已有配置时，把旧的 `maxConcurrent: 1` 删除或改为 `0`。

全局登录与认证插件仍由各 OpenCode worker 复用；共享登录文件的并发刷新行为由 OpenCode 及供应商认证插件决定。并发验收覆盖已存 API Key 和已刷新的 OAuth 登录，不保证每个第三方插件在同一时刻刷新凭证的行为。

## 兼容范围与差异

| 能力 | 当前行为 |
| --- | --- |
| `/v1/models`、`/v1/chat/completions` | 支持；默认列出 OpenCode 已连接供应商的文本模型及 oc-default |
| 文本、多轮角色历史、system/developer | 支持；system/developer 位于历史开头，按顺序合成系统提示 |
| assistant.reasoning_content 历史 | 接受字符串、空字符串和 null；非空思考内容作为独立 OpenCode reasoning part 回放，不混入可见正文 |
| stream=true/false | 支持 stop、length、tool_calls、content_filter 结束原因；首个模型输出前的失败返回 HTTP JSON 错误，输出后的失败发送 SSE error 后关闭；成功以 `[DONE]` 结束 |
| tools、同轮多个调用、工具结果续接 | 支持普通 function 工具与文本结果；结果按 tool_call_id 匹配 |
| temperature、top_p、max_tokens/max_completion_tokens | 通过 OpenCode 参数 hook 设置；最终接受范围由实际模型决定。超出真实输出上限时返回带具体参数名的 400 |
| reasoning_effort | 支持；显式值覆盖默认，优先使用 OpenCode 同名 variant，OpenAI 系 SDK 可使用原生选项；其他 SDK 无映射时返回 400 |
| stream_options.include_usage | 支持；计数来自 OpenCode |
| tool_choice | auto/none；none 不注册工具 |
| n | 仅 1 |
| 图片、音频、视频、嵌入、文件、JSON schema 输出 | 未实现，返回 400/404 |
| stop、seed、logprobs、penalties、logit_bias、strict=true、指定工具、parallel_tool_calls 参数 | 不支持，明确报错 |
| 原生 Responses | 独立服务未实现；Magpie 既有转换可用，但验收保证限于 Chat |

工具参数在完整解析后返回，不保留原始逐字 delta、JSON 空白或字段顺序。MCP 使用哈希工具名，外部恢复原名；schema 根级 `additionalProperties=true` 和 strict 模式被拒绝。developer 会转成 system，工具结果可能按原调用顺序归组。供应商的所有扩展字段和原始 HTTP 状态不保证透传。

Cherry Studio 2.0.14 会在历史 assistant 消息中附带 `reasoning_content: ""`，0.6.0 起可以直接继续多轮对话。非空值由 OpenCode 的原生 reasoning part 交给供应商 SDK 处理；带签名的思考历史等供应商私有结构仍不属于本桥接的兼容保证。其他不支持的消息字段会在错误中标出具体字段名与路径。

0.7.0 在首个实际文本、思考、工具调用或完成事件到达后才提交成功 SSE 响应，避免提前发送空 assistant role 把上游拒绝变成 HTTP 200。只暂存首个事件，后续内容仍逐块转发；首个输出前取消返回 499。此变化修正错误呈现，不改变供应商的访问权限。

OpenCode Zen 免费模型存在额外使用检查，模型被枚举出来不表示网关请求一定获准。2026-10-09 在同一个全局 OpenCode 1.18.0 中实测：Muse Spark 1.3 Free 通过默认 `opencode run` 成功；仅配置 `permission: { "*": "deny" }` 即返回 `OpenCode's free tier can only be used from within OpenCode`。桥接为让客户端执行 function 工具，禁用 OpenCode 内置本地工具并替换其代理提示，因此该模型目前不能按本桥接的普通 Chat API 行为使用。仅升级版本不能解决这个差异；服务端具体检查规则未公开，不保证其他免费模型行为相同。

冷请求有启动开销；0.13.0 默认复用空闲 worker。启动、首次有效输出、流空闲分阶段计时，总超时默认关闭。启动检查会确认 HTTP 事件连接，并确认消息与参数 hooks 已执行；不检查版本白名单。`x-opencode-version` 响应头记录服务器实际报告的版本，未报告时省略。历史注入与事件转换仍依赖 OpenCode 的公开实验 hooks，因此不限制版本不等于已经验证所有版本。程序若不提供这些能力，将返回接口或 hook 兼容错误。

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

测试全部使用临时 HOME 和 loopback fixture，不接触真实登录。并发测试让四个真实 OpenCode worker 在同一个指定 cwd 下的上游请求同时保持活动，验证混合流式/非流式结果隔离、独立数据库、复用登录和独立取消。目录测试覆盖带中文及空格的路径、相对配置路径、模型发现与推理的实际 cwd、错误目录、项目配置仍关闭、默认临时目录清理以及指定目录的现有文件保留。

GitHub workflow 在 Windows/Linux 上分别验证 OpenCode 1.16.2 和 1.18.35，并把已打包的插件安装到 SHA256 核验过的官方 Magpie CLI 0.1.1141 中，检查自动模型发现、普通回复、SSE、工具结果续接和四请求同目录并发。思考强度检查覆盖报告中的自定义 DeepSeek 模型名、OpenAI compatible 原生字段、默认值保留、OpenCode 嵌套 variant、原生 Anthropic thinking、无映射时推理前拒绝，以及并发不同强度互不串扰。上游为本地 fixture，这不代表已验证报告人的内网 MaaS 对各个档位的接受范围。该流程只打包一份两种平台通用的插件，不编译或交付 Magpie。官方 EXE 仅下载用于测试，保持原始字节。测试其他版本时可用 `TEST_OPENCODE_PLUGIN_DIR` 指定测试安装中的真实 SDK 目录，`TEST_OPENCODE_VERSION` 用于核验版本响应头；这些变量没有运行版本白名单。单独运行原版 Magpie 验证时，需要设置 `TEST_MAGPIE_COMMAND`（JSON 可执行文件数组）、`TEST_BRIDGE_PACKAGE`（已打包 tgz 路径）以及上述 OpenCode 变量，再运行 `npm run test:magpie`。GUI 点击安装流程没有纳入该 CLI 验收。

0.11.0 回归测试还覆盖短 ID、重名/显式别名冲突、旧长 ID 的原版 Magpie 调用、环境变量提供的供应商、前缀相同的本地工具不得执行、内容过滤结束，以及两个输出 token 字段的真实上限边界。

## 0.12.0 提示词、工具与流式检查

API worker 的消息与系统提示词分别通过公开 hooks 替换为客户端历史及 system/developer 内容；现在必须确认系统 hook 也执行成功才视为兼容。客户端自己传来的 Skills、工作区说明仍保留。测试向临时全局配置、工作目录、Skills 和插件中植入不同标记，核验它们不会混入上游请求。

全局模式仍加载 OpenCode 默认与用户插件以复用登录认证，不是“仅加载认证钩子”的隔离环境。桥接会覆盖较早运行的消息/系统提示词钩子结果，但第三方插件的初始化、事件、参数、请求头及认证 fetch 等逻辑仍可能运行；无法保证任意认证插件发出的最终请求字节完全不变。

worker 配置钩子清空额外 instructions 和 skills.paths/urls，避免为即将丢弃的规则或 Skills 下载远程内容；同时禁用 Claude Code 规则加载。OpenCode 自身仍可能扫描全局 Skills 目录，扫描不等于内容会发送给模型。这些设置只作用于临时 worker，不改用户全局文件。

未传 temperature/top_p 时保留 OpenCode 和插件默认值；显式传值覆盖对应字段。保留 OpenCode 的 topK 默认值。自动模型目录复制原生 temperature/toolcall 标记；缺少元数据时保持兼容默认值。客户端工具仍使用内部散列名，描述中增加原始客户端函数名，使提示词中的 read、skill 等名称能对应到注册工具；客户端收到的调用名不变，只有客户端执行实际工具。工具参数仍在完整解析后作为一个调用块返回，不是逐字符参数流。

流中超时保留 opencode_timeout；尚未发送 SSE 时返回 HTTP 504，已开始 SSE 时发送错误事件并关闭流。请求取消与上游错误分开呈现。Token 上限错误包含请求值、允许上限和实际字段名。原版 Magpie 仍可能包装错误字段；HTTP 499 仍表示客户端请求取消，不能据此确定等待慢的根因。

分块测试让上游在输出思考、中文、Emoji 和代码块开头后暂停，确认客户端此时已收到内容，再逐块输出 40 行代码；检查无丢失、无重复、唯一结束标记、usage，以及原有取消清理和并发工具续接。上述 0.12.0 验证采用 120 秒总超时与单次进程；0.13.0 的时限与复用行为见下文。

工具 schema 还有一项原生差异：已测试的 OpenCode MCP 转换会把参数根对象的 additionalProperties 强制设为 false，即使客户端省略它或传 true；嵌套字段的设置保留。因此依赖任意顶层参数名的函数不能认为与原生 OpenAI 等价。当前 MCP 路径没有可用的公开 schema 覆盖钩子；桥接未修改 OpenCode 来绕过这个限制。

## 0.13.0 分阶段时限、诊断和进程复用

- startupTimeoutMs 默认 30000：worker 准备、接口与 MCP/事件连接阶段。模型目录发现也有自身启动时限。
- firstOutputTimeoutMs 默认 120000：提交推理后等待第一个模型内容/工具事件。不是等待第一条 HTTP 心跳。
- idleTimeoutMs 默认 180000：收到模型内容后，连续没有新的文本、思考或工具状态进展的上限。OpenCode/上游心跳不会刷新它。
- timeoutMs 默认 0：关闭总时长上限；显式正数仍生效。旧 config.json 保留 120000 就仍有两分钟总上限，升级时需删除该字段或设 0。

workerReuse 默认 true；池中没有可用 worker 时立即新建，不排队、不增加并发上限。maxIdleWorkers 默认 2 只限制保留的空闲进程数，workerIdleMs 默认 60000 到期销毁进程及临时目录。workerReuse:false 恢复单次进程。并发请求永远不共用活动进程。

成功后先取消原会话、删除会话，再调用 OpenCode 公开 /instance/dispose 接口释放插件/配置/MCP 实例状态；清除请求与 hook 文件后保留服务进程。下一次写入新请求、替换工具目录、重新初始化插件和精确工具权限，创建新会话。复用按供应商模型、工作目录、命令及进程环境分组；隔离模式还区分凭证。取消、超时、请求失败、重置失败的 worker 不复用。无重置接口的运行时退回销毁进程，不按版本名单拒绝。

数据库文件在进程空闲期间可能保留，即使旧会话已删除；不承诺 SQLite 空闲页立即物理擦除。进程到期或正常关闭时移除临时目录，强制杀死宿主可能留下临时文件。全局凭证依然由 OpenCode 自己维护。全局配置/认证插件变化后重启 Magpie；状态复杂的第三方插件可以关闭复用。

可选 warmupModels 数组指定启动时预热的模型 ID（插件列表中的名称，不带 Magpie 的 opencode-bridge/ 前缀）。默认 []，通常首个请求启动、后续自动复用。例如 warmupModels:["gpt-6.1-sol"]。预热只启动服务并连接 MCP，绝不创建推理，不消耗模型调用；最多预热 maxIdleWorkers 个模型，忙时跳过。预热仅用于全局模式，显式并发限额开启时不抢占活动配额。

diagnostics 默认 true，每个请求结束后输出一条 [opencode-bridge] JSON，包含 requestId、阶段进入时间（相对 worker 准备开始的毫秒）、目录发现耗时、总耗时、firstModelEvent、firstClientChunk（流式）、completion、workerReused/workerRetained、timeoutKind 和稳定错误码。不会写入消息、工具参数、密钥、供应商响应或环境变量。false 可关闭默认日志；开发调用可用 onDiagnostics 接收脱敏对象。独立服务/插件响应带 x-opencode-request-id 和 Server-Timing，外层 Magpie 是否转发自定义头由其协议层决定；Chat completion id 也包含该请求 ID。已开始 SSE 的错误仍通过错误事件返回。

真实工具参数逐字符流式仍不可用：已审查的 OpenCode 处理器接收 tool-input-delta 后没有把片段发布到会话事件。当前公开插件 hooks 不提供该原始响应流；认证 fetch 包装会涉及供应商和认证插件兼容性，未作为通用方案替换。此次没有修改 OpenCode、伪造参数增量、把断流包装成正常结束或在已输出后重放推理。
