# YanPlugin-purge

基于 [BWF3rdTeam/Evans-repo](https://github.com/BWF3rdTeam/Evans-repo/tree/main) 的文档/技能适配插件，版本 **0.1.0**。按 [Yan Agent 插件市场说明](https://github.com/666-gy/yan-agent-plugin-market) 制作，包目录、清单 ID 和显示名称统一为 `YanPlugin-purge`；技能 ID 使用 `purge-` 前缀。

## 功能

- 23 个按主题触发的 Yan 技能入口。
- 23 份完整上游指南，原文不删改，按需读取。
- 针对 Yan 的平台、浏览器、工作区记录和外部依赖映射。
- 保留上游署名、MIT 许可证、来源提交号与文件校验值。

主题覆盖资产收集与关联、端口扫描、Web 指纹、ProjectDiscovery 流水线、Nuclei、目录探测、FOFA、浏览器操作、环境准备，以及上游的凭据、隧道、内网和会话操作指南。具体目录见 `guide-index.md`。

## 适配范围

**这是指南适配版，不是完整 dsh-purge。** 原仓库针对 DeepSeek Harness 0.2.1-rc.2，本版不安装 DSH、不补丁 Yan Kernel、不移植 Clean/Drill 界面、不注入默认提示词、不提供 Cordis 或 SQLite 资产库，也不注册 `redteam_*` MCP 工具。

指南里的“本机已有”、版本、模板数量、VPS 配置和路径均为上游环境描述。使用前通过 `yan-adaptation` 资源核对实际机器与工具。

## 使用

在支持原生插件导入的 Yan 版本中，通过官方插件入口导入包含 `yan-plugin.json` 的包，启用所需技能后，例如：

- “使用 YanPlugin-purge 的 purge-passive-recon 技能整理我提供的域名资料。”
- “按 YanPlugin-purge 的 purge-redteam-setup 技能检查这次任务所需的工具，先只列出可用项和缺项。”
- “读取 YanPlugin-purge 的 purge-nuclei-scan 指南，解释该命令会执行哪些操作。”

加载文档不需要外部运行时。执行示例需要用户已准备的相应程序、账户与目标。本版没有安装钩子、后台服务、遥测、自动下载或自动更新。

创建、校验、安装、启用和公开市场上架是不同状态。本包的创建不意味着已安装或已公开上架。当前任务的实际状态见交付说明，不以本 README 推断运行结果。

## 市场目录

市场提交时，插件本体放在 `plugins/YanPlugin-purge/`。正式索引的 `id`、`manifest.id` 和下载源码仓库名都使用 `YanPlugin-purge`，版本固定到真实提交号，并附包内逐文件清单和 SHA-256 摘要。上架前需要官方创建、安装与最小加载验证，并由市场维护者审核。

## 来源

上游版本 `1.1.71-rc2.1`；下载归档提交 `adfc90640035acbe84998c18adf81c2d2a4f23cc`。完整来源见 `source-provenance.json`，作者与分支关系见 `NOTICE`。

上游指南按原文许可分发；本次包装与说明采用 MIT。`licenses/` 保留上游许可证和声明。此适配不是上游作者或 Yan 官方背书。
