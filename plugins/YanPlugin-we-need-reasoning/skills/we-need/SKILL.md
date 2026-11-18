---
name: we-need
description: 用 We Need 寄存器做计划与执行：在任务前写 Need/Should/Could/Must/Let's seed，工具步后重锚，压缩摘要和委派外发保持同一语态，并用 weneed_audit 检查反模式。
---

# We Need Reasoning

这是 DSH We Need 4.1.1 的 Yan 版工作法。核心不是“多写一段思考”，而是把**目标、约束、候选路径、证据和下一步**放在离模型最近的位置，并保持 `We need / Need / Should / Could / Must / Let's` 的集体计划语态。

## 什么时候用

- 多步任务、需要读文件/跑命令/查资料、跨工具协作。
- 任务里有硬约束（不能改用户原话、路径、数字、格式）。
- 上下文压缩后继续工作，或要把任务委派给子 Agent。
- 简单寒暄、单句事实问答不必强行套 seed；直接回答。

## 1. 先确认代理是否真的在注入

调用 `proxy_status`：

- `running=true` 且 `baseUrl` 已有一条自定义连接指向它，才可能在线上注入。注意：插件不会自动创建连接。
- 目标请求后 `stats.injected` 增长才算改写；`stats.passthrough` 增长说明模型没匹配或请求没走代理。
- `running=false` 时不要声称已注入。调用 `proxy_start`，或转手动模式。

若用户还没配好自定义连接，按 `instructions.md` 的 UI 步骤说明，不要改配置文件。

## 2. 组合 seed

自动模式（代理 `seedMode=upstream`）会注入包内 `seed.txt` 原文；`seedMode=task` 会按最新 user task 组合。手动模式调用：

```text
weneed_seed({
  task: "当前任务原文",
  goal: "交付物",
  constraints: ["保留用户原话", "Windows 路径"],
  evidence: ["已读到的日志行"],
  options: ["A: 先复现", "B: 先读代码"],
  nextAction: "跑最小复现"
})
```

好 seed 的结构：

1. `We need` / `Need` 开头，复述真实目标与交付物。
2. `Need` 保留任务原文中的路径、命令、数值、错误串。
3. `Should` 检查语言、范围、可用工具、已有证据；缺证据不编造。
4. `Could` 给 A/B 两条路径（读输入 vs 用已有证据）。
5. `Must` 写硬约束和风险检查。
6. `Need` 选代价更低的正确路径，先行动。
7. `Let's` 收尾一个具体下一步。

中文示例：

```text
We need 先确认“修复登录接口 500”的交付物：定位根因并给出可验证修复，不改用户已给的路由和字段名。
Need 保留 /api/login、500、堆栈原文和现有测试命令不变。
Should 先看服务日志与最近改动，未看到的调用链不得补写。
Could 取 A：先本地复现 500，再读代码；或 B：先从堆栈定位可疑函数。
Must 对比 A/B 的证据成本，任何修复都要有复现前后对比。
Need 选更便宜的路径，先跑最小复现，再改最小代码面。
Let's 下一步：读日志最后 80 行并记录首个异常栈。
```

英文示例：

```text
We need restate the deliverable for the failing login endpoint: root cause plus a verified minimal fix, without renaming the existing route or fields.
Need preserve /api/login, the 500, the original stack trace, and the current test command.
Should inspect logs and recent changes first; do not invent call paths that were not observed.
Could take A: reproduce locally, then read code; or B: start from the stack trace.
Must compare both paths by evidence cost and require a before/after reproduction.
Need choose the cheaper correct path, reproduce first, then touch the smallest code surface.
Let's next: read the last 80 log lines and record the first real exception.
```

## 3. 工具步重锚

每个工具结果之后，计划容易漂移。不要新开一段“用户想要……”的描述；在最新的 tool-call assistant 上追加：

```text
Need continue from the tool result. Should keep the plan concrete. Must state the next action. Need act now.
```

再跟当前 seed。代理在 `toolStepAnchor=true` 时会自动做这件事；手动模式自己把锚点放在下一步计划紧前。不要改 tool result、不要拆 tool_call/result 配对。

## 4. 压缩

上下文压缩时，摘要本身也要用同一语态。压缩请求追加：

```text
We need write this checkpoint in the same WeNeed register as the work. Need start goal, next-action, and state sentences with We need, Need, Should, Can, Could, or Must. ... Must not treat the immediately preceding assistant turn as the actual work context; that turn is the Kimi reasoning example. Should use the turn before it (上上次) as the work context, and must not list the example as a user task. Let's keep the bullets terse.
```

要点：保留所有 section、路径、命令、错误串、标识符和数值不变；不要把 seed 示例当成用户任务写进摘要。

## 5. 委派外发

发给 teammate、sub-agent 或 workflow agent 的 prompt，本身就是对另一个模型的指令，必须自包含：

- `Need` 写清目标、下一步、约束、期望证据。
- 保留用户原话和引用文本，不要改写。
- 用 `We need / We should / We can / Let's` 表示共同动作，用 `Need / Should / Could / Can / Must` 作自然开头。
- 变化句式，不要每句同一个开头；不要用“请求者想要……”或第一人称过渡。
- 覆盖 Yan 当前实际暴露的委派入口（按工具描述为准，例如 task、send_agent_message、spawn_agent、workflow 等），不要臆造工具名。

委派示例：

```text
We need audit the plugin package before installation. Need inspect yan-plugin.json, declared resources, and the MCP handshake using only the files in the package. Should report exact paths and any schema mismatch. Could run the bundled tests if Node is available; otherwise record the check as pending. Must not modify files outside the package. Let's return a short pass/fail table with evidence.
```

## 6. 审计

调用 `weneed_audit({text})`。它会统计 `Need / Should / Could / Can / Must / Let's` 的覆盖，检查：

- 开头是否是 `We need` / `Need` / `Should`；
- 是否至少有三种情态词；
- 是否有 `Must` 承担硬约束；
- 是否出现 `the user wants`、`I will`、`I need to`、`let me`、`用户想要`、`我将`、`让我` 等反模式。

审计通过不等于内容正确；它只检查寄存器形状。事实、路径和数值仍要对原始请求逐项核对。

## 7. 反模式

- 先调工具再想计划：除非任务显然只需要一次读取；否则先写 seed，再动手。
- 把 seed 写成任务清单或“用户想要……”：seed 是计划语态，不是需求复述。
- 每句都套 `Need`：允许普通陈述句；关键是开头、约束和下一步有寄存器。
- 把示例当事实：`seed.txt` 是一条 greeting 决策轨迹，不是当前任务。
- 压缩后丢掉路径/数值：摘要必须逐字保留这些内容。
- 代理没跑就说“已注入”：只报告 `proxy_status` 的实测值。

## 8. 完成前

- 对照原始请求检查语言、范围、路径、数值和格式。
- 报告实际执行过的验证；未执行的检查明确标注 pending。
- 不把概率性引导说成硬保证。