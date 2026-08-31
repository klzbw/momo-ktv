# -*- coding: utf-8 -*-
"""
sep_once.py —— 单首歌的人声分离（被 worker.py 以子进程方式调用，跑完即退、释放显存）
用法: python sep_once.py <输入音频> <输出人声.wav> <输出伴奏.wav>
模型: htdemucs（Demucs v4 通用人声/伴奏分离，效果与速度均衡）
"""
import sys, os, glob, shutil, tempfile, traceback

# 国内直连 HuggingFace 常超时导致 Demucs 模型下载失败，默认走 hf-mirror 镜像（须在 import torch/demucs 前）
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')

def main():
    if len(sys.argv) < 4:
        print('用法: python sep_once.py <输入> <人声out.wav> <伴奏out.wav>'); sys.exit(2)
    src, out_vocals, out_accomp = sys.argv[1], sys.argv[2], sys.argv[3]
    if not os.path.exists(src):
        print('输入不存在:', src); sys.exit(2)

    print('PROGRESS 5', flush=True)
    import torch
    # PyTorch 2.6 默认 torch.load(weights_only=True)，Demucs/WhisperX 模型里的自定义类会被拒，提前加白名单
    try:
        torch.serialization.add_safe_globals(['omegaconf.listconfig.ListConfig'])
    except Exception:
        pass
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    print(f'使用设备: {device}' + (f' ({torch.cuda.get_device_name(0)})' if device == 'cuda' else ''), flush=True)

    # Demucs 延迟导入（import 较慢，且只在真正分离时加载）
    from demucs.separate import main as demucs_main
    work = tempfile.mkdtemp(prefix='demucs_')
    print('PROGRESS 15', flush=True)
    try:
        # --two-stems=vocals：只分出"人声"和"其余(伴奏)"两条，比四分轨省一半算力
        # -n htdemucs：模型名；-d：cuda/cpu；-o：输出目录
        demucs_main(['--two-stems', 'vocals', '-n', 'htdemucs', '-d', device, '-o', work, src])
        print('PROGRESS 85', flush=True)

        # Demucs 产物结构: <work>/htdemucs/<输入主名>/{vocals,no_vocals}.wav
        stem_dir = glob.glob(os.path.join(work, 'htdemucs', '*'))
        if not stem_dir:
            raise RuntimeError('Demucs 未产出结果目录: ' + work)
        d = stem_dir[0]
        voc = os.path.join(d, 'vocals.wav')
        noi = os.path.join(d, 'no_vocals.wav')  # no_vocals = 去掉人声后的伴奏
        if not (os.path.exists(voc) and os.path.exists(noi)):
            raise RuntimeError(f'缺少分离产物: {os.listdir(d)}')
        os.makedirs(os.path.dirname(out_vocals), exist_ok=True)
        shutil.move(voc, out_vocals)
        shutil.move(noi, out_accomp)
        print('人声 ->', out_vocals, flush=True)
        print('伴奏 ->', out_accomp, flush=True)
        print('PROGRESS 100', flush=True)
        print('SEP_DONE', flush=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)

if __name__ == '__main__':
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
