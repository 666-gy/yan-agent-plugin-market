# dsh-ops for Yan（只读）

本插件把 [T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops) 的 Rust worker 接入 Yan，作为本地 MCP 服务提供**只读**文件与文档工具。

## 怎么认工具

Yan 会把插件工具改名成哈希形式（`t_…`，再加宿主前缀），**字面名 `stat`、`grep` 在本会话里并不存在**。
本插件每个工具的描述都以 `[dsh-ops for Yan / ops / <原工具名>]` 开头，按这个前缀匹配，再按它的 schema 调用。

## 什么时候用

| 需要 | 原工具名 |
|---|---|
| 文件大小 / 行数 / 修订哈希，不读正文 | `stat` |
| 在大目录里定位内容或文件 | `grep` / `glob` |
| 一次读多个文件的行区间 | `read_files` |
| CSV/TSV 分页读取并保留列元数据 | `read_table` |
| DOCX 正文段落 / PDF 文本层 | `read_docx` / `read_pdf` |
| 改内容前先看会动哪些行 | `diff` |

Yan 内置的 `read` / `grep` / `glob` 仍然可用；本插件的增量价值是 `stat`、`read_files`、`read_table`、`read_docx`、`read_pdf`、`diff`、`inspect_local_file`。

## 边界

- **只读**：不写入、不替换、不删除。写操作走 Yan 内置 `write` / `edit`。
- 路径限制在工作区根内：绝对路径越界、`..` 越界、符号链接解析后越界都会被拒绝。
- PDF 只读文本层，**不做 OCR**，扫描件返回空文本。
- DOCX 只读正文段落，不含页眉页脚、批注和表格排版。
- 只有 Windows x64 预编译 worker（`win32-x64`）。
- **必须在有工作区的任务里激活**：Blank 任务没有工作区目录，插件服务本身起不来，不是工具调用被拒。

## 结果怎么读

- `status: "completed"` 才算全部完成；`status: "partial"` 表示只拿到一部分（有文件失败、编码不符或输出被截断），此时还要看 `error` 和 `failed`。
- `status: "error"` 或存在 `error` / `failed > 0`：读 `error.code` / `error.message` / `error.nextAction`，不要重复同一请求。
- `complete: false` / `pageComplete: false` → 用 `nextOffset` 或 `continuation` 翻页。
- 单次响应超过约 1 MB 会被替换为 `{ truncated: true, truncatedBy, originalBytes, preview }`，按 `nextAction` 缩小范围。
