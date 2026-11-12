---
name: purge-dir-bruteforce
description: "dir-bruteforce 指南；已确认 Web 存活但指纹无直接 Nday 线索；需要找后台入口、备份、配置、源码、上传点等隐藏路径。提供上游全文与 Yan 适配映射，不提供 DSH 运行时。"
---

# Purge · dir-bruteforce

适用：已确认 Web 存活但指纹无直接 Nday 线索；需要找后台入口、备份、配置、源码、上传点等隐藏路径。

## 执行步骤

1. 读取本插件 `resource:yan-adaptation` 的环境、工具和记录映射。
2. 读取 `resource:guide-dir-bruteforce` 完整原文；该资源是上游指南，不是本机状态证明。
3. 对照用户本次请求确认目标、现有目录、相关程序和参数；只检查此主题需要的依赖。
4. 使用本轮实际提供的 Yan 工具完成所请求的操作。DSH 专用工具按适配表转换为工作区记录。
5. 核对输出与证据文件，报告实际结果、缺项和未验证事项；仅阅读指南时不执行命令。

完整源文件：`resources/guides/dir-bruteforce.md`（相对于插件根目录）。
