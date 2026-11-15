---
name: wallpaper-engine-bridge
description: 浏览 Wallpaper Engine 创意工坊与本地壁纸，把视频/图片壁纸导入 Yan Agent 壁纸库并应用；管理已导入壁纸、修复黑屏/卡顿的旧视频壁纸。用户提到 Wallpaper Engine、壁纸引擎、创意工坊壁纸、把 WE 壁纸设为 Yan 壁纸时使用。
---

# Wallpaper Engine 壁纸桥接（市场核心版）

把本机 Wallpaper Engine 的壁纸导入 Yan Agent 壁纸系统。工具由本插件的本地 MCP 服务暴露，描述前缀为 `[Wallpaper Engine 壁纸桥接 / wallpaper-engine / <工具名>]`。

## 新手教程

用户问「怎么安装/怎么用/浏览器面板怎么打开/新手教程在哪」时，指向插件资源 `TUTORIAL.md`（Yan 插件页 → 插件详情 →「新手教程」），或包内 `TUTORIAL.md`；`README.md` 是完整说明。

## 关键事实

- Yan 壁纸库：JPG/PNG/MP4/WebM，单文件 ≤50MB，最多 48 个自定义条目。
- WE `video` 类 → 统一转壁纸安全规格：H.264 / 8-bit yuv420p / 最长边 ≤1920 / ≤60fps / ≤24Mbps / 无音轨。
- 每个视频生成同名 `*.poster.jpg` 静态备用图；转换失败/无 ffmpeg 时自动降级静态图。
- WE `scene`/`web`/`application` → 只提取高清静图（静态，可达 4K）；面板里的 `preview.gif` 只是预览动画，导入的是静帧。
- 本包**不修改 app.asar、不注入设置页 UI**；浏览器面板与聊天工具照常可用。设置页 WE 面板在单独的完整版中。
- 导入后打开 Yan 设置页或重启应用生效。

## 自助挑选（推荐）

用户想自己浏览、挑选、导入时：调用 `we_open_gallery`，会启动本地后端（127.0.0.1:43197）并打开浏览器面板。可搜索/过滤、看预览、导入并应用/仅入库/移除/一键修复。面板 30 分钟无操作自动关闭。

## 对话式流程

1. **环境检查**：`we_status`。
   - `workshopDirs`/`wallpaperEngineInstalls` 为空：确认 WE 已安装/订阅下载，或配置 `steamLibrary`。
   - `yanConfigFound=false`：确认 Yan 运行过，或配置 `yanDataDir`。
   - `ffmpeg.available=false`：普通 MP4 可原样导入；>50MB 或不兼容视频会降级静态图。
2. **浏览挑选**：`we_list_wallpapers`（query/type/limit）。
3. **导入应用**：`we_import_wallpaper`，传 `id`；默认 `apply=true`、`mode=auto`、`fallbackStatic=true`。
4. **汇报**：告知昵称、是否应用、实际分辨率/是否转码/是否用了备用图，并说明「打开设置页或重启 Yan 后生效」。

## 修复旧视频

用户反馈旧导入视频黑屏/卡顿：
1. `we_list_imported` 看 `needsFix`/`technical`。
2. `we_optimize_imported`（不传 id 修全部）。
3. 无 ffmpeg 时先安装/配置 `ffmpegPath`。
4. 修复只替换文件，不改昵称/选中状态。

## 管理

- 查看：`we_list_imported`。
- 修复：`we_optimize_imported`。
- 移除：`we_remove_imported`（`deleteFile=true` 同时删视频与备用图）。
- 重复导入同一 WE 壁纸会替换旧条目。

## 注意

- 导入期间避免同时在 Yan 设置页保存设置。
- 不直接读写 YanData/config.json；全部通过工具完成。
- 壁纸声音始终静音是 Yan 的固定行为。
- 视频统一 1080p 是性能取舍，不承诺 4K 动态壁纸。
- 市场核心版没有遮罩/设置页面板相关工具；不要向用户承诺 `we_embed`/`we_scrim`。