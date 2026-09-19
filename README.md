# stremio-subsync · 字幕对齐

自建的 Stremio 字幕插件（addon）：从 OpenSubtitles 拿字幕，**按你正在播放的那个视频文件校正时间轴并按匹配度排序**，能合成**中英双语**字幕，也能用 AI 把英文字幕翻成中文。配套一段注入自托管 stremio-web 的脚本，在播放器里提供双语开关、一键对齐/生成、完成通知、点词查词和逐句快捷键。还能把整部片**预先下载到服务器**，之后从服务器直接播放，不再依赖种子。

A self-hosted Stremio subtitles addon that aligns OpenSubtitles subtitles to the exact video being played, ranks them, merges Chinese and English into bilingual tracks and machine-translates English into Chinese on demand, plus a web-player companion script (bilingual switch, notifications, click-to-look-up words, sentence navigation keys). It can also download whole videos to the server ahead of time and list them first among the streams, so playback no longer depends on the swarm.

## 功能

- **按需对齐 + 排序**：打开视频只列出字幕，不做任何处理；点「开始对齐」才用视频自带的字幕轨当标准，为每个英文/中文字幕拟合「帧率比例 × 时间 + 偏移」并分段微调。能校正固定偏移（如 DVD 加长版晚十几秒）和帧率不同导致的越播越偏（25 ↔ 23.976 fps）。视频没有自带字幕轨时（例如很多 MP4），改用**多字幕共识**。对齐过的视频下次打开时每种语言第一个就是最准的。列表保持干净：每条只写它是什么（`English · BluRay`、`中文 · 繁体 · WEB`），对齐正常或还没对齐的不加任何标记，只有对齐发现问题时才在第二行给出警告（`⚠️ 与视频不匹配 39%`、`⚠️ 与多数字幕不一致 83%`、`⚠️ 只含部分对白`）。
- **两个指标判断是否匹配**：覆盖度（参考字幕的每句开头，这条字幕里有没有对应）和同步度（这条字幕自己的每句开头，是不是落在参考字幕的句首上）。译制字幕常把两句并成一句，覆盖度只有 80% 左右但同步度在 95% 以上，这种算正常；同步度高而覆盖度很低的是只翻了外语片段的「部分对白」字幕。
- **AI 翻译（可选，手动触发）**：点「生成」把最准的英文字幕翻成简体中文。默认用 DeepSeek `deepseek-flash`（关闭思考模式），整份字幕作为同一段多轮对话按时间顺序逐批翻译，人名、称呼、梗前后一致，历史前缀逐字节不变以命中上下文缓存；按 20 分钟一段存盘，同一份字幕只花一次 token。模型偶尔在 JSON 后面多吐字或整批答非所问时，会截取第一个完整对象、再把这一批拆成两半重试。
- **菜单上方的工具条**：字幕菜单正上方外挂一条工具条（不占菜单里的位置），放「生成 AI 中文字幕」、「开始对齐」和进度、逐句暂停的开关和按键说明、「悬停字幕暂停」和「点词发音」两个选项。AI 字幕生成好之后，按钮变成「下载中英字幕」：保存成 `<片名>.en-zh.srt`，每句英文在上、AI 中文在下。
- **简体、繁体分开**：繁体中文单独成一个语言组（语言栏里显示「繁体中文」，排在「中文」后面），里面只有字幕本身。OpenSubtitles 的语言代码不可靠（繁体文件常标成 `chi`），所以文件下载到本地后按内容判断：数只在其中一种写法里出现的常用字。双语和「最佳中文」只从简体里选，不会再配到繁体字幕上；一部片只有繁体字幕时不提供人工双语，走 AI 字幕。
- **中英双语**：英文在上、中文在下，以英文字幕的断句为准。列表里只有两条：`🀄 中英双语（人工字幕）`（最佳英文配最佳人工中文）和 `🤖 中英双语（AI 字幕）`（AI 字幕生成之后才出现）。要看双语就在中文列表里选这两条之一；双语要把两条字幕配在一起，所以选中时一定会先对齐。最后一次手动选的是不是双语会被记住，下一部片选中文时自动套用一次。
- **不打断播放**：对齐、翻译都在后台跑，期间照常看（先用原始字幕）；完成后右上角弹通知，并把当前字幕换成对齐/翻译好的版本（播放器不能删字幕条目，被换掉的旧条目由脚本在菜单里隐藏，每条字幕只显示最新的一份）。如果发现正在看的字幕和视频不匹配而另一条匹配，会自动切到最佳的那条并提示。
- **英文第一、中文第二**：语言列表固定这个顺序，界面语言不用改。
- **点词查词**：鼠标停在字幕上自动暂停（可关），点英文单词弹出有道词典释义（音标、词性、中文）并读出这个词（有道的真人发音，由插件服务器代取并缓存；取不到时用浏览器自带的语音合成；🔊 重听，工具条里可关），配置了翻译模型时再补一行「这句话里的意思」和整句翻译；拖选多个词可以查短语。片源**内嵌的文字字幕**同样支持：脚本用 `video::cue` 隐藏浏览器的原生渲染，把当前字幕按播放器的样式自己画出来。
- **逐句快捷键**：显示字幕时（插件字幕或内嵌字幕都行）`A` 回到上一句、`S` 重听本句、`D` 下一句（没有字幕时这三个键保持 Stremio 原来的功能）；`E` 播放/暂停。
- **逐句暂停（精听）**：按 `Q` 打开后，每句字幕快播完时自动停住（停在句末前一点，字幕还留在屏幕上，可以继续点词），学完按 `D` 进入下一句，`S` 重听、`A` 上一句、`E` 直接继续。开关状态和每个按键的说明都在字幕菜单上方的工具条里（说明可以直接点，平板没有键盘也能用），画面上不加任何东西。状态记在浏览器里。
- **生词本**：点词弹窗右上角的「＋ 生词本」把单词连同音标、释义、句中意思、所在句子、片名和时间点一起保存；已保存的显示「✓ 已在生词本」，再点一次移除。播放器底部控制条多一个书本图标，点开后在右侧列出全部生词（可切换「全部 / 本片」、删除），点例句跳回那句话（不是当前影片时会先打开那部片）。**生词本存在服务器上、按用户分开**，见下面的「生词本的用户」。
- **下载到服务器（片库）**：播放时在字幕菜单上方的工具条点「下载到服务器」，或在影片详情页点顶栏的下载图标、在右侧面板里挑一个种子片源，服务器就在后台把整部片下完。做法是让本机的 streaming server 把这个文件从头读到尾（它会按顺序取齐所有分片并照常校验），所以**下载期间照常能看**：你播放的是同一个种子，和下载共用已经取到的分片；下载中的片子在片源列表里显示为「下载中 42% · 可边下边播」。下完之后，这部片的片源列表**第一条**就是「已下载 · 服务器本地」，从磁盘直接读，拖动秒开，做种的人都走了也能看；首页还多一个「已下载」目录。下载时会在片源自带的 tracker 之外补一批公共 tracker。任务状态落盘，服务重启后从断点继续；连接中断或长时间没数据会自动重试。面板里能看每个任务的进度、速度、连接数和剩余时间，看片库占用和磁盘剩余，取消下载或删除（删除要点两次确认）。片库有配额（默认 50 GB）并保证磁盘留有余量（默认 10 GB），超了就拒绝新任务。浏览器能直接播的文件（MP4 + H.264 + AAC）由网页服务器按 Range 直接发；其余（MKV、HEVC、AC3 等）仍经 streaming server 转封装，只是数据源换成了本地文件。从片库播放时字幕对齐读的也是本地文件。
- **修掉播放器反复重取同一分片的问题**：stremio-web 把 hls.js 的 `maxBufferHole` 设成了 0。x265 片源多数是 open-GOP，浏览器能解 HEVC 时 streaming server 直接转封装，每个分片交界处会留下零点几秒的空洞；`maxBufferHole` 为 0 时 hls.js 认为缓冲到此为止，于是每秒重新下载同一个分片，直到播放头自己越过空洞。我们的日志里 Chrome 下 80% 的视频分片请求是这种重复请求（一个分片最多被取了 1205 次），带宽小一点就表现为「完全播不动」。`deploy.sh` 会把自托管网页包里的这个值改回 hls.js 的默认值 0.5，并给脚本地址加版本参数让浏览器取到新文件。
- **原生客户端兜底**：没有注入脚本的 Stremio 客户端（Mac、手机、电视）在英文列表末尾能看到「▶ 对齐全部字幕」、中文列表末尾能看到「▶ 生成 AI 中文字幕」，选中即开始，稍后重新选一次字幕就能拿到结果。
- **自动预装（可选）**：自托管 stremio-web 时，注入脚本自动装好 Torrentio、MediaFusion 和本插件，并卸掉被本插件替代的 OpenSubtitles v3。

