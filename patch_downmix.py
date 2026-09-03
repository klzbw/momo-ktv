# Patch sep_once.py: downmix multichannel to stereo before Demucs
f = "C:/Users/Administrator/Desktop/ai-worker/sep_once.py"
c = open(f, encoding="utf-8").read()

old = """    print('PROGRESS 5', flush=True)
    import torch"""
new = """    print('PROGRESS 5', flush=True)
    import torch
    import torchaudio
    # Demucs only supports stereo; downmix multichannel (5.1/7.1) to stereo first
    info = torchaudio.info(src)
    if info.num_channels > 2:
        print(f'多声道音频({info.num_channels}ch)，降混为立体声', flush=True)
        wav, sr = torchaudio.load(src)
        # Simple average downmix to 2 channels
        left = wav[0::2].mean(dim=0, keepdim=True)
        right = wav[1::2].mean(dim=0, keepdim=True)
        stereo = torch.cat([left, right], dim=0)
        stereo_src = os.path.join(os.path.dirname(out_vocals), '_stereo_input.wav')
        os.makedirs(os.path.dirname(stereo_src), exist_ok=True)
        torchaudio.save(stereo_src, stereo, sr)
        src = stereo_src
        print(f'立体声临时文件: {stereo_src}', flush=True)"""

if old in c:
    c = c.replace(old, new)
    open(f, "w", encoding="utf-8").write(c)
    print("patched: multichannel downmix added")
else:
    print("pattern not found!")
    # show context
    idx = c.find("PROGRESS 5")
    print(c[idx-50:idx+200] if idx >= 0 else "PROGRESS 5 not found")