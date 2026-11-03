# 验收与实测

仿照上游 `dsh-ops` 的「手动验收」写法：记录环境、命令、期望、实际结果和未覆盖项。所有数字来自本机真实运行，不是估算。

## 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-11-03 |
| 宿主 | Yan Agent（Windows 11），Electron Node 24.21.0 |
| 插件 | `YanPlugin-dsh-ops-yan` 0.1.3（安装副本 digest 由 `inspectPackage` 输出） |
| 运行时 | `dsh-ops@0.4.4` win32-x64 worker |
| 工作区 | `C:\Users\甄朝晖\Desktop\dsh-ops-port` |

## 复现命令

```powershell
cd dsh-ops-yan
node tests/smoke.mjs   # 协议/边界自测：14/14
node tests/bench.mjs   # 正确性 + 分位数延迟：17/17
```

`tests/bench.mjs` 在临时工作区生成 3 MB / 70,000 行文本、5,000 行 CSV、带引号 CSV、TSV、二进制文件和只读文件，并使用 `tests/fixtures/` 内的 DOCX（3 段中文）、PDF（2 页文本层）、GBK CSV。

## 功能与正确性（17/17 PASS）

| 用例 | 返回字节 | p50 ms | p95 ms | 判定 |
|---|---|---|---|---|
| stat 3 MB 文本 | 291 | 37.2 | 48.5 | bytes/行数/sha256 全部吻合 |
| read_files 3 段 × 40 行 | 19,441 | 55.1 | 56.7 | 三段首行逐字匹配 |
| read_table 20 行 | 1,879 | 33.2 | 42.1 | 列名、首行、`nextOffset=21` |
| read_table 引号字段 | 657 | 29.3 | 29.8 | `"a,b"`、`"he said ""hi"""` 解析正确 |
| read_table TSV | 666 | 29.3 | 30.5 | `format=tsv` 列名正确 |
| grep count | 573 | 33.4 | 35.4 | 与本地正则计数一致 |
| grep content | 434 | 31.1 | 32.8 | 命中行内容正确 |
| glob details | 697 | 30.9 | 31.1 | 三个 CSV 全部列出 |
| read_docx | 796 | 31.8 | 36.4 | 3 段中文逐字匹配 |
| read_pdf 1–2 页 | 844 | 31.0 | 38.7 | 两页文本逐字匹配 |
| read_pdf 分页 | 769 | 29.5 | 30.1 | `offset=2` 只返回第 2 页 |
| diff 单处修改 | 8,472 | 36.6 | 40.2 | `hunk.added/removed` 非 0 |
| inspect hex | 462 | 40.1 | 46.2 | 首行 `4c 31 …` 正确 |
| grep 跳过二进制 | 491 | 35.9 | 45.0 | `skippedFiles>=1` |
| GBK 文件按 utf-8 读 | 817 | 30.2 | 30.7 | `status=partial` + `ERR_INVALID_ENCODING` |
| 工作区外路径 | 125 | 0.6 | 1.8 | 1 ms 内拒绝，不启动 worker |
| 超上限参数 | 246 | 31.1 | 33.5 | `INVALID_ARGUMENT`（1–32 页） |

## 语义确认（实测，不是推测）

- `stat.revision` **等于文件字节的 sha256**（3 MB 样本比对一致）。
- `diff` 的 `changed` 字段在「一行被替换」时仍为 0；变更量应看 `hunk.added` / `hunk.removed` 或 `items`。SKILL 已补这条。
- `inspect_local_file` hex 输出为小写、空格分隔（`4c 31 20 …`）。
- `read_files` 分页未读完时 `status=partial` 但没有 `error`，属于正常翻页，不是失败。
- 越界路径在 `absolute()` 阶段就被拒，**不启动 worker**，所以 p50 只有 0.6 ms。

## 与直接读取的对比

| 场景 | 原始体积 | 返回体积 | 比例 |
|---|---|---|---|
| stat 3 MB 文本 | 3,068,894 B | 291 B | 0.0095% |
| read_table 5,000 行 | 87,301 B（5,000 行） | 1,879 B（20 行） | 2.2% |
| read_files 3 段 | 3 × 3 MB | 19,441 B | 0.21% |

## 未覆盖 / 阻塞项

| 项 | 状态 | 原因 |
|---|---|---|
| PDF 第 33 页以后 | BLOCKED | worker 硬上限 1–32 页 |
| 扫描版 PDF OCR | 不支持 | 只读文本层 |
| DOCX 表格/页眉页脚 | 不支持 | 设计范围 |
| 文档工具权限弹窗 | SKIPPED | 当前模式自动放行，未触发人工确认 |
| 卸载后重装流程 | SKIPPED | 未在本轮执行 |
| 非 Windows 平台 | BLOCKED | 只打包 win32-x64 |

## 结论

17 项功能与边界全部通过；读取类调用 29–55 ms，越界在 1 ms 内拒绝。插件对 `stat`、表格、DOCX/PDF、多文件读取有明确收益，纯文本单段读取与内置工具重叠。
