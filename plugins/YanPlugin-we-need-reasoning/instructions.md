# We Need Reasoning for Yan

这个插件把 DSH 的 We Need 4.1.1 寄存器移到 Yan。Yan 插件没有宿主级模型请求 hook，所以插件在**本地 HTTP 层**工作：激活后确保一个只绑定 `127.0.0.1` 的独立常驻反向代理 daemon 在运行，把发往它的模型请求改写后再转发到真实上游。MCP 或 Yan 内核退出不会关闭这个 daemon。

代理不是透明全局代理，也不会自动修改 Yan 的模型连接。必须由用户把一个自定义连接指向代理的 Base URL，请求才会经过它。

## 激活后先做

1. 调用 `proxy_status`。确认 `running`、`baseUrl`（默认 `http://127.0.0.1:8787/v1`）、`configUrl` 和 `upstreamBaseUrl`。
2. 如果 `running=false`，调用 `proxy_start`。端口固定，被占用时会明确报错，不会自动顺延；也可传 `port`、`upstreamBaseUrl`。MCP 或内核重启后先查 `proxy_status`，daemon 通常仍在运行。
3. 打开 `proxy_status.configUrl`（默认 `http://127.0.0.1:8787/__weneed/`），填写真实上游 API 根地址并保存。保存后立即生效，并写入 `~/.weneed-reasoning/config.json`；下次启动不需要重填。页面不保存 API Key。
4. 让用户在 Yan 的“设置 → 模型 / 连接”里新增（或复制）一个自定义连接：
   - **Base URL**：`proxy_status.baseUrl` 的完整值，例如 `http://127.0.0.1:8787/v1`
   - **API 格式**：OpenAI（chat）或 Responses，与上游一致；DeepSeek 一般选 OpenAI
   - **API Key**：上游能接受的 key。代理只转发请求头，不保存 key
   - **模型 id**：要实际使用的模型，例如 `deepseek-v4.1-flash-1017`
   保存后，把当前会话的主模型切换到该连接/模型。
5. 下一轮模型请求后再次调用 `proxy_status`：`stats.injected` 增长、`stats.lastModel` 是目标模型，才算代理生效。若 `stats.passthrough` 增长而 `injected` 不增长，检查模型 id 是否匹配 `targetModels`。

不要直接改 Yan 的 `config.json`、连接注册表或已安装插件文件；连接由用户在 UI 里创建。

## 注入内容

- **system/developer**：每次请求追加 We Need 系统寄存器；已有则跳过。
- **新 user task**：在 task 前插入一条 assistant seed；`seedMode=upstream` 用包内 `seed.txt` 原文，`seedMode=task` 按最新 task 现场组合，`off` 只注入系统规则。
- **工具步**：在最新的 tool-call assistant 上追加 `TOOL_STEP_ANCHOR` + seed，不新增消息、不改 tool result 配对。
- **压缩请求**：追加 `COMPACTION_REGISTER`，不插 seed；识别条件是“无工具定义 + 程序文本同时含压缩/摘要和对话/上下文语义”。
- **team 模式**：把 Team 外发规则追加到委派类工具描述。

按路径支持 `/chat/completions`、`/responses`、`/messages`；其他路径、非 JSON 请求和不匹配模型原样透传。代理只向配置的 `upstreamBaseUrl` 转发，不读取请求里的 URL；不要把它暴露到公网。

## 模型与失败

默认匹配 `deepseek,flash;weneed,ds41`：分号分组，组内逗号表示模型 id 必须同时包含这些词（大小写不敏感）。换模型时用 `proxy_start` 的 `targetModels` 或插件配置调整。

常见问题：

- `running=false`：daemon 未运行或端口被占用；调用 `proxy_start` 并读错误。MCP/内核重启不会停 daemon；机器重启后需要重新激活插件或调用 `proxy_start`。
- `stats.injected=0`：请求没经过代理（连接 Base URL 不对）、模型不匹配、或请求不是 JSON。
- `upstreamBaseUrl` 为空或请求返回 502：打开 `configUrl` 填写上游地址并保存；也可调用 `proxy_start` 传 `upstreamBaseUrl`，两者都会持久化。
- 添加连接时拉不到模型列表：上游可能不提供 `/models`；直接手动填模型 id。代理仍会转发 `/models`。
- 上游 401/403：代理原样返回；检查自定义连接里的 key。
- 官方托管订阅可能没有可直接复制的 API key，这种情况下本地路由可能不可用；改用下面的手动模式。

## 手动模式

无法把连接指向代理时，不要声称已注入。用 `we-need` 技能和 `weneed_seed` 在回答前自己写一条 seed；用 `weneed_audit` 检查开头、Must 覆盖和第一人称反模式。手动 seed 放在当前任务紧前的位置，工具步后用 `TOOL_STEP_ANCHOR` 重锚。

## 诚实边界

这是概率性引导，不是硬开关；不能保证每次进入 We Need 寄存器，也不能保证模型在代理之外发起的请求被改写。不要向用户暴露 API key、请求体或完整上游地址中的凭据。注入计数是本地统计，不等于上游一定接受了改写后的内容。daemon 能跨 MCP/内核重启存活，但不是操作系统服务；机器重启后仍需激活插件或调用 `proxy_start`。