## 工作原理

1. Stremio 播放时向插件请求字幕列表，插件用同样的参数请求 OpenSubtitles v3，把所有中文变体归成一个「中文」组，按缓存里的对齐结果排序、打标签后返回。**列表请求不做任何处理。**
   Stremio 会先只带文件名请求一次、拿到哈希后再请求一次，而 stremio-web 按「插件地址 + 列表序号」给字幕编号、重复编号只保留先到的。插件会通过 streaming server 补算只带文件名请求的文件大小和哈希，让两次返回完全相同的列表。
2. 所有英文、中文字幕的 URL 都指向插件（`/sub/<视频>/<字幕>.srt`）：没对齐返回原始字幕，对齐完返回校正版；加 `?bi=1` 返回和最佳英文合并的双语版；`mt.srt` 是 AI 中文字幕。
3. 网页脚本（`subsync-ui.js`）通过 `/status/<视频>` 轮询进度，通过 `/action/<视频>` 触发对齐或翻译；完成后用播放器的 `addExtraSubtitlesTracks` 加一条新字幕并选中，实现不刷新页面的热替换。
4. 对齐时按文件大小和文件名，在同机的 Stremio streaming server（`127.0.0.1:11470`）里找到正在播放的文件（同一文件在多个种子里时选下载最多的那个），用 `ffprobe` 读内嵌字幕轨前 10 分钟每句的时间；没有内嵌字幕轨时用候选字幕的多数共识时间轴当参考。对英文、中文字幕逐个对齐打分（每个约 20 ms），结果缓存在 `/var/lib/stremio-subsync`。
5. 翻译和对齐可以并行：翻译只处理文本，出字幕时再套用对应英文字幕的对齐时间轴。翻译会等正在跑的对齐最多两分钟，好选中对齐分最高的英文字幕当源。
6. 查词走 `/dict?q=<词>&ctx=<句子>`：有道词典的公开接口给音标和释义，翻译模型（配置了才用）给语境释义和整句翻译，都查不到时退到 MyMemory。

