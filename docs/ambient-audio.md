# Windows 连续环境录音

此功能由 Personal Memory 托盘单独管理，不依赖记忆导入、转写或云端服务。需要 Windows、Node.js 和包含 DirectShow 的 FFmpeg。通用安装默认不启用；仅在本机明确配置后录音。

在安装目录创建 `ambient-audio.config.json`，指定 `enabled: true`、`nodePath`、`ffmpegPath`、`device`（FFmpeg DirectShow 麦克风名称）、`outputDir`、`segmentSeconds: 600`、`minFreeBytes: 10737418240`，然后重开托盘。

可从仓库的 `ambient-audio.config.example.json` 复制到安装目录并改名。示例默认 `enabled: false`，示例路径和设备名均为占位值；启用前必须按本机情况填写。可用 `ffmpeg -list_devices true -f dshow -i dummy` 查看设备名。只在安装目录保存真实配置，不提交它。

- 持续录制麦克风音频，含静音；48 kHz 单声道，默认每10分钟分段。同一采集进程先写临时 WAV，闭合的片段在后台无损压缩为 FLAC，成功后移除该临时 WAV，无分段重启间隙。
- 录音按本机日期存放。录音不写入记忆数据库、不上传、不自动转写、不自动删除。
- 托盘显示 `Audio: REC / PAUSED / STARTING / RETRY / DISK FULL / ERROR`，右键可暂停/恢复、打开录音文件夹、查看状态。
- 录音进度停滞超过45秒后重连；进程异常退出后重启。首选输入不可用时使用第一个可用麦克风并显示切换提示。
- 空间低于保留值即停止，恢复空间后继续；旧文件保留。没有保留天数或自动清理策略，需自行归档。
- 使用现有托盘登录启动入口，不新增系统服务；启用时阻止自动睡眠，允许显示器关闭。退出托盘会停止录音。关机、手动睡眠、物理静音、权限阻止、设备断开均可能产生缺口。
- 正在写入的片段在正常暂停/退出时补全文件头并压缩。强制断电可能留下最后一段 `.capture.wav`，下次启动尝试压缩恢复；失败则保留原片段，不能保证未落盘数据。

状态文件为安装目录 `state/ambient-audio.json`，仅包含运行状态和文件路径；暂停标记为 `state/ambient-audio.paused`。默认不会监听任何音频网络接口。

## 可选：只留转写文字

在音频配置中设置 `transcription: {enabled: true, pythonPath: "本机Python", modelPath: "已下载的faster-whisper模型目录", language: "zh", outputDir: "本机转写目录"}`，将 `segmentSeconds` 改为60。

- 以16kHz单声道采集，每分钟临时WAV约1.92MB；同一采集进程连续分段。
- 使用本地faster-whisper small，默认CPU int8、2线程；可配置NVIDIA GPU优先。工作进程低优先级、强制离线，不自动下载模型或传音频到云端。
- 识别到非空人声文字后保存逐段JSON和每日TXT，带时间戳。文件落盘并读回成功后才删除对应音频；已有FLAC也按相同步骤处理。
- 转写失败保留音频缓存并重试，不把失败当作静音或成功。ASR与麦克风采集分开运行，暂停采集不等待ASR结束。
- 失败按文件持久化退避，不阻塞后续片段；文件内容变化后可提前重试。积压时每分钟优先处理一个最近闭合片段，同时顺序补转旧片段。重试状态保存在本机 `state/ambient-transcription-retries.json`，原始音频仅在文字保存读回成功后删除。
- 没有可识别文字的片段不生成同步目录内的JSON，也不创建或改写每日TXT，不再输出“未检测到可识别人声”。只向本机 `state/ambient-silence/YYYY-MM-DD.jsonl` 追加简短处理凭据，写入并读回成功后清理原音频；凭据失败则保留音频重试。整天无识别文字时不创建空白日稿。
- 根据模型/VAD识别结果决定是否跳过，不额外提高音量阈值以免过滤轻声讲话。自动转写会有错字、漏字；只有文字不能还原语气和非语音环境声，成功删除音频后无法回听校对。
- 状态中的 `lastProcessedAt` 和 `lastProcessingResult` 表示最近处理是否成功以及有无文字；`lastTranscribedAt` 仅在人声文字保存时更新，因此长时间无新日稿不等于停止录音。重建日稿时忽略历史空回执，全部非空文字继续保留；维护前应备份已有日稿，历史回执不自动删除。
- 转写文字通常远低于200MB/天。临时缓存及失败队列仍占空间；故障时通过托盘提示，不能声称磁盘零占用。

在独立Python环境中安装可选的 `requirements-audio.txt`；模型需由使用者事先准备在本机，工作进程只读取明确配置的本地模型目录。源码不包含模型、运行环境、录音、转写或实际保存路径。

转写的 `outputDir` 可以指向使用者自己的同步目录。此时文字会由使用者配置的同步客户端处理，原始音频缓存和模型仍应留在独立的本机路径。本地写入成功不代表云端到达；更换输出目录后需重新加载转写进程，或由操作方自行管理兼容路径。当前只录麦克风，不包含耳机内的系统播放音轨；独占设备模式可能与会议软件冲突。

## 可选：NVIDIA GPU优先转写

在 `transcription` 中设置 `device: "cuda"`、`computeType: "int8_float16"`、`fallbackToCpu: true`、`gpuRetrySeconds: 300`。未指定设备的旧配置仍使用CPU；`auto`同样表示先尝试GPU，再按配置回退。模型和转写路径不变，GPU仅负责本机计算。

Windows需要适合所装CTranslate2版本的CUDA/cuBLAS及cuDNN运行库。目前CTranslate2 4.8系列配套CUDA 12与cuDNN 9。可在 `cudaLibraryDirs` 中列出本机库目录；只向工作进程添加搜索路径，不改系统PATH。也会检查 `CUDA_PATH/bin` 与安装目录的 `runtime/cuda-python/nvidia/cudnn/bin`。运行库、驱动和模型不得提交仓库。

GPU初始化失败或可捕获的CUDA推理错误会回退CPU INT8，并对当前片段重试；随后每5分钟在下一个任务开始时重新尝试GPU。无效音频仍保留在原重试队列，不把它当成GPU故障。状态 `state/ambient-transcriber.json` 标明实际设备、精度、回退原因和耗时；配置写cuda不代表当前一定使用GPU。进程原生崩溃仍由既有守护重启并保留音频，不承诺所有驱动故障均可在Python内回退。

切换前应对同一段有效语音进行CPU/GPU对比，再确认真实GPU进程、新转写落盘和录音连续性；短测不能替代24小时稳定性或准确率评测。GPU速度优势不保证逐字输出与CPU完全相同。

更换已下载的兼容模型（例如faster-whisper large-v3）时，将 `modelPath` 指向包含 `model.bin`、配置和分词器的本地目录，再重载转写进程。先验证真实语音推理及显存余量，不能仅以目录存在判断下载完整。运行状态同时报告实际加载的 `modelPath`，避免将刚修改的配置误认为已经生效；模型变更不会补转此前已删除原音频的历史文字。
