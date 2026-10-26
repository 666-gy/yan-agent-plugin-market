# YanPlugin-hello

Yan Agent 原生插件最小示例，版本 1.0.0。用于检查插件安装、启用、技能展示与调用。

## 内容

- yan-plugin.json：Yan schemaVersion 1 清单。
- instructions.md：插件使用说明。
- skills/hello-yan/SKILL.md：Hello Yan 技能。

不包含 MCP、可执行代码、安装脚本、账号配置或网络依赖。

## 在 Yan 中验证

1. 将本仓库克隆或下载解压到当前 Yan 任务目录内。
2. 让 Yan 安装该目录中的原生插件包；安装后默认关闭。
3. 在插件页启用 Hello Yan，确认 hello-yan 技能已启用。
4. 新建任务并输入“测试 hello 插件”；如需手动选择技能，请选择 Hello Yan。
5. 预期回复：

```text
Hello from YanPlugin-hello!
版本：1.0.0 · 技能：hello-yan
```

## 官方市场

GitHub 仓库名称符合 YanPlugin-xxx 规则，但创建仓库不会自动加入官方市场。官方市场显示与刷新还需要在 yan-agent-plugin-market/catalog.json 登记兼容的下载元数据和完整性摘要。

已通过当前 Yan 本地原生包格式校验；实际桌面安装、启用与会话效果由用户验证。

## 许可

MIT