## 限制

- **内嵌字幕轨是最可靠的参考**（很多 MKV 片源都带）。没有时用多字幕共识：它只能说明这些字幕彼此一致，不能保证和视频一致。候选太少或各说各的时不改时间。OpenSubtitles 的「按哈希匹配」标记和语言代码都可能不准，所以中文字幕会检查内容里是否真有汉字。基于音量的人声检测对情景喜剧的笑声、配乐无效，默认关闭（`ALIGN_AUDIO=1` 可试）。
- 必须和 Stremio streaming server 装在**同一台机器**上（要读正在播放的文件）。第一次对齐某个视频时需要先下载前约 10 分钟。
- 播放器给字幕的标签在加进菜单后不会再变，所以列表里只写缓存里已知的结果；本次会话里的进度和结果由网页脚本显示。原生客户端没有通知，选中「▶」条目后要过一会儿重选字幕。
- 有字幕显示时 `A`/`S`/`D` 被逐句导航占用，Stremio 原来的音频菜单、字幕菜单、统计菜单用工具栏按钮打开。
- 只对英文和中文做对齐、翻译与查词，其他语言原样透传。
- 部署会重启服务：正在跑的对齐/翻译会中断（磁盘缓存不丢），重新点一次即可。

## 实测

《老友记》S02E06（1080p BluRay x265，内嵌 12 条图形字幕）的 7 个英文字幕，对齐前后与内嵌字幕逐句（±0.4 s）比对的命中率：

| 字幕 | 对齐前 | 校正 | 对齐后 |
|---|---|---|---|
| 720p BluRay | 98% | 基本不动 | 98% |
| 未注明版本 | 16% | +0.4 s | 75% |
| 25 fps × 2 | 24–26% | 帧率 ×1.0427 | 75% |
| UNCUT DVDRip × 2 | 19–20% | −15.4 / −15.7 s | 68% |
| 其他版本 | 27% | — | 39%（标为不匹配） |

