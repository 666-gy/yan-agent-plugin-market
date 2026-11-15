# Wallpaper Engine 壁纸桥接

把用户本机 Wallpaper Engine（Steam 431960）的创意工坊订阅壁纸与本地项目壁纸，导入 Yan Agent 的壁纸系统并应用。

## 资源

- `TUTORIAL.md`：面向用户的新手教程（安装、浏览器面板、导入、常见问题）。
- `README.md`：完整使用说明。

## 能力与边界（市场核心版）

- Yan 自定义壁纸仅支持 JPG/PNG 图片与 MP4/WebM 视频，单文件 ≤50MB，壁纸库上限 48 个。
- 视频导入时统一转 H.264 / 8-bit / 最长边 ≤1920 / ≤60fps / ≤24Mbps / 无音轨；4K、HEVC、10-bit 不再原样导入。
- 每个视频生成 `*.poster.jpg` 静态备用图；转换失败/无 ffmpeg 时自动降级静态图。
- WE `scene`/`web`/`application` 只提取高清静图（静态）；面板里的 `preview.gif` 只是预览动画。
- 本包**不修改 app.asar、不注入设置页 UI**；通过本地浏览器面板使用。
- 导入后打开 Yan 设置页或重启应用生效。

## 工具

- `we_status`：环境检测（WE 安装、创意工坊、Yan 配置、ffmpeg）。
- `we_list_wallpapers`：浏览/检索壁纸。
- `we_import_wallpaper`：导入并可选应用；视频自动转码 + 备用图。
- `we_optimize_imported`：修复已导入的 4K/HEVC/旧视频。
- `we_list_imported`：查看已导入条目、视频编码/分辨率/是否兼容。
- `we_remove_imported`：移除条目（可选删文件与备用图）。
- `we_open_gallery`：打开浏览器自选面板（本地 127.0.0.1）。

不要直接编辑 YanData 或应用目录；一切写入都通过上述工具完成。