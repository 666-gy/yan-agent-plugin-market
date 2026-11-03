---
name: ops-files
description: 用 dsh-ops 只读工具做有界文件与文档读取——stat/grep/glob/read_files/read_table/read_docx/read_pdf/diff/inspect_local_file。工具名在 Yan 里是哈希，按描述前缀「[dsh-ops for Yan / ops / <原工具名>]」匹配。
---

# dsh-ops 只读文件工具

## 决策顺序

1. 只要文件事实 → `stat`，不要先读正文。
2. 找内容 → `grep`；找文件 → `glob`。两者返回有界结果，用 `nextOffset` / `continuation` 翻页，不要重复扫描。
3. 读文本 → `read_files`，一次传多个文件的行区间，比逐文件 `read` 省上下文。
4. 表格 → `read_table`；文档 → `read_docx`（段落）或 `read_pdf`（页）。
5. 改内容前 → `diff` 只看变更块；怀疑编码/损坏 → `inspect_local_file`。

## 参数约定

- 路径可写绝对路径或相对工作区根的路径；越界会被拒绝（含符号链接解析后的越界）。
- 工具参数是 **camelCase**：`outputMode`、`caseInsensitive`、`lineNumbers`、`beforeContext`、`afterContext`、`exactTotal`。
- 未知字段会被拒绝（`INVALID_ARGUMENT`），不要凭猜测加参数。
- grep 的 `outputMode`：`content`（默认）、`files_with_matches`、`count`、`summary`。
- glob 的 `outputMode`：`paths`（默认）、`details`。

## 上限（超出会在校验阶段被拒）

| 工具 | offset | limit |
|---|---|---|
| `grep` / `glob` | ≥ 0 | 1–10000 |
| `read_files`（每个文件） | ≥ 1 | 1–10000，文件数 1–32 |
| `read_table` | 1–100000 行 | 1–1000 行 |
| `read_docx` | 1–100000 段 | 1–1000 段 |
| `read_pdf` | 1–32 页 | 1–32 页 |
| `diff` | ≥ 0 | 1–1000 块 |
| `inspect_local_file` | ≥ 1 | 1–10000 行/16 字节行 |

`read_table` 的 `offset` / `limit` 可以省略（默认 1 / 200），`header` 默认 true。编码只支持 `utf-8`、`utf-16le`、`utf-16be`；`inspect_local_file` 只支持 UTF-8。传其他编码值会在调用前被拒；GBK 文件按默认 utf-8 读会得到 `ERR_INVALID_ENCODING`（`status=partial`），先确认文件编码或改用 `inspect_local_file` 的 hex 视图。

## 结果解读

- `status` 为 `completed` 才算全部完成；`partial` 表示只拿到一部分（有文件失败、编码不符或输出被截断）。
- 有 `error` 或 `failed > 0` 时按错误处理：先读 `error.code`、`error.message`、`error.nextAction`，不要盲目重试同一请求。
- `complete: false` / `pageComplete: false` 表示还有后续页，用 `nextOffset` 继续。
- `omitted` / `truncatedBy` 说明输出被预算截断，需要缩小 `limit` 或翻页。
- 响应超过约 1 MB 会被整体替换为 `{ truncated, truncatedBy, originalBytes, preview }`。
- `excludedContent` 明确列出该文档格式没有覆盖的内容，回答时不要当作已观察事实。
- `stat` 的 `readonly` 指文件系统只读属性，不是本插件的写权限；本插件始终只读。
- `diff` 的变更量看 `hunk.added` / `hunk.removed` 或 `items`；实测整行替换时 `changed` 仍为 0。
- `inspect_local_file` 的 hex 输出是小写、空格分隔（`4c 31 20 …`）。
- `read_pdf` 只覆盖第 1–32 页（worker 上限），更长的 PDF 读不到后续页。

## 禁止

- 不要用这些工具尝试写文件（全部只读）。
- 不要假设 PDF 有 OCR，也不要假设 DOCX 能读到页眉页脚或表格排版。
- 不要按字面名 `stat` / `grep` 找工具，用描述前缀匹配。
