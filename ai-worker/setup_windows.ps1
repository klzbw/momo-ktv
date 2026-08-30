# ======================================================================
# 墨墨爱K歌 AI Worker —— Windows + NVIDIA 显卡 一键环境安装
# 在 ai-worker 文件夹里，右键“用 PowerShell 运行”，或在该目录打开 PowerShell 执行：
#   powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1
# 前提：已安装 Python 3.10/3.11（whisperx 对 3.12+ 兼容性一般，推荐 3.10）、
#       已安装最新 NVIDIA 驱动、已安装 ffmpeg（winget install Gyan.FFmpeg）。
# ======================================================================
$ErrorActionPreference = 'Stop'
Write-Host '== 1/4 创建独立虚拟环境 .venv（不污染系统 Python） ==' -ForegroundColor Cyan
if (-not (Test-Path '.venv')) { python -m venv .venv }
.\.venv\Scripts\python.exe -m pip install -U pip wheel setuptools

Write-Host '== 2/4 安装 GPU 版 PyTorch（CUDA 12.4，4070TiS 适用） ==' -ForegroundColor Cyan
.\.venv\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124

Write-Host '== 3/4 安装 Demucs / WhisperX / requests ==' -ForegroundColor Cyan
.\.venv\Scripts\python.exe -m pip install requests "demucs>=4.0.1" "whisperx>=3.3.1"

Write-Host '== 4/4 自检：CUDA 是否可用 ==' -ForegroundColor Cyan
.\.venv\Scripts\python.exe -c "import torch; print('torch', torch.__version__, 'CUDA可用=', torch.cuda.is_available(), torch.cuda.get_device_name(0) if torch.cuda.is_available() else '')"

Write-Host ''
Write-Host '安装完成。启动 worker（把地址改成你的 NAS 服务地址）：' -ForegroundColor Green
Write-Host '  .\.venv\Scripts\python.exe worker.py --server http://192.168.3.16:8083 --worker pc-51 --mode both' -ForegroundColor Yellow
Write-Host '首次运行会自动下载 htdemucs 分离模型和 Whisper/对齐模型（需要联网，约 3GB）。'
