# stremio-subsync · 字幕对齐

自建的 Stremio 字幕插件（addon）：从 OpenSubtitles 拿字幕，**按你正在播放的那个视频文件自动校正时间轴并按匹配度排序**，还能生成**中英双语**和 **AI 机翻中文**字幕。

A self-hosted Stremio subtitles addon that aligns OpenSubtitles subtitles to the exact video being played, ranks them, and adds bilingual / AI-translated Chinese tracks.

## 功能

- **自动对齐 + 排序**：用视频文件里自带的字幕轨（图形或文字字幕都行）当标准，为每个字幕拟合「帧率比例 × 时间 + 偏移」并分段微调。能校正固定偏移（如 DVD 加长版晚十几秒）和帧率不同导致的越播越偏（25 ↔ 23.976 fps）。菜单里第一个就是最准的，标签写明匹配度和做过的校正，例如 `✅ 最佳 98% · BluRay`、`✅ 已对齐 68% · 原偏移-15.4s · DVD`、`⚠️ 不匹配 39%`。
- **AI 翻译（可选）**：把最准的英文字幕翻成简体中文，提供 `🤖 中英双语` 和 `🤖 中文` 两条字幕。默认用 DeepSeek `deepseek-flash`（关闭思考模式）。整份字幕作为**同一段多轮对话**按时间顺序逐批翻译，每次请求都带上之前全部原文和译文，人名、称呼、梗前后一致；历史前缀逐字节不变，几乎全部命中服务商的上下文缓存。按时间轴每 20 分钟一段存盘（连同原始对话轮次），同一份字幕只花一次 token，中断后能用同样的缓存前缀续翻。
- **人工中英双语**：OpenSubtitles 上有能对齐的中文字幕时，自动与英文逐句合并成双语字幕。
- **自动预装（可选）**：自托管 stremio-web 时，可在网页里注入一段脚本，自动装好 Torrentio、MediaFusion 和本插件，并卸掉被本插件替代的 OpenSubtitles v3。

## 工作原理

1. Stremio 播放时向插件请求字幕，附带文件名、OpenSubtitles 哈希和文件大小。
2. 插件用同样的参数请求 OpenSubtitles v3（`opensubtitles-v3.strem.io`），拿到字幕列表。
3. 按文件大小和文件名，在同机的 Stremio streaming server（`127.0.0.1:11470`）里找到正在播放的文件，用 `ffprobe` 读出内嵌字幕轨前 10 分钟每句的时间。
4. 对英文、中文字幕逐个对齐打分（每个约 20 ms），结果缓存在 `/var/lib/stremio-subsync`。
5. 播放器选中某条字幕时，由 streaming server 的 `/subtitles.vtt?from=` 到插件取已校正的 SRT。

## 限制

- **对齐需要视频自带字幕轨**（很多 MKV 片源都带）。没有时不改时间，只按片源版本（BluRay/DVD、帧率）把更可能匹配的排前面，并标 `未对齐`。基于音量的人声检测对情景喜剧的笑声、配乐无效，会把准的字幕改错，所以音频对齐默认关闭（`ALIGN_AUDIO=1` 可试）。
- 必须和 Stremio streaming server 装在**同一台机器**上（要读正在播放的文件）。
- 第一次看某个视频时，需要先下载前约 10 分钟才能对齐完。AI 翻译是串行的：一集电视剧约 20 秒，两小时电影约一分半（前面的段先翻好）；请求字幕列表时就会在后台开始翻。播放器只加载一次字幕文件，若当时还没翻完，没翻到的句子先显示英文，切到别的字幕再切回来即可刷新。
- 只对英文和中文做对齐与翻译，其他语言原样透传。

## 实测

《老友记》S02E06（1080p BluRay x265，内嵌 12 条图形字幕）的 7 个英文字幕，对齐前后与内嵌字幕逐句（±0.4 s）比对的命中率：

| 字幕 | 对齐前 | 校正 | 对齐后 |
|---|---|---|---|
| 720p BluRay | 98% | 基本不动 | 98% |
| 未注明版本 | 16% | +0.4 s | 75% |
| 25 fps × 2 | 24–26% | 帧率 ×1.0427 | 75% |
| UNCUT DVDRip × 2 | 19–20% | −15.4 / −15.7 s | 68% |
| 其他版本 | 27% | — | 39%（标为不匹配） |

AI 翻译同一集 408 句（带上下文串行）：21 秒，6 次请求；输入里缓存命中 27.9k、未命中 5.9k tokens，输出 4.3k tokens。未命中部分和各批独立翻译时（6.2k）基本持平，多出来的全是按缓存价计费的历史。再次播放直接读缓存，0 次请求。

## 安装

要求：Linux + systemd、Node.js ≥ 20、ffmpeg/ffprobe、同机运行的 Stremio streaming server、一个 HTTPS 反向代理（示例为 nginx）。

```bash
git clone https://github.com/ghbhiee/stremio-subsync.git
cd stremio-subsync
sudo PUBLIC_BASE=https://media.example.com/subsync \
     DEEPSEEK_API_KEY=sk-... \
     NGINX_SNIPPET=/etc/nginx/snippets/stremio.conf \
     WEB_DIR=/srv/stremio-web/dy \
     ./deploy.sh
```

- `PUBLIC_BASE`（必填）：插件对外的地址前缀，路径部分会成为 nginx 的 location。
- `DEEPSEEK_API_KEY`：填了才启用 AI 翻译，保存在 `/etc/stremio/subsync.env`（权限 640），不会打印。
- `NGINX_SNIPPET`：一个已被 HTTPS server 块 include 的 nginx 文件，脚本会追加 `examples/nginx-subsync.conf` 并在 `nginx -t` 通过后 reload。不填就手动把示例加进你的配置。
- `WEB_DIR`：自托管 stremio-web 的目录，填了才注入自动预装脚本。

装好后，在 Stremio 的 Addons 页面安装 `PUBLIC_BASE/<SUBSYNC_TOKEN>/manifest.json`，token 在 `/etc/stremio/subsync.env` 里。**这个地址本身就是访问凭证，不要公开。** 其余配置项见 `examples/subsync.env.example`。

升级：`git pull` 后用同样的命令再跑一次 `deploy.sh`（幂等，已有的 token 和 key 保留）。

## License

MIT
