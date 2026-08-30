#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
一键生成 Apple TV 背景墙(Top Shelf)所需的 4 张合规图片。

为什么需要它：Apple TV 首屏 App 上方的背景墙由 Assets.xcassets/AppIcon.brandassets
里两个 imageset 共 4 张图组成（标准 1x/2x + 宽屏 1x/2x），尺寸或命名只要有一张
不对，编译时就会被静默丢弃，表现为"换了背景墙、装到电视上却变灰/消失"。
本脚本把任意一张大图一次性等比裁剪缩放成全部 4 张、并放到正确目录、用正确文件名，
从根上杜绝漏图/错尺寸。

用法：
    pip install pillow
    python tools/make_topshelf.py 你的大图.jpg
可选第二参数指定输出根目录（默认 tvos-client/MomoKtvTV/Assets.xcassets/AppIcon.brandassets）
"""
import os, sys

try:
    from PIL import Image
except ImportError:
    sys.exit("缺少 Pillow，请先运行：pip install pillow")

# (输出相对路径, 宽, 高)
TARGETS = [
    ("Top Shelf Image.imageset/topshelf_std.png",      1920, 720),
    ("Top Shelf Image.imageset/topshelf_std_2x.png",   3840, 1440),
    ("Top Shelf Image Wide.imageset/topshelf.png",     2320, 720),
    ("Top Shelf Image Wide.imageset/topshelf_2x.png",  4640, 1440),
]

def cover_resize(img, w, h):
    """等比缩放后居中裁剪到 w×h（cover），保证不变形。"""
    iw, ih = img.size
    scale = max(w / iw, h / ih)
    nw, nh = max(1, round(iw * scale)), max(1, round(ih * scale))
    img = img.resize((nw, nh), Image.LANCZOS)
    left, top = (nw - w) // 2, (nh - h) // 2
    return img.crop((left, top, left + w, top + h))

def main():
    if len(sys.argv) < 2:
        sys.exit("用法：python tools/make_topshelf.py <输入大图> [输出根目录]")
    src = sys.argv[1]
    here = os.path.dirname(os.path.abspath(__file__))
    root = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        here, "..", "tvos-client", "MomoKtvTV", "Assets.xcassets", "AppIcon.brandassets")
    img = Image.open(src).convert("RGB")
    print(f"输入图尺寸：{img.size[0]} x {img.size[1]}（建议宽度≥4640）")
    for rel, w, h in TARGETS:
        out = os.path.join(root, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        cover_resize(img, w, h).save(out, "PNG")
        print(f"  生成 {rel}  {w}x{h}  ({os.path.getsize(out)//1024}KB)")
    print("完成：4 张背景墙已就位，直接提交并构建即可，CI 会再次校验尺寸。")

if __name__ == "__main__":
    main()