片源已经下载好时，这 7 条字幕从点「开始对齐」到通知弹出约 2 秒。AI 翻译同一集 408 句：约 20 秒、6 次请求；再次播放直接读缓存，0 次请求。

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
- `DEEPSEEK_API_KEY`：填了才启用 AI 翻译和语境释义，保存在 `/etc/stremio/subsync.env`（权限 640），不会打印。
- `NGINX_SNIPPET`：一个已被 HTTPS server 块 include 的 nginx 文件，脚本会追加 `examples/nginx-subsync.conf` 并在 `nginx -t` 通过后 reload。不填就手动把示例加进你的配置。
- `WEB_DIR`：自托管 stremio-web 的目录，填了才把预装脚本和播放器脚本（`subsync-ui.js`）挂进 `index.html`。不填也能用插件本身，只是没有开关、通知、查词、快捷键和生词本。
- `VOCAB_USER_HEADER`（可选）：你的登录网关通过反向代理传来的「当前用户」请求头名，见下一节。
- `LIBRARY_PUBLIC_BASE`（可选）：片库目录（`/var/lib/stremio-subsync/library`）由你的网页服务器直接对外提供时的地址前缀，例如 `https://media.example.com/library`，写法见 `examples/nginx-subsync.conf`（放在登录校验后面，nginx 自己处理 Range 和 sendfile）。注意 streaming server 转封装时是从本机去读这个地址的，没有登录 cookie，你的网关要像放行它读自己的流那样放行这个路径。不填则由插件进程在 token 路径下提供文件（`<PUBLIC_BASE>/<token>/lib/...`），功能一样。
- `LIBRARY_MAX_GB`（可选）：片库配额，默认 50。

装好后，在 Stremio 的 Addons 页面安装 `PUBLIC_BASE/<SUBSYNC_TOKEN>/manifest.json`，token 在 `/etc/stremio/subsync.env` 里。**这个地址本身就是访问凭证，不要公开。** 其余配置项见 `examples/subsync.env.example`。

升级：`git pull` 后用同样的命令再跑一次 `deploy.sh`（幂等，已有的 token 和 key 保留）。

**从 1.3 升到 1.4 要注意**：插件的 manifest 多了 `stream` 和 `catalog` 两种资源，而 Stremio 的用户档案里保存的是安装时的那份 manifest，不会自己更新。自托管网页端由预装脚本处理：发现服务器上的版本更新就原位升级，并且一次性把它自己装的 Torrentio、MediaFusion 挪到本插件后面（Stremio 的片源列表按插件安装顺序排，这样「已下载」才排第一）。其它客户端（Mac、手机、电视上的 Stremio）要手动卸载本插件再装一次；想让「已下载」排在最前，还得把种子类插件也卸载重装一遍，让它们排到后面。

### 生词本的用户

插件地址里只有一个共享的 token，分不出是谁，所以「用户」有两种来源（`/health` 的 `vocab` 字段显示当前是哪种）：

- **默认（`profile`）**：浏览器第一次用生词本时生成一个随机 ID 存在 localStorage，随请求带上，服务器按它分文件保存。不用任何配置；ID 猜不到，所以互相读写不了。缺点是一个浏览器一本，换设备或清掉浏览器数据就是另一本（旧文件还在服务器上）。
- **登录网关（`header`）**：站点前面有登录网关（nginx `auth_request`、Authelia、oauth2-proxy……）时，让反向代理校验登录后把用户名放进一个请求头，并设置 `VOCAB_USER_HEADER=<头名>`。此时没有这个头的请求一律 401，浏览器自报的 ID 不再起作用，同一个人在不同设备上是同一本。nginx 写法见 `examples/nginx-subsync.conf`：给 `/subsync/<token>/vocab` 单独一个带 `auth_request` 的 location，并在普通的 `/subsync/` location 里把这个头清空，防止客户端伪造。`VOCAB_NAME_HEADER` 可再传一个显示名（URL 编码）。

