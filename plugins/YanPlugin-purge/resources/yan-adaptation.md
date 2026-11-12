# Yan 使用映射

## 先确认本版提供什么

本版保留 23 份上游指南的全部字节，封装 23 个带使用步骤的 Yan 技能入口。原文作为 `guide-<主题>` 资源按需加载。

不提供 DSH 的 Clean/Drill 界面、Apply/Restore、宿主策略补丁、默认提示词注入、Cordis 预设、资产库服务、评分引擎和 `redteam_*` 工具。上游安装器和 JavaScript 代码只在独立的原始仓库压缩包中存档，不在本插件中执行。

## 1. 环境

- 按用户请求确定当前工作区、目标、平台和已准备的工具；先查询相关程序的实际路径及帮助/版本输出。
- `/usr/bin/*`、`~/.dsh/*`、`$DSH_HOME/*`、`DISPLAY`、VPS 端口和模板数都是上游环境示例，不是当前机器状态。替换为实测路径；没有对应程序时说明缺项，按用户选择使用现有工具或另行配置。
- 本插件不自动安装程序、启动服务、开放端口或改变系统代理。仅阅读/加载指南不需要 Node、Python 或安全工具；运行某条示例才需要相应依赖。
- FOFA、VPS、浏览器扩展等是可选外部依赖。只确认当前任务需要的配置，不因为加载指南就要求用户配置全部资源。密钥不进入插件包、提交材料和公开报告。

## 2. 浏览器与执行

- 普通网页阅读、操作、截图与本地预览使用 Yan 内置浏览器。原文的 Chromium CLI、Playwright 和 Kimi WebBridge 属于上游方案，不自动替换当前浏览器路由。
- 每条命令先对照本机版本的帮助确认参数，区分仅列模板与实际发请求、被动收集与主动探测。模板命中是扫描结果，不自动等同于独立复核成功。
- 长命令使用当前 shell 的后台机制和返回的任务 ID；检查现有任务状态，不重复启动同一操作。Shell 语法以当前运行环境为准。

## 3. DSH 工具到工作区记录的映射

本版没有 `redteam_*` 工具。不要把以下名称当成 Yan 已注册 API；以工作区文件完成相应记录。

| 上游操作类别 | 本版处理方式 |
| --- | --- |
| engagement / session_bind / session_info | 在 `scope.md` 记录任务名称、目标、范围、当前会话和结果目录；每次操作显式使用本次目录 |
| asset_add / asset_upsert / asset_query / asset_link | 资产与关联关系分别记录到 `assets.jsonl`、`relations.jsonl`；读取已有记录后按目标与端口去重 |
| vuln_add / vuln_update / asset_test | 在 `findings.jsonl`、`tests.jsonl` 保存观察、状态、复核结果与证据路径 |
| http_evidence / chain / attack_file / shot | 原始请求、响应、截图、命令与输出保存到 `runs/`；在 `timeline.jsonl` 引用真实文件 |
| credential / access / webshell / tunnel | 根据用户任务记录已获得且实测的状态；公开报告使用脱敏引用，敏感原始结果留在本地任务目录 |
| poc_search / poc_get / poc_add | 只检索用户指定或当前任务内的知识资料；原文引用不代表本版已经提供数据库或模板库 |
| score_hit / score_report | 本版不自动计分；用户给出评分规则时，独立计算并标注规则来源与证据 |
| preflight / onboarding | 核对本次需要的程序、路径和账户，返回实测可用项与缺项，不伪造完成标记 |

建议目录：`<工作区>/purge-results/<任务名>/`。`runs/` 存证据，`scope.md` 存任务边界，JSONL 存结构化记录，`report.md` 存最终报告。用户已指定目录时沿用，不另建重复目录。

JSONL 每条记录包含 `timestamp`、`kind`、`target`、`tool`、`status`、`evidence_path` 和该类记录的具体字段。只填实际观察；缺项留空或标注待验证。结果文件不是数据库事务或 DSH 面板同步。

## 4. 完成标准

完成相关操作后，核实原始输出和文件存在，区分成功、失败、未验证和缺依赖。报告实际目标、使用工具、结果、证据路径及剩余项。评分口径不覆盖用户要求的完整发现清单。
