# 发布信息

结构参考上游 `dsh-ops` 的 `dsh-plugin.json`（facets / requires / permissions / contributes）与 README 的发布章节，字段语义按 Yan 插件协议重新映射。

## 标识

| 字段 | 值 |
|---|---|
| id | `YanPlugin-dsh-ops-yan` |
| name | dsh-ops for Yan |
| version | 0.1.3 |
| license | MIT |
| 上游 | `T-Auto/dsh-ops` 0.4.4（Rust worker） |
| 作者 | port of T-Auto/dsh-ops |

## 一句话简介

- 中文：把 dsh-ops 的 Rust worker 接到 Yan，用 9 个只读工具做有界文件与文档读取，减少上下文消耗。
- English: Bounded, read-only file and document reads for Yan, backed by the original dsh-ops Rust worker.

## 能力面（对应 x-tool-namespaces）

| 字段 | 值 |
|---|---|
| serverName | `ops` |
| transport | local stdio（`$node ${pluginRoot}/server.cjs`） |
| source | dsh-ops native Rust worker 0.4.4 |
| publicPrefix | 无固定前缀；Yan 会把工具名改写为 `t_<hash>`，并按描述前缀 `[dsh-ops for Yan / ops / <原工具名>]` 暴露 |

工具：`stat`、`grep`、`glob`、`read_files`、`read_table`、`read_docx`、`read_pdf`、`diff`、`inspect_local_file`。

全部只读；不提供 `write_file` / `edit_file` / `replace` / `copy` / `move` / `remove`，写入走 Yan 内置工具。

## 权限与数据边界（对应 permissions）

| 名称 | 范围 | 理由 |
|---|---|---|
| `dsh-ops.process.spawn` | 子进程 | 每次调用启动固定路径的 `dsh-ops-worker.exe`，不接受任意命令 |
| `dsh-ops.fs.read` | 工作区只读 | 读取目标限制在 `${workspace}` 内，越界路径在启动 worker 前拒绝 |
| 网络 | 无 | 不发起任何网络请求 |
| 写入 | 无 | 不写文件、不改配置 |

## 平台（对应 x-components）

| 字段 | 值 |
|---|---|
| defaultEnabled | false（Yan 首装固定关闭，需手动启用） |
| platforms | `win32` |
| targets | `win32-x64`（其他架构会就绪但 worker 无法启动） |
| workspace | 必需（Blank 任务无法启动插件服务） |

## 安装 / 更新 / 卸载

- 安装：`yan_plugin_install_plugin(source_directory=..., task_id=...)`，或设置 → 插件 → 从本地目录安装。
- 启用：设置 → 插件 → 打开开关（MCP 工具没有 enable 接口）。
- 激活：在带工作区的任务里 `plugins_activate("YanPlugin-dsh-ops-yan")`。
- 更新：源码改动后重新安装（digest 变化）；升级安装保留启用状态。
- 卸载：`yan_plugin_remove_plugin(id)`；已加载会话需重新激活或新建任务。

## 兼容性

- Yan Agent 插件协议 schemaVersion 1。
- 本机验证：Yan Agent（Windows 11）+ Electron Node 24.21.0。
- 清单 `timeoutMs=60000`，服务端 worker 超时 55000，避免宿主断连。

## 验证证据

见 [VALIDATION.md](VALIDATION.md)。摘要：

- `node tests/smoke.mjs` 14/14
- `node tests/bench.mjs` 17/17
- 3 MB 文本 `stat` 返回 291 B（0.0095%），p50 37 ms
- DOCX/PDF 文本层、CSV/TSV 引号解析、越界拒绝均通过

## 已知限制

- PDF 仅 1–32 页、只读文本层，无 OCR。
- DOCX 只读正文段落，不含页眉页脚、批注、表格排版。
- 单次 worker 响应约 96 KB 上限；服务端另有 1 MB 兜底与分页提示。
- 仅 Windows x64。

## 上游与许可

- worker：`dsh-ops@0.4.4` npm 包 `runtime/win32-x64`，sha256 `607e97c2…3f0f`。
- 源码审阅：`T-Auto/dsh-ops` 0.5.0-alpha3；协议字段与工具参数按该版本核对。
- MIT；未包含上游 GPL 的 bash 载荷。分发时保留 `LICENSE` 与来源说明。

## 市场条目文案（可直接用于 catalog.json）

```json
{
  "id": "YanPlugin-dsh-ops-yan",
  "name": "dsh-ops for Yan",
  "description": "Read-only port of dsh-ops: bounded file, table, DOCX and PDF tools backed by the original Rust worker, exposed to Yan as a local MCP server.",
  "category": "developer-tools",
  "download": true
}
```

`repository` 必须是 `owner/YanPlugin-dsh-ops-yan`，`revision` 为 40 位 commit SHA，`digest` 与 `files` 用 `scripts/market-entry.mjs` 生成。完整要求见 [PUBLISHING.md](PUBLISHING.md)。

## 变更记录

| 版本 | 内容 |
|---|---|
| 0.1.3 | 按市场要求改名 `YanPlugin-dsh-ops-yan`，补 LICENSE/NOTICE，新增严格测评与发布文档 |
| 0.1.2 | 路径规范化（junction 工作区）、partial/error/isError 语义、编码归一、read_files 上限、编码与页面限制写入 schema |
| 0.1.1 | 路径沙箱、超时对齐、schema 上限、输出预算、文档分层 |
| 0.1.0 | 首个只读移植版本 |
