# Wallpaper Engine 壁纸桥接（Yan 市场核心版）

把本机 **Wallpaper Engine** 的创意工坊/本地壁纸导入 **Yan Agent**，提供 MCP 工具和本地浏览器自选面板。

> 这是**官方市场核心版**：不修改 Yan 的 `app.asar`，不注入设置页 UI。设置页 WE 面板只存在于另一个「完整版」，不在本包中。

## 功能

- 自动扫描 Steam 库、创意工坊 431960 与 WE 本地项目
- 浏览器自选面板：预览、搜索、类型过滤、导入并应用/仅入库、移除
- 视频自动转为壁纸安全规格（H.264 / 8-bit / 最长边 ≤1920 / ≤60fps / ≤24Mbps / 无音轨）
- 每个视频生成静态备用图；转码失败/无 ffmpeg 时自动降级静态图
- 一键修复旧 4K/HEVC/高码率视频
- `scene` / `web` / `application` 自动提取高清静图（静态）

## 环境要求

- Windows + 已安装 Wallpaper Engine（Steam 431960），并有订阅/本地项目
- Yan Agent（壁纸数据位于 `%APPDATA%\yan-agent\YanData`）
- 可选 ffmpeg / ffprobe：自动从 PATH、winget、scoop、chocolatey、`C:\ffmpeg\bin` 等位置查找；也可在插件配置填 `ffmpegPath`

Steam 库与 Yan 数据目录默认自动检测；检测不到时可在插件配置填 `steamLibrary` / `yanDataDir`。

## 安装

1. 在 Yan 插件安装入口（插件页 /「插件与智能体」）选择包含 `yan-plugin.json` 的插件目录。
2. 启用插件，重启/刷新 Yan 让 MCP 工具加载。
3. 对 Yan 说「检查 WE 壁纸环境」或调用 `we_status` 确认扫描结果。

## 使用

### 浏览器自选面板

对 Yan 说「打开壁纸自选面板」，或调用 `we_open_gallery`。插件会：

1. 启动本地零依赖 HTTP 服务 `gallery.cjs`，只绑定 `127.0.0.1:43197`
2. 用 Windows 默认浏览器打开 `http://127.0.0.1:43197`
3. 面板 30 分钟无操作自动关闭；再次打开会重新启动

后端已运行时也可以手动访问该地址。端口被占用可在插件配置改 `galleryPort`。

### 聊天代办

- 「把我 Wallpaper Engine 里的壁纸列出来」
- 「把那个纽约夜景的壁纸设为 Yan 壁纸」
- 「随便挑一个 WE 视频壁纸用上」
- 「之前导入的视频有点卡，帮我修复一下」

## 生效方式与限制

- 导入写入 Yan 配置后，**打开 Yan 设置页或重启应用**后生效。
- Yan 壁纸库：JPG/PNG/MP4/WebM，单文件 ≤50MB，自定义壁纸 ≤48 个，声音静音。
- 视频统一 1080p/H.264/无音轨；不是 4K 动态方案。
- `scene`/`web`/`application` 只能静态图，不会动。
- 插件只改 Yan 窗口内的壁纸，不改 Windows 桌面壁纸。
- 导入期间避免同时在 Yan 设置页保存设置。

## 兼容性

- 仅 Windows；已在 **Yan 2.0.0-beta.1-rc.1** + **Wallpaper Engine（Steam 431960）** 上验证。
- 标准插件 + 本地 MCP + 本地 HTTP 面板；**不修改 app.asar、无 UI 扩展、无安装脚本/hooks、无网络下载**。
- 运行时读写 `YanData` 的配置与 uploads；本地面板只绑定回环地址。
- ffmpeg 是可选依赖；没有它时部分大视频/HEVC 会降级静态图。
- 设置页 WE 面板不在本包中；需要的话使用单独的完整版（GitHub Release）。

## MCP 工具

`we_status`、`we_list_wallpapers`、`we_import_wallpaper`、`we_optimize_imported`、`we_list_imported`、`we_remove_imported`、`we_open_gallery`。

## 许可

MIT。见 `LICENSE`。