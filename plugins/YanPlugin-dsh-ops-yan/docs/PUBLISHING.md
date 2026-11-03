# 验证与发布

本文分两层：怎么验证这个插件真的可用，以及要进 Yan 官方插件市场需要满足什么。

## 一、可重复验证

### 1. 协议与行为自测（CI 跑这个）

```powershell
node tests/smoke.mjs
```

`tests/smoke.mjs` 零依赖，会在临时目录起真实 `server.cjs`，检查：

- `initialize` 返回 `dsh-ops` 与合法版本号
- `tools/list` 恰好 9 个只读工具，schema 都是 object
- `stat` 的 bytes/lineCount/status
- 工作区内绝对路径可用，`..` 越界被拒
- `read_files` 多文件、`read_table` 列与 `nextOffset`
- 不支持的编码在启动 worker 前被拒
- 未知字段被 worker 拒绝（`INVALID_ARGUMENT`）
- 无 `OPS_WORKSPACE` 时干净失败
- 清单契约（`timeoutMs=60000`、`OPS_TIMEOUT_MS=55000`、`win32`）
- schema 上限（`read_files` 32 个文件、`read_pdf` 32 页）

退出码非 0 即失败。GitHub Actions 在 `windows-latest` 上跑 Node 22 和 24（`.github/workflows/ci.yml`）。

### 2. 宿主验收（CI 覆盖不到，必须手动做一次）

1. 安装：`yan_plugin_install_plugin` 指向包目录，确认 `ready:true`。
2. 设置 → 插件 → 打开开关（`enabled:true`）。
3. 在有工作区的任务里 `plugins_activate("YanPlugin-dsh-ops-yan")`，确认返回 instructions 与 `skill:ops-files`。
4. 调用四条：`stat` 包内文件（成功）、`stat` 工作区外路径（拒绝）、`read_table`（有列名与 `nextOffset`）、`read_files`（多文件）。
5. 新建任务再激活一次，确认不是只在旧会话可用。

### 3. 建议的人工矩阵

| 场景 | 期望 |
|---|---|
| 工作区路径含中文/空格 | 正常读写 |
| 工作区根是 junction/符号链接 | 正常读写（服务端会规范化） |
| 工作区内 junction 指向外部 | 拒绝 |
| CSV：utf-8 / utf-16le / utf-16be | 正常；其他编码提前报错 |
| DOCX（正文）/ PDF（文本层） | 正常；扫描件 PDF 返回空文本 |
| 大目录 grep + 翻页 | 有界返回，`nextOffset` 可继续 |
| 同一会话并发多次调用 | 互不串行阻塞、结果不串 |
| 卸载后重装 | `enabled:false`，需重新启用 |

## 二、发布到官方市场

Yan 的市场清单由 `official-market.js` 校验，安装由 `native-download.js` 完成。规则是硬的：

- 清单 URL：`https://raw.githubusercontent.com/666-gy/yan-agent-plugin-market/master/catalog.json`
- 条目字段（严格 schema，不允许额外字段）：
  `id`、`name`、`description`、`category`、`repository`、`revision`、`digest`、`download`、`manifest`、`files`
- `id` 必须匹配 `^YanPlugin-[a-z0-9-]{1,39}$`
- `repository` 必须是 `owner/YanPlugin-<slug>`，且仓库名等于 `id`
- `revision` 是 40 位 commit SHA；`digest` 是整包摘要
- `download: true`
- `category` 只能是 `productivity` / `creativity` / `developer-tools`
- `files` 是 `{path, bytes, sha256}` 列表，必须包含根部的 `yan-plugin.json`，总数 ≤1000，单文件 ≤8 MB，总计 ≤64 MB
- 安装时按 `https://raw.githubusercontent.com/<repository>/<revision>/<path>` 逐文件下载，所以**仓库根目录必须就是插件根目录**，不能把包放在子目录
- 下载后会重新 `inspectPackage`，要求 digest 与清单一致，且 `JSON.stringify(manifest)` 与条目里的 `manifest` **逐字节同序**一致

### 标识状态

源码 id 已改为 `YanPlugin-dsh-ops-yan`（0.1.3），满足市场前缀要求。仓库名必须同为 `YanPlugin-dsh-ops-yan`，且必须公开。

改名会改变插件身份，旧的 `dsh-ops-yan` 需要卸载后按新 id 重装。

### 发布步骤

1. 把包内容放到一个**公开** GitHub 仓库的根目录（公开是必须的，安装器不带认证）。
2. 生成条目（需要本机装了 Yan，因为 digest 与 manifest 默认值由 Yan 代码生成）：

   ```powershell
   node scripts/market-entry.mjs --repository <owner>/YanPlugin-dsh-ops-yan --category developer-tools > entry.json
   ```

   脚本会检查 id/仓库名/revision/文件大小/路径，不符合就退出 1；`--allow-noncompliant` 只用于本地预览。

   **输出必须写到包目录之外。** `inventory` 会把包内每个文件都算进 digest，把 `entry.json` 重定向到仓库里会让 digest 与条目对不上（实测踩到过）。

3. 向 `666-gy/yan-agent-plugin-market` 提 PR，把 `entry.json` 加进 `catalog.json` 的 `plugins` 数组。
4. 合并后 Yan 的缓存 TTL 是 24 小时，可在插件页手动刷新。
5. 之后**任何文件改动都会改变 digest**（包括 `tests/`、`.github/`），必须重新生成条目并提升版本号。

### 条目里没有的东西

市场条目的 schema 不接受 `logo`、`presentation`、`homepage`、`requirements` 等字段；商店页展示只能靠 `name`、`description`、`category`。需要更丰富的展示就要改宿主，不是改插件。
