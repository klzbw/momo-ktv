# 墨墨爱K歌 · AI 分离工作站（ai-worker）

跑在**带 NVIDIA 显卡的 Windows 电脑**上，负责两件吃 GPU 的活：

1. **人声分离**（Demucs / htdemucs）：把一首普通音频拆成 `人声 vocals.wav` 和 `伴奏 accompaniment.wav`，
   这样原本只有一条混音的 MP3/FLAC 也能像双音轨 MKV 一样切换「原唱 / 半消 / 伴奏」。
2. **逐字歌词对齐**（Whisper + WhisperX）：自动识别歌词并给**每个字**打时间戳，电视上可以逐字变色。

它本身不存歌、不播歌，只是不停地向 NAS 上的服务端「领任务 → 下载歌曲 → GPU 运算 → 回传产物」。

---

## 一、准备（只做一次）

1. 安装 **Python 3.10 或 3.11**（勾选 Add to PATH；WhisperX 对 3.12+ 兼容性一般）。
2. 安装最新 **NVIDIA 显卡驱动**。命令行执行 `nvidia-smi` 能看到你的 4070 Ti SUPER 即可。
3. 安装 **ffmpeg**：管理员 PowerShell 执行 `winget install Gyan.FFmpeg`，装完**重开**窗口。
4. 把整个 `ai-worker` 文件夹拷到这台电脑（或 `git clone` 仓库后进入该目录）。

## 二、一键装环境

在 `ai-worker` 目录打开 PowerShell，执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1
```

它会：建独立虚拟环境 `.venv` → 装 **CUDA 版 PyTorch**（GPU 加速，关键！）→ 装 Demucs/WhisperX。
最后自检会打印 `CUDA可用= True` 和你的显卡名。**第一次运行分离/对齐时会自动下载模型（约 3GB，需联网，只下一次）。**

## 三、启动 worker（要分离时一直开着）

```powershell
.\.venv\Scripts\python.exe worker.py --server http://192.168.3.16:8083 --worker pc-51 --mode both
```

- `--server` 填你 NAS 上墨墨爱K歌服务端的地址（局域网 IP:端口；走反代也可填 https 域名）。
- `--worker` 给这台机器起个名字（多台机器各起一个，能在任务里看到是谁处理的）。
- `--mode`：`both`=先分离后对齐（默认）；`separate`=只分离；`align`=只做逐字歌词。

看到 `队列空闲，等待新任务...` 就是正常待命。

## 四、在服务端给歌曲派活

- 批量把「还没分离的音频」加入队列（例如一次 500 首）：
  ```
  POST http://192.168.3.16:8083/api/separate/enqueue-missing?type=separate&limit=500
  ```
  逐字歌词把 `type=separate` 换成 `type=align`。
- 看进度：浏览器打开 `http://192.168.3.16:8083/api/separate/stats`。
- worker 会自动一首首领走处理；中途关掉 worker 也没关系，超过 20 分钟没完成的任务会自动重新排队。

## 五、速度参考（4070 Ti SUPER 16G）

- 人声分离（htdemucs, two-stems）：一首 4 分钟的歌约 **15~30 秒**。
- 逐字对齐（large-v3, float16）：一首约 **20~40 秒**（含模型已加载）。
- 3 万首建议夜间挂机分批跑；`enqueue-missing` 的 `limit` 控制每批数量。

## 文件说明

| 文件 | 作用 |
|---|---|
| `worker.py` | 常驻调度：领任务、下载、调子进程、回传（不含深度学习，很轻） |
| `sep_once.py` | 单首人声分离子进程（Demucs），跑完即退、释放显存 |
| `align_once.py` | 单首逐字对齐子进程（WhisperX），输出增强 LRC |
| `setup_windows.ps1` | 一键装环境 |
| `requirements.txt` | Python 依赖（torch 请走 setup 脚本装 CUDA 版） |

## 常见问题

- **打印 `CUDA可用= False`**：装成了 CPU 版 torch。重跑 setup，或手动
  `.\.venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124 --force-reinstall`。
- **下载模型慢/失败**：HuggingFace 在国内可能慢，可设置镜像 `$env:HF_ENDPOINT="https://hf-mirror.com"` 再启动 worker。
- **某首失败**：服务端会记 `failed` 并继续下一首；`enqueue-missing` 会自动把 failed 的重新入队重试。