数据在 `<CACHE_DIR>/vocab/`，每个用户一个 JSON 文件（文件名是用户 ID 的哈希，权限 600）。同一个人有多个 ID 时，在 `<CACHE_DIR>/vocab/aliases.json` 里写 `{"p:1": "dad", "p:3": "dad"}`（`p:` 是网关给的 ID，`c:` 是浏览器 ID），它们就共用 `dad` 这一本，各自原来的生词在第一次访问时自动并入。

## 播放慢的时候先量什么

这次排查用到的办法，换一套部署也适用：

- **分片有没有被重复请求**：在反向代理的访问日志里数 `/hlsv2/<会话>/video0/segmentN.m4s`，同一个会话里同一个 N 出现几十上百次就是上面说的 `maxBufferHole` 问题。
- **每个请求花了多久、慢在哪一端**：给流媒体的 location 单独加一个带 `$request_time`、`$upstream_response_time`、`$tcpinfo_rtt`、`$tcpinfo_snd_cwnd` 的 `log_format`（只记 `$uri`，别把带 token 的查询串写进去）。RTT 高、拥塞窗口只有个位数，问题在观众那头的网络；`upstream_response_time` 高，问题在 streaming server 或种子。
- **服务器自己的链路**：streaming server 既要下载种子又要往外发，走 Wi-Fi 时两者共用空口时间。先看连的是不是 5 GHz，再用一个镜像站的大文件测下行。我们的机器重启后掉到 2.4 GHz，整条链路只有 30 Mbps。
- **种子本身**：streaming server 的 `/<infoHash>/<fileIdx>/stats.json` 里有 `peers`、`unchoked`、`downloadSpeed`。同一个种子用 aria2 对照下载一分钟，能看出是种子慢还是下载器连不上 peer。
- 远程观看时 `net.ipv4.tcp_congestion_control=bbr`、`net.ipv4.tcp_slow_start_after_idle=0` 对一片一片取的 HLS 有帮助。

## 接口（供二次开发）

都在 `PUBLIC_BASE/<token>/` 下：

| 路径 | 说明 |
|---|---|
| `manifest.json`、`subtitles/<type>/<id>/<extra>.json` | Stremio 插件协议 |
| `sub/<video>/<key>.srt[?bi=1][&dl=1]` | 字幕文件（`dl=1` 作为附件下载，文件名取视频名）；`key` 为 OpenSubtitles 字幕 id、`bi`（最佳英文 + 最佳人工中文）、`mt`（AI 中文，`?bi=1` 为 AI 双语）、`align` / `mt-start`（原生客户端的动作条目，排在英文列表末尾） |
| `status/<video>` | 对齐、翻译进度和每条字幕的结果 |
| `action/<video>`（POST JSON） | `{"align":true}`、`{"translate":true}`、`{"bilingual":true}`（对齐 + 翻译）、加 `"force":true` 用当前最佳英文重新翻译 |
| `dict?q=<词>&ctx=<句子>` | 查词 |
| `tts?q=<词或短语>[&accent=uk]` | 发音（mp3，取自有道 `dictvoice`，缓存在 `<CACHE_DIR>/tts/`） |
| `stream/<type>/<id>.json`、`catalog/<type>/subsync-library.json` | Stremio 插件协议：这部片在片库里的文件（下完的给本地地址，下载中的给种子片源），以及「已下载」目录 |
| `library` | 片库：`GET` 列出任务和占用 `{items[], usage{used,max,free}}`；`POST` JSON `{infoHash, fileIdx, sources[], filename, size, title, type, metaId, videoId, poster}` 新建下载（同一个文件再次提交返回原任务）；`DELETE library/<id>` 取消或删除；`POST library/<id>/retry` 重试失败的任务 |
| `lib/<id>/<文件名>` | 下好的文件，支持 Range（只在没设 `LIBRARY_PUBLIC_BASE` 时使用） |
| `vocab` | 生词本：`GET` 列出当前用户的生词；`POST` JSON `{word, phonetic, entries[], meaning, sentence, sentenceZh, title, time, video{id,type,metaId,href}}` 添加（同一个词再次提交是补全）；`DELETE ?word=<词>` 移除。用户来自 `VOCAB_USER_HEADER` 指定的头，或请求头 `X-Subsync-Profile`（16–64 位字母数字），都没有则 401 |

`<video>` 是列表里字幕 URL 中的 16 位视频键。

## License

MIT
