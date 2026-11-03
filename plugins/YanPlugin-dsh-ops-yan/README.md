# dsh-ops for Yan — 只读 PoC

把 [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)（MIT）的 Rust worker 接到 Yan，作为本地 MCP 服务器提供 9 个只读文件/文档工具。

这不是原插件的完整移植。原插件是 DSH 宿主插件（`dsh-plugin` 0.15 host facet），依赖 `@deepseek-ai/dsh-*` 的工具注册表、prompt section、React 设置页和 TUI 面板；Yan 插件协议只支持 instructions / skills / resources / configuration / environment / platforms / requiredCommands / mcpServers，没有这些扩展点。因此这里只移植了**可自包含的工具核心**。

## 结构

```
yan-plugin.json            插件清单（schemaVersion 1，0.1.3）
instructions.md            注入给模型的使用说明
skills/ops-files/SKILL.md  工具选择、参数上限与结果解读
server.cjs                 MCP stdio 服务器（零依赖，JSON-RPC 2.0）
bin/win32-x64/             dsh-ops-worker.exe 0.4.4 + 来源记录
tests/                     协议自测与严格测评（fixtures 为 DOCX/PDF/GBK 样张）
docs/                      验证、发布与上架说明
LICENSE / NOTICE           MIT 许可与上游归属
```

## 运行环境

- Windows x64（只打包了 `win32-x64` 二进制；arm64 会被判就绪但无法启动 worker）
- Yan 自带 Node（`$node` + `ELECTRON_RUN_AS_NODE`），无 npm 依赖，不需要 `npm install`

## 安装与激活

1. Yan 设置 → 插件 → 从本地目录安装，选本目录。
2. 在插件列表里启用 `dsh-ops for Yan`。
3. **在有工作区的任务里**激活：`${workspace}` 由宿主注入，Blank 任务没有工作区目录，插件网关起不来（表现是「插件服务未连接」，不是工具调用被拒）。
4. 激活后工具名会被 Yan 改写为哈希（`t_…` 加宿主前缀）。按工具描述前缀 `[dsh-ops for Yan / ops / <原工具名>]` 识别，不要按字面名调用。

## 手动运行

```powershell
$env:OPS_WORKSPACE = "C:\path\to\workspace"
node .\server.cjs
```

然后向 stdin 逐行发送 JSON-RPC。

环境变量：

| 变量 | 用途 |
|---|---|
| `OPS_WORKSPACE` | 工作区根，宿主注入 `${workspace}`；也是路径边界 |
| `OPS_WORKER` | 覆盖 worker 路径（其他平台需自编译） |
| `OPS_TIMEOUT_MS` | 单次 worker 调用超时，默认 55000，上限 119000 |
| `OPS_OUTPUT_BUDGET_BYTES` | 单次响应预算，默认 1000000 |

超时时长要小于清单里的 `timeoutMs`（60000）：Yan 侧请求超时会销毁整条插件连接，必须让 worker 先超时并返回结构化错误。

## 工具

`stat` · `grep` · `glob` · `read_files` · `read_table` · `read_docx` · `read_pdf` · `diff` · `inspect_local_file`

参数为 **camelCase**（与 Rust 侧 `rename_all = "camelCase"` 一致）；worker 外层请求字段为 **snake_case**（`read_only`），适配层已处理。未知字段会被 worker 拒绝。

上限（schema 已编码，越界在校验阶段就被拒）：

| 工具 | offset | limit |
|---|---|---|
| `grep` / `glob` | ≥ 0 | 1–10000 |
| `read_files`（每文件） | ≥ 1 | 1–10000；文件数 1–32 |
| `read_table` | 1–100000 行 | 1–1000 行 |
| `read_docx` | 1–100000 段 | 1–1000 段 |
| `read_pdf` | 1–32 页 | 1–32 页 |
| `diff` | ≥ 0 | 1–1000 块 |
| `inspect_local_file` | ≥ 1 | 1–10000 行/16 字节行 |

worker 自己也会把单次响应压到约 96 KB（实测 97,992 字节时 `truncated: true`）；`server.cjs` 另加 1 MB 兜底，超出时整体替换为 `{ truncated, truncatedBy, originalBytes, preview }`。

编码：`read_table` 只支持 `utf-8`、`utf-16le`、`utf-16be`，`inspect_local_file` 只支持 UTF-8。传其他 `encoding` 值会在启动 worker 前被拒；如果用 `utf-8` 解析 GBK 文件，worker 会返回 `ERR_INVALID_ENCODING`（`status=partial`，现在会标成 `isError`）。

