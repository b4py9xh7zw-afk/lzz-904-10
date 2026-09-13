# 运动视频慢动作预览器

上传一段动作视频，选择 **降速比例 / 补帧提示 / 清晰度 / 裁剪时间段**，后端调用 ffmpeg 生成短预览；页面展示 **执行的命令、耗时、错误摘要**。

零 npm 依赖（Node.js ≥ 18 原生实现），Windows 10 开箱即用。

## 快速开始（Win10）

1. 安装 [Node.js ≥ 18](https://nodejs.org/)
2. 下载 ffmpeg：到 <https://www.gyan.dev/ffmpeg/builds/> 下载 `ffmpeg-release-essentials.zip`，解压到例如 `C:\ffmpeg`
3. 启动：
   ```bat
   node server.js
   ```
4. 浏览器打开 <http://localhost:8321>，展开「⚙️ 设置」，把 ffmpeg 路径改为：
   ```
   C:\ffmpeg\bin\ffmpeg.exe
   C:\ffmpeg\bin\ffprobe.exe
   ```
   点「保存并测试」，显示绿色 ✅ 即可使用。

> 路径也可以直接写在 `config.json` 里（首次启动后自动生成）：
> ```json
> { "ffmpegPath": "C:\\ffmpeg\\bin\\ffmpeg.exe", "ffprobePath": "C:\\ffmpeg\\bin\\ffprobe.exe" }
> ```

## 功能说明

| 参数 | 说明 |
|---|---|
| 裁剪时间段 | 开始/结束秒数，单次预览最长 `maxSegmentSeconds`（默认 15s，超出自动截断） |
| 降速比例 | 0.1× ~ 1.0×，视频 `setpts` 拉长时间轴，音频用 `atempo` 链同步变速 |
| 补帧提示 | 不补帧 / 快速(bilog) / 均衡(bidir) / 高质量(ESA+vsbmc)，对应 `minterpolate` 预设；目标帧率默认取源帧率 |
| 清晰度 | 源分辨率 / 1080p / 720p / 480p（`scale=-2:高度`） |
| 保留音频 | 取消勾选则输出 `-an` 无声视频 |

结果区展示：状态、完整 ffmpeg 命令（可复制）、后端耗时与请求总耗时、错误摘要（失败时）、ffmpeg 输出尾部、在线预览与下载。

## 配置项（config.json）

| 键 | 默认 | 说明 |
|---|---|---|
| `ffmpegPath` / `ffprobePath` | `ffmpeg` / `ffprobe` | 可执行文件路径，Win10 填绝对路径 |
| `port` / `host` | `8321` / `0.0.0.0` | 监听地址（环境变量 `PORT` 可覆盖端口） |
| `maxUploadMB` | `300` | 上传大小上限 |
| `maxSegmentSeconds` | `15` | 单次预览片段最长秒数 |
| `jobTimeoutSeconds` | `600` | ffmpeg 任务超时 |
| `previewTtlMinutes` | `120` | 预览文件自动清理周期（0 = 不清理） |

## API

- `GET  /api/config` — 读取配置 + ffmpeg/ffprobe 可用性检测
- `POST /api/config` — 保存配置（JSON），返回检测结果
- `POST /api/preview` — multipart 上传（`video` + `speed/interpolation/resolution/start/end/keepAudio/targetFps`），返回 `{ ok, command, elapsedMs, errorSummary, stderrTail, previewUrl, warnings, probe, params }`
- `GET  /previews/<file>` — 预览文件（支持 Range）
- `DELETE /api/previews` — 清理全部预览文件

## 测试

```bash
# 需要可用的 ffmpeg；非 PATH 安装时用环境变量指定
TEST_FFMPEG=/path/to/ffmpeg npm test
```

## 目录

```
server.js          后端服务（路由/上传/任务执行）
src/config.js      配置读写
src/ffmpeg.js      命令构造、进程执行、错误摘要
src/multipart.js   multipart 解析
public/            前端页面
previews/          生成的预览（自动清理）
uploads/           上传临时文件（用完即删）
```
