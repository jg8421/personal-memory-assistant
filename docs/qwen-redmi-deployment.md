# Windows / Redmi Qwen3-ASR部署

1. 先核对目标机麦克风、显卡、内存、OneDrive实际根路径和现有采集/暂停规则。若没有兼容NVIDIA GPU，不能照抄CUDA配置；CPU推理需额外验证处理速度是否赶得上录音。
2. 通过国内ModelScope直连下载 `Qwen/Qwen3-ASR-1.7B` 到本机模型目录，或从自己的OneDrive完整同步模型包。模型包含两个safetensors分片、索引、配置和分词器，约4.7GB。用SHA256清单检查全部文件，不用目录存在或小文件到达代替完整模型到达。
3. 用独立Python 3.11环境安装 `requirements-audio-qwen.txt`。PyPI国内镜像可用于一般依赖；CUDA版PyTorch可以从上海交大PyTorch wheels镜像取得。按目标Python版本/架构选择构建，验证镜像提供的SHA256，不能把CPU版PyTorch误当GPU版。下载时只在当前进程设置 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 为空及 `NO_PROXY=*`，不用VPN下载模型或依赖。
4. 安装运行包后确认 `torch.cuda.is_available()` 为真、显卡名称正确。环境和模型留本机，不把虚拟环境、模型缓存或CUDA运行库提交GitHub。
5. 先备份现有音频配置，将 `transcription.backend` 设为 `qwen3-asr`，`pythonPath` 指向新环境，`modelPath` 指向本地模型目录，`device` 根据实测选择 `cuda` 或 `cpu`。其余麦克风、输出、暂停、保留和能源策略按原设备设置保留。修改配置还需重新加载转写进程，状态中的backend/modelPath/device与配置一致才算生效。
6. 使用一段已知文字音频与一分钟静音核验：能识别内容、时间戳合理、吞吐满足需求；静音不新增OneDrive JSON/TXT，只有本机处理凭据。采集应继续运行，失败原音频保留；文字回执读回成功后才能删除对应缓存。
7. 检查连续新片段、GPU真实进程、积压数量和输出路径。配置已保存不等于开机恢复已验收，短测不等于24小时稳定；OneDrive本机写入、云端到达、目标机下载和模型加载分别报告。

Qwen时间戳采用VAD语音区间，不提供逐字对齐。必要时恢复已备份配置及原Python环境/模型，再重载转写；不要删除尚未处理的音频。不要为部署重置无关服务、改变系统代理或暂停其他应用的启动项。


## Intel XPU

See [Intel backend selection and measured rollout limits](intel-xpu-validation.md).
