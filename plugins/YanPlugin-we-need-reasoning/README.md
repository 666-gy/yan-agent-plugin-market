# We Need Reasoning for Yan

官方市场 ID：`YanPlugin-we-need-reasoning`。发布包目录名与 `yan-plugin.json` 的 `id` 保持一致。

把 DSH 的 [We Need Plugin 4.1.1](https://github.com/Lichadai/dsh-we-need-plugin) 移植为 Yan 原生插件。

上游是 DSH 的宿主插件，通过 `llm/stream` 适配器在请求发出前改写消息。Yan 插件没有同等的宿主 hook，所以本插件换了一层：**本地独立反向代理 daemon**。代理只在模型请求经过它时改写，未经过的流量不受影响；MCP 或 Yan 内核退出时，代理仍会继续监听。

```text
Yan 模型连接（自定义 Base URL = 本地代理）
        │  POST /v1/chat/completions | /v1/responses | /v1/messages
        ▼
127.0.0.1:8787  WeNeed proxy daemon（独立进程）
  ├─ 匹配 targetModels
  ├─ system/developer += SYSTEM_REGISTER
  ├─ 新 task 前插入 assistant seed（upstream / task / off）
  ├─ 工具步追加 TOOL_STEP_ANCHOR + seed
  ├─ 压缩请求追加 COMPACTION_REGISTER
  ├─ team 模式追加 Team 外发规则
  └─ 其他路径/模型原样透传
        │  Authorization 等请求头原样转发
        ▼
真实上游 API（upstreamBaseUrl）
```

## 包含什么

| 内容 | 作用 |
|---|---|
| `instructions.md` | 激活后的入口说明：代理状态、连接配置、注入位置、失败排查 |
| `skills/we-need/SKILL.md` | We Need 工作法：seed、工具步、压缩、委派、审计、反模式 |
| `skills/we-need/references/register.md` | 上游 4.1.1 寄存器全文与 DSH/Yan 对应表 |
| `seed.txt` | 上游 4.1.1 的 921 字符 seed 原文（1365 字节） |
| `server.cjs` | MCP 工具服务（管理独立 daemon，不持有代理端口） |
| `lib/daemon.js` | 独立常驻代理进程，MCP/内核退出后继续监听 |
| `lib/daemon-control.js` | daemon 启动、健康检查、复用、停止与状态文件；Windows 使用 WMI 脱离父作业，其他平台使用 detached |
| `lib/registers.js` | 注入、seed 组合、寄存器审计 |
| `lib/proxy.js` | 无依赖 HTTP/HTTPS 代理，支持 SSE 流式透传；内置 `/__weneed/` 配置页与本地持久化 |
| `tests/` | 注入、代理、配置页、MCP 协议、daemon 存活自测 |

## 安装与启用

1. 通过 Yan 的插件安装入口安装本包。创建包不会自动安装或启用插件。
2. 在目标会话中激活插件（Yan 的插件目录/激活入口）。激活会启动 MCP 服务；默认同时启动独立代理 daemon。MCP 或内核重启后，只要 daemon 还在，代理不会被关闭。
3. 调用 `proxy_status` 确认 `running=true`、`baseUrl` 和 `configUrl`。
4. 打开 `proxy_status.configUrl`（默认 `http://127.0.0.1:8787/__weneed/`），填写真实上游 API 根地址并保存。保存后立即生效，并写入 `~/.weneed-reasoning/config.json`，下次启动继续使用。

不要手工把包复制到 YanData 的插件目录，也不要改连接注册表；安装和启用走 Yan 自己的校验入口。

## 把模型连接指向代理

先在上面的配置页填好 `upstreamBaseUrl`，否则代理会把请求返回 502。然后由用户在 UI 完成连接设置，插件不会自动改连接：

1. 打开 Yan 的模型/连接设置，新增一个自定义连接（或复制当前连接）。
2. **Base URL** 填 `proxy_status.baseUrl`，默认 `http://127.0.0.1:8787/v1`。
3. **API 格式** 选 OpenAI（`chat/completions`）或 Responses，与上游一致；DeepSeek 一般选 OpenAI。
4. **API Key** 填上游可用的 key。代理只转发 `Authorization` / `x-api-key`，不保存、不打印。
5. **模型 id** 填实际模型，例如 `deepseek-v4.1-flash-1017`；如果拉不到 `/models` 列表，直接手填。
6. 把当前会话主模型切到该连接/模型，发一轮请求，再看 `proxy_status`。

`stats.injected` 增长表示代理改写了请求；`stats.passthrough` 增长表示模型不匹配或请求没走代理。

> 如果使用的是没有可复制 API key 的托管订阅，本地路由可能无法使用。此时改用 `we-need` 技能 + `weneed_seed` 的手动模式，不要声称代理已注入。

## 配置

### 直接配置入口（推荐）

代理运行后，在浏览器打开 `proxy_status.configUrl`（默认 `http://127.0.0.1:8787/__weneed/`）。页面可设置 `upstreamBaseUrl`、`targetModels`、`mode`、`seedMode`、`seedLanguage`，点“保存并应用”后立即生效，并写入本地文件：

- 默认路径：`~/.weneed-reasoning/config.json`
- 可用 `WENEED_CONFIG_PATH` 指定其他路径；设为空字符串可关闭持久化
- 优先级：网页/文件保存值 > 插件配置（环境变量）> 默认值

页面不读取、不保存 API Key；密钥仍由 Yan 的连接配置保存。保存接口只接受本机同源请求，跨站 `Origin` 会被拒绝。

插件配置里也可改；`proxy_start` 传入的 `upstreamBaseUrl` 和注入选项会保存到同一文件，下次启动继续生效。

| 键 | 默认 | 说明 |
|---|---|---|
| `upstreamBaseUrl` | 空 | 真实 API 根地址，如 `https://api.deepseek.com` 或 `https://api.deepseek.com/v1`。空时代理返回 502 |
| `listenPort` | `8787` | 只绑定 `127.0.0.1`；端口固定，被占用时明确报错，不再自动顺延 |
| `targetModels` | `deepseek,flash;weneed,ds41` | 分号分组；组内逗号表示模型 id 同时包含；大小写不敏感；`*` 匹配全部 |
| `mode` | `standard` | `standard` / `goal` / `team`；team 追加外发规则到委派类工具描述 |
| `seedMode` | `upstream` | `upstream` 原文 seed；`task` 现场组合；`off` 只注入系统规则 |
| `seedLanguage` | `en` | `en` / `zh` / `auto`，仅影响 task 模式 |
| `autoStart` | `true` | MCP 启动时确保 daemon 已运行；`false` 时调用 `proxy_start` |

## MCP 工具

| 工具 | 用途 |
|---|---|
| `weneed_rules` | 返回 seed、全部寄存器、当前配置与代理状态 |
| `weneed_seed` | 按任务组合 seed（目标、约束、证据、A/B、下一步） |
| `weneed_audit` | 统计情态词，检查开头、Must 覆盖和第一人称/请求者反模式 |
| `proxy_status` | 监听状态、Base URL、配置页地址、目标匹配、注入/透传计数 |
| `proxy_start` | 启动或复用独立 daemon，可改端口和上游；端口被占用会报错；传入的上游与注入选项会持久化 |
| `proxy_stop` | 停止独立 daemon 并释放端口；MCP/内核退出不会自动停止 |

## 注入细节

### chat/completions

- 在第一条 `system` / `developer` 末尾追加 `SYSTEM_REGISTER`；没有则插入一条。
- 最后一条消息是 `user` 时，在它前面插入：

```json
{ "role": "assistant", "content": "<seed>", "reasoning_content": "<seed>" }
```

- 最后一条是 `tool` 或带 `tool_calls` 的 `assistant` 时，在最近的 tool-call assistant 上追加 `TOOL_STEP_ANCHOR + seed`；优先写 `reasoning_content`，没有则写 `content`。不新增消息。
- 已包含 seed 头时跳过，避免重复。

### responses

- 追加到 `instructions`。
- `input` 为字符串时先包成 user message；最后一项是 user 时插入 assistant seed；工具输出前只锚定上一条 assistant。

### messages（Anthropic）

- `system` 追加文本块。
- 新 user task 前插入 assistant seed；含 `tool_result` 的 user 消息不插 seed，只锚定上一条 assistant，保持 `tool_use`/`tool_result` 相邻。

### 压缩

当请求没有工具定义，且程序文本同时出现压缩/摘要与对话/上下文语义时，视为压缩请求：只追加 `COMPACTION_REGISTER`，不插 seed。识别是启发式的；误判时把 `seedMode` 设为 `off` 或反馈。

### 不处理

- 非 JSON body、超过 64 MB 的 body、未知路径：原样透传。
- 模型不匹配：原样透传。
- 代理不会把请求转发到请求里出现的任意 URL，只使用配置的 `upstreamBaseUrl`。

## 验证

包内测试不依赖第三方库：

```bash
node tests/injection.test.cjs
node tests/proxy.test.cjs
node tests/config.test.cjs
node tests/mcp.test.cjs
node tests/daemon.test.cjs
```

- `injection`：chat/responses/messages 的插入位置、工具步锚、目标匹配、seed 组合、审计。
- `proxy`：本地 mock 上游，验证注入后转发、非目标模型透传、Authorization 转发、`/models` 透传、计数，以及固定端口被占用时不静默顺延。
- `config`：配置页可打开、保存后立即生效、写入文件、跨站来源拒绝、非法上游拒绝、重启恢复。
- `mcp`：真实 stdio JSON-RPC 握手、`tools/list`、`tools/call`。
- `daemon`：MCP 被 SIGKILL 后代理仍在监听，重新启动 MCP 可复用同一 daemon；启动器进程退出后 daemon 仍存活；最后安全停止。

代理与 MCP 协议可以本地自测；Yan 设置页的“连接保存 → 主模型切换 → 真实上游返回”属于 UI 与账号相关验证，安装后需按上面的步骤实测。插件不会自动完成或声称完成这一步。

## 安全

- 只监听 `127.0.0.1`，不监听 `0.0.0.0`。
- 不写日志文件；只保留请求数、注入数、透传数、最后模型/路径/错误摘要。
- `~/.weneed-reasoning/daemon.json` 保存 daemon 的 PID、端口和本地控制令牌，用于停止/复用；不包含 API key，停止时删除。
- 不保存、不返回 API key；`proxy_status` 只显示上游的协议/主机/路径，去掉 URL 里的凭据。
- 配置页与保存接口只在本机可用；保存接口校验同源 `Origin` 和 `application/json`，跨站写入返回 403。
- 持久化文件只保存上游地址与注入选项，不包含 API key。
- 代理只向上游转发，不接受客户端指定的目标 URL。
- 不要把端口暴露到公网，也不要把带 key 的请求发给不受信任的代理。

## 已知限制

- 注入是概率性引导，不是硬开关。
- 配置页只在代理运行时可打开；插件未激活且 daemon 未运行时不可用。
- daemon 能跨 MCP/内核重启存活；机器重启或 daemon 被手动结束后，需要激活插件或调用 `proxy_start` 才会重新监听。
- 从旧版进程内代理升级时，先停用旧插件实例或结束其代理进程；新版不会静默接管控不了的旧代理，会返回明确错误。
- Windows 上 daemon 通过 WMI `Win32_Process.Create` 脱离父作业；如果系统禁用了 WMI，会退回普通 detached 进程，跨内核重启的存活能力可能下降。`proxy_status` 会暴露实际运行状态。
- 配置保存到用户目录；同一台机器多个实例共用同一路径时，以最后一次保存为准。
- Yan 没有请求 hook，必须经过代理；未经过代理的请求不会被改写。
- 压缩识别是启发式，DSH 的原生 `purpose=compaction` 标记在 HTTP 层不可见。
- Responses API 只做消息级插入，不复刻 DSH 的签名/字段顺序适配。
- 官方托管订阅没有可复制 key 时，代理模式可能不可用；手动模式仍可用。

## 许可与归属

上游 DSH We Need Plugin 4.1.1 为 MIT，版权归 DSH We Need Plugin contributors。本适配保留 `seed.txt`、寄存器原文和 MIT 许可，修改部分同样以 MIT 发布。详见 `LICENSE`。

版本对应：插件 `1.0.1` ← 上游 `4.1.1`。