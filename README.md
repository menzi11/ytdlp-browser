# yt-dlp 浏览器下载器

百分浏览器 / Chrome / Edge 的扩展 + 一个本地 native messaging 宿主，把当前页面交给已经装好的 `yt-dlp` 下载。

核心价值不是"又一个下载按钮"，而是**自动带浏览器登录态 cookie**：本机的 Chromium 127+ 应用绑定加密让 `yt-dlp --cookies-from-browser` 读不出 cookie 库（DPAPI 解密失败），而扩展走 `chrome.cookies` API，由浏览器进程自己解密后交给 yt-dlp —— YouTube 的机器人验证、B 站 1080P 这些需要登录的才下得动。

## 目录结构

```
ytdlp-browser/
├─ extension/            扩展本体（加载这个目录）
│  ├─ manifest.json      由 tools/make-manifest.js 从模板生成
│  ├─ background.js      唯一持有 native 端口的地方，管状态与广播
│  ├─ popup.html/css/js  弹窗界面
│  └─ icons/             16/32/48/128 图标
├─ host/
│  ├─ launcher.cs        native messaging 启动器源码（csc 编译）
│  ├─ ytdlp-host.exe     编译产物：把 stdin/stdout 原始字节中继给 host.js
│  ├─ host.js            业务逻辑：拼参数、跑 yt-dlp、解析进度、写 cookie、开目录
│  └─ manifest.json      宿主 manifest（安装脚本生成，含 allowed_origins）
├─ install.ps1           编译 + 生成 manifest + 写注册表
└─ tools/                自检与验证脚本
```

## 安装

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -ExtensionId <扩展ID>
```

然后 `chrome://extensions` → 打开开发者模式 → 加载已解压的扩展程序 → 选 `extension` 目录。

**关于扩展 ID**：这个 Chromium 分支（百分浏览器 5.3.1184）在加载已解压扩展时**忽略 `manifest.key`**，ID 由浏览器自己派生。所以第一次加载后要看扩展卡片上的 ID：

- 如果卡片 ID 与 `tools/extension-id.txt` 里的固定 ID 不同，就用卡片上的 ID 重跑一次 `install.ps1 -ExtensionId <卡片ID>`。
- 脚本会把两个 ID 都写进宿主的 `allowed_origins`，所以重跑后无需重启浏览器，重新点一次图标即可。
- 移动 `extension` 目录会改变派生 ID，需重跑安装。

卸载：`install.ps1 -Uninstall`（删注册表与宿主 manifest；扩展在 `chrome://extensions` 里手动移除）。

## 使用

点工具栏图标 → 选中当前标签页的 URL 并自动探测标题/时长/上传者：

| 控件 | 行为 |
|---|---|
| 最高 | `-f bv*+ba/b`，按配置合并成 mp4 |
| 1080P | `-f bv*[height<=1080]+ba/b[height<=1080]` |
| 仅音频 | `-x` 转 mp3，或直接取 m4a 不重编码 |
| 仅字幕 | `--skip-download` + 写 srt（中/英优先） |
| 嵌入字幕 | 默认开启，写入 zh/en 字幕后嵌进视频 |
| 整个播放列表 | 默认 `--no-playlist`，勾上才拉整列表 |

下载中显示进度条、已下字节、速度、剩余时间；完成后列出文件并可"打开文件夹"（在资源管理器中选中该文件）。

右键页面 / 链接 / 视频也可"用 yt-dlp 下载此页"（按最高画质、当前选项）。

## 实现要点

- **单端口**：只有 service worker 连宿主，弹窗通过 `runtime.sendMessage` 下命令、收状态快照。否则弹窗和后台各开一个端口，会起两个宿主进程，下载会重复。
- **心跳保活**：MV3 的 service worker 闲置 30 秒会被回收，端口一断宿主就被拉起者关掉，正在合并的大文件会半途而废。宿主每 15 秒发一个 `tick`。
- **cookie**：扩展用 `chrome.cookies.getAll({url})` 取该站点 cookie，转成 Netscape 格式随消息发给宿主，宿主写临时文件传给 `--cookies`，任务结束即删。
- **打开文件夹**：必须让命令行正好是 `explorer.exe /select,"<path>"`。走 `cmd /c` 会被 Node 的引号转义打乱，explorer 会退回"文档"目录；用 `execFile` + `windowsVerbatimArguments` 才无误。

## 日志与排障

| 位置 | 内容 |
|---|---|
| `%LOCALAPPDATA%\ytdlp-browser\host.log` | 宿主与弹窗诊断（`[client]` 开头的行来自弹窗） |
| `%LOCALAPPDATA%\ytdlp-browser\launcher.log` | 启动器：找没找到 node、子进程退出码、stderr |
| `%APPDATA%\yt-dlp\config` | yt-dlp 默认配置（下载目录、命名、mp4 合并、元数据） |

常见故障：

- **点图标没反应**：看 `launcher.log` 有没有 `launcher start`。没有 = 宿主没被调用（ID 不对或注册表未写）；有 = 看 `host.log` 的 `[client]` 行，弹窗会在 1.2 秒后上报它渲染出的状态。
- **宿主未连接**：`install.ps1 -ExtensionId <卡片ID>` 重跑。
- **图标本应报错但空白**：右键图标 → 审查弹出内容，看控制台。
- **下载报 Sign in to confirm you're not a bot**：cookie 没带上（站点未登录）或该站点登录态已失效。

## 已知限制

- 只在本机自用：带本地可执行组件，不适合上架 Chrome/Edge 商店。
- 依赖系统自带 .NET Framework 的 `csc.exe`、PATH 上的 `node.exe`，以及 `yt-dlp`（先找环境变量 `YTDLP_EXE`，其次 `~/.local/bin/yt-dlp.exe`，最后走 PATH）。
- 内核是 Chromium 118，较新的扩展 API 不可用（当前实现已避开）。
- cookies 是账号凭据，随消息只在本机进程间传递，不会写出到磁盘以外的地方（临时文件在 `%LOCALAPPDATA%\ytdlp-browser\cookies`，任务结束即删）。
