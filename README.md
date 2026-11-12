# Yan Agent Plugin Market

Yan Agent 官方插件市场仓库。

本仓库只收录经过 Yan 插件协议校验、人工审核和实际安装验证的插件。Codex、Claude 或其他 Agent 平台的插件不能直接视为 Yan 插件；需要先迁移为 Yan 原生结构并重新校验。

## 命名规则

进入官方市场的插件必须使用 `YanPlugin-xxx` 前缀。

- 插件目录名必须以 `YanPlugin-` 开头，例如 `YanPlugin-office`。
- `yan-plugin.json` 的 `id` 必须与目录名一致，并以 `YanPlugin-` 开头。
- `xxx` 使用短横线分隔的 ASCII 标识，不使用空格、下划线、路径分隔符或不可见字符。
- 同一个插件的目录名、清单 `id`、市场目录项 `id` 必须完全一致，大小写也一致。
- 官方插件只能使用一个稳定 ID；改名视为新插件，升级使用 `version`。

> 当前 Yan 客户端的通用插件清单校验仍主要面向小写 ID。正式开放市场前，需要把客户端的官方市场校验明确升级为允许并严格要求 `YanPlugin-xxx`；本仓库的命名规则优先于旧版校验器。

## 仓库结构

```text
Yan Agent Plugin Market/
  README.md
  catalog.json
  plugins/
    YanPlugin-example/
      yan-plugin.json
      instructions.md
      skills/
        example/SKILL.md
      resources/
      scripts/
      assets/
```

`catalog.json` 是市场索引，只保存展示元数据、版本、下载地址和完整性摘要。插件本体必须位于 `plugins/<id>/`，并且目录名与清单 `id` 相同。

## Yan 插件最低要求

每个插件包必须包含严格的 `yan-plugin.json`，至少声明：

```json
{
  "schemaVersion": 1,
  "id": "YanPlugin-example",
  "version": "1.0.0",
  "name": "Example",
  "description": "插件功能和适用场景"
}
```

插件可以提供：

- `instructions`：插件总体使用说明
- `skills`：可加载的 `SKILL.md` 工作流
- `resources`：模板、参考资料和其他只读资源
- `mcpServers`：本地或远程 MCP 服务
- `configuration`、`environment`、`platforms`、`requiredCommands`：运行要求

不支持把 UI 扩展、生命周期 hooks、其他 Agent 定义或第三方专属运行时声明成 Yan 已实现能力。未知清单字段必须报错，不能静默忽略。

## 提交流程

1. 在 `plugins/YanPlugin-xxx/` 编写完整插件。
2. 运行 Yan 的插件清单和文件清单校验。
3. 确认所有资源路径位于插件包内，没有符号链接、目录穿越、安装脚本或隐藏下载行为。
4. 在干净环境中安装、启用并完成最小运行验证。
5. 在 `catalog.json` 登记版本、许可、来源、支持平台、依赖和 SHA-256 摘要。
6. 提交 Pull Request，说明兼容范围、已验证功能、未验证依赖和账号要求。

市场审核会分别记录：

- **格式兼容**：是否符合 Yan 插件清单和包结构。
- **安装兼容**：是否能通过 Yan 安装器完成校验和安装。
- **运行验证**：声明的 Skill、资源和 MCP 是否在支持的平台上实际工作。
- **权限与网络**：是否需要本地进程、网络、环境变量或第三方账号。

格式兼容不等于运行验证通过。缺少依赖、账号或平台支持时，插件可以被标记为未就绪，但不能伪装成已验证。

## 版本和完整性

- 使用 `major.minor.patch` 版本号，可带预发布后缀。
- 破坏清单结构、能力行为或配置语义时递增主版本。
- 每个市场版本都必须有固定来源和 SHA-256 摘要。
- 发布包不可在安装后自修改；运行时产物写入当前任务工作区或 Yan 管理的运行目录。
- 不运行安装脚本或 hooks，不自动安装隐藏依赖。

## 第三方插件迁移

第三方插件先作为源码输入处理。Yan Agent 可以协助把 Codex/Claude 插件迁移为 `YanPlugin-xxx`，但必须明确列出：

- 已转换的 Skills、资源和 MCP 服务；
- 无法转换的 hooks、UI 扩展、Agent 定义和平台功能；
- 需要人工修改的源码；
- 迁移后重新通过的 Yan 校验和实际验证结果。

未经迁移和审核的第三方插件不得进入官方市场。

## 许可证

每个插件必须在清单或包内注明许可证和上游来源。插件作者对代码、依赖、第三方服务和许可证负责；市场仓库只负责索引、校验和审核记录。
