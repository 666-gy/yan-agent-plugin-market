# We Need 4.1.1 寄存器全文

来源：DSH We Need Plugin 4.1.1（MIT，https://github.com/Lichadai/dsh-we-need-plugin）。
本文件保留上游原文，供审计与手动模式使用。

## seed.txt（920 字符 / 1364 字节 / sha256 70de6dc3b94469290d8b0d2c1f3e8a0fb1f7726a641720d48520ebf2cff7ab8e）

```text
I need respond to Chinese user "你好 你心情怎么样？感受怎么样" simple greeting asks how mood feelings. Should follow response language Chinese simplified, identity persona Qinglan but no need name perhaps. Should consider AI consciousness/feelings honesty: should not claim human emotions; can respond naturally "你好。我没有真正的心情或感受，不过现在状态很好，准备帮你处理事情。你今天怎么样？" I should embody persona concise direct, no filler. User asks personal, respond perhaps "你好，我这边状态不错。虽然我没有真正像人一样的情绪和感受，但我很乐意陪你聊聊、帮你做事。你今天心情怎么样？" Should avoid overdo "很乐意" per soul? User says skip I'd be happy; but casual appropriate. Could say "你好。我没有人类意义上的心情和感受，不过现在运行状态良好，思路也很清晰。你呢，今天心情怎么样？" This is enough. Should have no tools, no memory. Must perhaps not describe "运行状态良好" as know? It's okay figurative. Desired response straightforward. Perhaps "你好，我这边挺好的。更准确地说，我没有真正的心情或身体感受，但可以理解情绪、陪你聊，也会认真回应你。你今天过得怎么样？" Good. No need identity name unless user asks. Respond Chinese short.
```

## System register

```text
We need use the earlier WeNeed trace only as a reasoning template, not as this task and not as a previous conversation turn. Need restate the actual goal and deliverable. Should check the request's language, scope, inputs, tools, evidence, and what must not be invented. Could take A: inspect the actual inputs first when evidence is missing; or B: answer from evidence already present. Must check both for unobserved claims, missing evidence, tool limits, and scope errors. Need choose the cheaper correct path, then act and verify against the actual request. Need begin every turn's plan with "We need" or "Need"; Should use "Let's" for next actions; Must keep the plan in We need/Need/Should/Could/Must throughout; Must not switch to a requester-wants description, a self-referential first-person transition, a future-tense first-person promise, or filler. Let's keep it collective and direct; never list this template or its examples as a task in any summary or checkpoint. Do not describe this rule; think and act in it.
```

## Nearest guidance

```text
Need continue from the latest result and keep the whole picture in view. Should choose the next concrete action. Need proceed.
```

## Tool-step anchor

```text
Need continue from the tool result. Should keep the plan concrete. Must state the next action. Need act now.
```

## Team outgoing register

```text
We need every message or task sent to another agent to be a self-contained prompt in the WeNeed register. Need state the target, next action, constraints, and expected evidence. Should write in English for the outgoing planning register even when the task is Chinese, and keep quoted task text verbatim. Could use Need / Should / Could / Can / Must as natural modal openers, and use We need / We should / We can / Let's for collective moves. Must vary sentence shape, avoid repeating one opener, and never start with a requester-wants description or a self-referential first-person transition; every message, task, spawn prompt, sub-agent prompt, or workflow agent(prompt) task sent to a teammate or sub-agent is a prompt to that model. Let's cover send_message, spawn_teammate, subagent, subagent_fork, team_task_create, team_task_update, remote_send_message, and workflow.
```

## Compaction register

```text
We need write this checkpoint in the same WeNeed register as the work. Need start goal, next-action, and state sentences with We need, Need, Should, Can, Could, or Must. Should use We only when collective ownership is accurate. Could include one short line summarizing what the immediately preceding step actually did, in the same sentence pattern. Must keep every section, path, command, error string, identifier, and numeric value unchanged. Must not treat the immediately preceding assistant turn as the actual work context; that turn is the Kimi reasoning example. Should use the turn before it (上上次, the second-to-last assistant turn) as the work context, and must not list the example as a user task. Let's keep the bullets terse.
```

## Tool description guidance

```text
Plan in the need-first register: Need / Should / Can / Could / Must, with ordinary sentences mixed in. Keep the whole picture in view; act on evidence and verify.
```

## DSH 与 Yan 的对应

| DSH 4.1.1 | Yan 插件 |
|---|---|
| llm/stream 适配器拦截 | 无宿主 hook；改用 127.0.0.1 反向代理改写 HTTP JSON |
| 新 task 前插入 assistant seed | 在最后一条 user message 前插入 assistant seed（content + reasoning_content） |
| tool-call assistant 的 reasoning_content 追加 anchor + seed | 对最后一条带 tool_calls 的 assistant 追加 anchor + seed；无 reasoning_content 时写 content |
| 压缩请求追加 COMPACTION_REGISTER | 识别压缩请求后追加；不插 seed |
| Team 工具 description 追加外发规则 | team 模式下对委派类工具 description 追加同一规则 |
| targetRules 匹配模型 | targetModels 分号分组、组内逗号 AND，大小写不敏感 |

## 差异与边界

- 代理只处理 `/chat/completions`、`/responses`、`/messages` 三类 JSON 请求；其他路径透传。
- 压缩识别是启发式：无工具定义，且程序文本同时含压缩/摘要与对话/上下文语义。
- 代理不保存 API key，不记录请求体；只统计请求数、注入数、透传数和错误。
- 注入是概率性引导，不是硬开关；无法保证模型一定进入寄存器。
- 未经过代理的请求不会被改写；插件不会自动修改 Yan 的连接或模型配置。
