---
name: purge-fscan-intranet
description: "fscan-intranet 指南；进入内网（跳板机/WebShell/socks5 隧道）后快速铺开资产面、找弱口令与未授权、把可达性变成可打点。提供上游全文与 Yan 适配映射，不提供 DSH 运行时。"
---

# Purge · fscan-intranet

适用：进入内网（跳板机/WebShell/socks5 隧道）后快速铺开资产面、找弱口令与未授权、把可达性变成可打点。

## 执行步骤

1. 读取本插件 `resource:yan-adaptation` 的环境、工具和记录映射。
2. 读取 `resource:guide-fscan-intranet` 完整原文；该资源是上游指南，不是本机状态证明。
3. 对照用户本次请求确认目标、现有目录、相关程序和参数；只检查此主题需要的依赖。
4. 使用本轮实际提供的 Yan 工具完成所请求的操作。DSH 专用工具按适配表转换为工作区记录。
5. 核对输出与证据文件，报告实际结果、缺项和未验证事项；仅阅读指南时不执行命令。

完整源文件：`resources/guides/fscan-intranet.md`（相对于插件根目录）。