路径：工作区根可以是 junction/符号链接（Yan 的工作区路径可能就是链接）。服务端先把目标规范化到真实路径再比较边界，交给 worker 的也是真实路径——worker 本身拒绝穿越 reparse point，不规范化会全部失败。

## 已验证（2026-11-03，本机）

用真实 MCP JSON-RPC 客户端驱动 `server.cjs`，工作区为本仓库：

| 调用 | 结果 |
|---|---|
| `initialize` / `tools/list` | `serverInfo=dsh-ops 0.1.3`，9 个工具 |
| `stat {path:"dsh-ops-yan/README.md"}` | `status=completed`，bytes/lineCount 正确 |
| `stat` 指向工作区外 | 拒绝：`path is outside the workspace` |
| `stat` 用 `../` 越界 | 拒绝：`path is outside the workspace` |
| `read_files` 读工作区外文件 | 拒绝：`path is outside the workspace` |
| 工作区根自身是 junction | 正常读取（使用规范化后的真实路径） |
| 工作区内 junction 指向外部 | 拒绝：`path is outside the workspace` |
| `read_pdf {limit:40}` | `INVALID_ARGUMENT`（1–32 页） |
| `read_files {limit:20000}` / 60 个文件 | schema 层拒绝（1–10000 / 1–32 个文件） |
| `read_table {encoding:"gb18030"}` | 调用前拒绝：仅支持 utf-8 / utf-16le / utf-16be |
| 非 UTF-8 的 CSV（GBK） | `status=partial` + `ERR_INVALID_ENCODING`，`isError=true` |
| `read_files` 部分文件不存在 | `status=partial`、`failed=1`、`isError=true` |
| `OPS_OUTPUT_BUDGET_BYTES=10000` 的批量读 | 返回 `truncatedBy=output-budget:10000` 的预算提示 |
| 无 `OPS_WORKSPACE` | 工具调用报 `OPS_WORKSPACE is not set` |

## 未移植（需要 Yan 内核扩展，插件协议做不到）

- 替换内置 `read`/`glob`/`grep`（Yan 会把插件工具改成哈希名，无法接管）
- 写工具（`write_file` / `edit_file` / `replace` / `copy` / `move` / `remove`）——本 PoC 为安全起见不暴露
- PTC 类型化 SDK（`load_sdk` / `discover_tools` / `batch`）
- DSH 设置页、TUI 侧栏、profile 安装/卸载 CLI、Windows bash 载荷

内置的 `read`/`grep`/`glob` 仍然可用；本插件的增量是 `stat`、`read_files`、`read_table`、`read_docx`、`read_pdf`、`diff`、`inspect_local_file`。`grep`/`glob` 保留是为了在同一套有界分页与列元数据语义下工作，不是替代内置实现。

## 开发与验证

- `node tests/smoke.mjs`：协议与边界自测（14 项）。
- `node tests/bench.mjs`：正确性与分位数延迟测评（17 项，含 DOCX/PDF/CSV/越界），CI 在 `windows-latest` 跑 Node 22/24。
- `docs/VALIDATION.md`：环境、命令、逐项结果与未覆盖项。
- `docs/RELEASE.md`：仿上游 `dsh-plugin.json` 的发布信息（能力面、权限、平台、市场文案）。
- `docs/PUBLISHING.md`：宿主验收清单与官方市场上架要求。
- `node scripts/market-entry.mjs --repository <owner>/YanPlugin-... --revision <40位SHA>`：生成市场条目；缺参数时会列出不合规项（如 id 前缀）。

注意：`tests/`、`scripts/`、`.github/` 也会计入插件包 digest 和市场文件清单，改动它们需要重新生成条目。

## 许可证

本移植包以 MIT 分发，见 [LICENSE](LICENSE)；上游 dsh-ops 亦为 MIT，worker 二进制来源、版本与哈希见 [NOTICE](NOTICE)。

## 上游版本

- worker 二进制：`dsh-ops@0.4.4`（npm 发布包，`runtime/win32-x64`），sha256 `607e97c2…3f0f`
- 源码审阅：仓库 `0.5.0-alpha3`（协议字段与工具参数按此核对）
- 许可证：MIT，见上游 `LICENSE`；未包含任何 GPL 的 bash 载荷
