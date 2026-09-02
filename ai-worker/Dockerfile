# 墨墨爱K歌 · AI Worker（CPU 版）
# 任何 x86_64 的飞牛 NAS / Linux 主机都能跑，不需要显卡；Demucs/WhisperX 走 CPU，
# 速度较慢（分离一首约数分钟，视 CPU 而定），适合"没有 N 卡、也没有外置 PC 工作站、
# 愿意夜间挂机慢慢跑"的场景。有 N 卡请改用 Dockerfile.cuda。
FROM python:3.10-slim-bookworm

# ffmpeg：Demucs/Whisper 读写音频必需；build-essential：个别 pip  wheel 需要本地编译；
# curl：entrypoint 健康探测用。
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg curl ca-certificates build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先单独装 CPU 版 PyTorch（比默认 wheel 小，且明确不带 CUDA）；再装业务依赖。
# 用清华镜像加速国内构建；torch 走官方 CPU index。
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --upgrade pip \
    && python -m pip install --no-cache-dir torch torchaudio \
        --index-url https://download.pytorch.org/whl/cpu \
    && python -m pip install --no-cache-dir \
        -i https://pypi.tuna.tsinghua.edu.cn/simple \
        -r requirements.txt

# 业务代码（worker 调度 + 两个子进程脚本 + 歌词纠错）
COPY worker.py sep_once.py align_once.py lyric_matcher.py ./

# 模型缓存目录挂卷：首次运行会下载 Demucs/Whisper 模型（约 3GB，走 hf-mirror），
# 持久化后只下一次。
ENV HF_HOME=/models/hf \
    TORCH_HOME=/models/torch \
    HF_ENDPOINT=https://hf-mirror.com \
    MOMO_DEVICE=cpu \
    MOMO_CAPABILITY=cpu
VOLUME ["/models"]

COPY docker-entrypoint.sh /usr/local/bin/entrypoint
RUN chmod +x /usr/local/bin/entrypoint
ENTRYPOINT ["entrypoint"]
