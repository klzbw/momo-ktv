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

## 三、可视化工作站控制面板（推荐）

自带 **Web 可视化界面**，浏览器打开后可一键启动/停止、滑块调节并发线程、实时监控每个线程的任务进度、GPU 显存/温度、滚动日志。零额外依赖（纯 Python 标准库）。

### 启动方式

**双击 `启动工作站.bat`**，或命令行执行：

```powershell
.\.venv\Scripts\python.exe station.py --port 8765 --server http://192.168.3.16:8083 --worker pc-51 --mode both --capability gpu --threads 2
```

然后浏览器打开 **http://localhost:8765**（局域网其他设备也可通过 `http://<本机IP>:8765` 访问）。

### 界面功能

| 模块 | 说明 |
|---|---|
| **顶部状态栏** | 运行/停止指示灯、一键启动/停止按钮、服务器信息 |
| **统计卡片** | 工作线程数、运行时长、完成任务数、失败任务数（实时刷新） |
| **线程控制** | 滑块 1~16 档 + 快捷按钮（1/2/4/6/8/12/16），点「应用」即时生效，**无需重启** |
| **GPU 监控** | 显卡型号、显存使用条、利用率、温度、算力模式（每 2 秒刷新） |
| **线程列表** | 每个线程一张卡片：状态（运行中/空闲）、当前歌曲名、分离/对齐类型、进度条、已用时间、完成/失败统计、最近错误 |
| **实时日志** | 滚动输出所有线程日志，支持自动滚动开关、暂停、清屏，错误行红色高亮 |

### 多线程说明

- **动态增减**：减少线程时，被撤的线程会**跑完当前歌曲后优雅退出**，不会中断正在分离的任务。
- **显存建议**：4070 Ti SUPER 16G 推荐 **2~3 线程**（htdemucs 两轨分离每进程约占 3~5GB）；4 线程以上需关注显存是否 OOM。
- **子进程隔离**：每首歌仍起独立 `sep_once.py` / `align_once.py` 子进程，跑完即退、显存彻底释放；多线程只是让多首歌**同时**跑，互不干扰。
- **命令行多线程**：不用可视化界面时，`worker.py` 也支持 `--threads N` 参数直接多线程运行。

### station.py 参数

```
--port        Web 面板端口（默认 8765）
--host        监听地址（默认 0.0.0.0，局域网可访问）
--server      服务端地址
--worker      Worker 名称
--mode        separate / align / both
--capability  gpu / cpu（不填自动探测）
--threads     启动时初始线程数（0=自动：GPU默认2，CPU默认4）
--autostart   启动面板时自动启动 Worker
```

---

## 四、命令行启动 worker（高级）

```powershell
.\.venv\Scripts\python.exe worker.py --server http://192.168.3.16:8083 --worker pc-51 --mode both --threads 2
```

- `--server` 填你 NAS 上墨墨爱K歌服务端的地址（局域网 IP:端口；走反代也可填 https 域名）。
- `--worker` 给这台机器起个名字（多台机器各起一个，能在任务里看到是谁处理的）。
- `--mode`：`both`=先分离后对齐（默认）；`separate`=只分离；`align`=只做逐字歌词。
- `--threads`：并发线程数（默认 GPU 模式 2，CPU 模式 4）。

看到 `队列空闲，等待新任务...` 就是正常待命。

## 五、在服务端给歌曲派活

- 批量把「还没分离的音频」加入队列（例如一次 500 首）：
  ```
  POST http://192.168.3.16:8083/api/separate/enqueue-missing?type=separate&limit=500
  ```
  逐字歌词把 `type=separate` 换成 `type=align`。
- 看进度：浏览器打开 `http://192.168.3.16:8083/api/separate/stats`。
- worker 会自动一首首领走处理；中途关掉 worker 也没关系，超过 20 分钟没完成的任务会自动重新排队。

## 六、速度参考（4070 Ti SUPER 16G）

- 人声分离（htdemucs, two-stems）：一首 4 分钟的歌约 **15~30 秒**。
- 逐字对齐（large-v3, float16）：一首约 **20~40 秒**（含模型已加载）。
- **多线程并发**：2 线程约 1.8 倍速，3 线程约 2.5 倍速（受显存上限约束）。
- 3 万首建议夜间挂机分批跑；`enqueue-missing` 的 `limit` 控制每批数量。

## 文件说明

| 文件 | 作用 |
|---|---|
| `station.py` | **可视化工作站控制面板**（Web UI，推荐）：启动/停止、线程调节、GPU监控、实时日志 |
| `启动工作站.bat` | 双击一键启动可视化工作站 |
| `worker.py` | 命令行常驻调度：领任务、下载、调子进程、回传（支持 `--threads` 多线程） |
| `sep_once.py` | 单首人声分离子进程（Demucs），跑完即退、释放显存 |
| `align_once.py` | 单首逐字对齐子进程（WhisperX），输出增强 LRC |
| `setup_windows.ps1` | 一键装环境 |
| `requirements.txt` | Python 依赖（torch 请走 setup 脚本装 CUDA 版） |

## 常见问题

- **打印 `CUDA可用= False`**：装成了 CPU 版 torch。重跑 setup，或手动
  `.\.venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124 --force-reinstall`。
- **下载模型慢/失败**：HuggingFace 在国内可能慢，可设置镜像 `$env:HF_ENDPOINT="https://hf-mirror.com"` 再启动 worker。
- **某首失败**：服务端会记 `failed` 并继续下一首；`enqueue-missing` 会自动把 failed 的重新入队重试。
- **多线程报 CUDA out of memory**：线程开太多了。在可视化面板把线程数降到 2~3，或命令行用 `--threads 2`。htdemucs 两轨分离每进程约占 3~5GB 显存。
- **减少线程后任务会中断吗？**：不会。被撤的线程会**跑完当前歌曲**后再退出，正在分离的任务不受影响。
- **可视化面板打不开**：确认 `station.py` 已启动，浏览器访问 `http://localhost:8765`；端口被占用时用 `--port 8766` 换端口。
