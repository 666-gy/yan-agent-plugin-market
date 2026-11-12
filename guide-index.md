# Evans 指南目录

| 技能主题 | 用途 | 上游角色 |
| --- | --- | --- |
| active-scan | 主动端口与服务扫描（nmap/masscan），严格遵守授权范围 | recon |
| asset-correlation | 资产关联：域名↔IP↔C 段↔证书↔服务的图谱化 | recon |
| browser-automation | 无依赖驱动 Chrome/Chromium 抓取 JS 渲染页面、截图、执行 JS、抓接口清单（headless 兜底 + playwright-cli） | recon |
| chisel-tunnel | chisel 隧道：HTTP/WebSocket 封装的多路复用隧道，最易穿透出网限制与反向代理 | internal |
| cn-proxy-pool | 国内免费 HTTP/SOCKS5 代理池：抓取、验活、按需轮换；只用命令级代理参数，绝不改动本机网络与代理配置 | vuln-scan |
| credential-attack | 凭据攻击：在线弱口令爆破（hydra）与离线哈希破解（hashcat/john），覆盖 SSH/FTP/RDP/SMB/数据库/Web 后台 | exploit |
| dir-bruteforce | 目录与文件爆破：后台入口、备份文件、配置泄露、源码与版本库暴露（ffuf/feroxbuster/dirsearch/gobuster） | vuln-scan |
| fofa-recon | 用 FOFA API 批量测绘靶标资产（域名/IP/端口/标题/指纹）；内置限速客户端，严格单线程 + 最小间隔 + 退避重试，避免触发 45012 | recon |
| frp-tunnel | frp 内网穿透：在自有 VPS 上跑 frps，在目标上跑 frpc，得到稳定 socks5 与端口映射 | internal |
| fscan-intranet | fscan v2.2.1 内网综合扫描：存活探测、端口/服务识别、28 类弱口令爆破、未授权访问与高危漏洞（MS17-010/SMBGhost）、Redis 利用与 SOCKS5 隧道 | internal |
| gogo-intranet | gogo v2.15.0 高性能内网扫描引擎：智能/超智能模式、主动+被动指纹、关键信息提取（title/cert/JWT/邮箱/身份证）、nuclei 模板 POC、发包可控低噪声 | internal |
| kimi-webbridge | 用月之暗面 Kimi 浏览器扩展（WebBridge）驱动用户真实 Chrome/Chromium：导航、读取页面、点击、填表、执行 JS、截图 | recon |
| lateral-movement | 内网横向与提权：Impacket 套件（PtH/PsExec/WMI/DCOM/Kerberos/凭据转储）+ enum4linux/smbclient 信息枚举 | internal |
| nuclei-scan | nuclei 模板化漏洞扫描：13,000+ 模板覆盖 CVE/暴露面/配置缺陷/默认口令，Nday 与 1day 的主力检测手段 | vuln-scan |
| passive-recon | 被动信息收集：不接触目标主机，仅使用公开数据源 | recon |
| recon-pipeline | ProjectDiscovery 信息收集流水线：subfinder→dnsx→naabu→httpx→katana 一键铺开域名资产面 | recon |
| redteam-setup | 首次使用引导：引导提供 FOFA_KEY 与 VPS 登录方式、验证通道可用、给出降级口径（工具链由工具箱附件按需获取） | plan |
| shell-handler | 反弹 Shell 与载荷投递：VPS 上起 MSF/nc/socat 监听接收 shell，或从目标主动拉取载荷落地 | exploit |
| suo5-tunnel | 用 suo5 通过 WebShell/HTTP 建立 SOCKS5 隧道，把内网流量代理出来（内网突破核心工具） | internal |
| unauth-exploit | 未授权访问与信息泄露利用链：Redis/MySQL/MSSQL/ES/Docker/MongoDB 等暴露服务直取数据或写马 | exploit |
| vps-reverse-shell | 用自建 VPS（<你的VPS_IP>，SSH 私钥登录）做反弹 Shell 落地与中转：9000-9999 端口监听、非交互会话驱动、载荷投递、反向隧道 | exploit |
| web-fingerprint | Web 服务指纹识别：框架、中间件、CMS、组件版本 | recon |
| webshell-toolkit | 冰蝎 / 哥斯拉 / 中国蚁剑 的启动与用法，用于上传并管理 WebShell、维持访问、操作目标服务器 | exploit |
