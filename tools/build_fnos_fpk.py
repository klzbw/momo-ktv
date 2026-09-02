#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
墨墨爱K歌 · 飞牛 fnOS 安装包(.fpk) 一键打包脚本（官方 fnpack 流程）

为什么必须这样打：
  飞牛 .fpk 不是普通压缩包——官方 fnpack 工具会：
    1) 校验 manifest / config / 必备生命周期脚本；
    2) 把 app/ 目录单独压成内部 app.tgz（手工平铺 app/ 会导致飞牛提示
       “应用包不符合系统要求”而无法安装）；
    3) 自动计算并写入 manifest 的 checksum。
  所以本脚本只负责“组装一个干净的飞牛运行子集到临时目录”，真正的打包交给 fnpack。

用法：
    python tools/build_fnos_fpk.py            # 在仓库根目录运行
产物：
    dist/MomoKTV-fnos-<version>.fpk
"""
import os, sys, json, shutil, subprocess, platform, urllib.request, ssl, tempfile

FNPACK_VER = "1.2.3"
FNPACK_BASE = "https://static2.fnnas.com/fnpack/fnpack-{ver}-{plat}"
# 只把“飞牛运行所需”的子集放进安装包；app/docker 下的 server/web 是云端镜像
# 构建上下文，飞牛是 pull 现成镜像，绝不打进 fpk（否则包会臃肿几十 MB）。
PICK_FILES = [
    "manifest", "ICON.PNG", "ICON_256.PNG",
]
PICK_DIRS = ["config", "cmd", "wizard", "app/ui"]
PICK_SINGLE = ["app/docker/docker-compose.yaml"]


def fnpack_binary():
    """返回可用的 fnpack 路径；不存在则按当前平台下载到 tools/.bin。"""
    sysname = platform.system()
    machine = platform.machine().lower()
    if sysname == "Windows":
        plat, exe = "windows-amd64", ".exe"
    elif sysname == "Darwin":
        plat, exe = ("darwin-arm64" if machine in ("arm64", "aarch64") else "darwin-amd64"), ""
    else:
        plat, exe = ("linux-arm64" if machine in ("arm64", "aarch64") else "linux-amd64"), ""
    here = os.path.dirname(os.path.abspath(__file__))
    bindir = os.path.join(here, ".bin")
    os.makedirs(bindir, exist_ok=True)
    binpath = os.path.join(bindir, f"fnpack{exe}")
    if os.path.isfile(binpath) and os.path.getsize(binpath) > 0:
        return binpath
    url = FNPACK_BASE.format(ver=FNPACK_VER, plat=plat)
    print(f"[fnpack] 首次使用，下载官方打包工具: {url}")
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={"User-Agent": "momo-build"})
    with urllib.request.urlopen(req, context=ctx, timeout=120) as r, open(binpath, "wb") as f:
        shutil.copyfileobj(r, f)
    if sysname != "Windows":
        os.chmod(binpath, 0o755)
    print(f"[fnpack] 已下载: {binpath}")
    return binpath


def stage_sources(root, stage):
    def copy(rel):
        s, d = os.path.join(root, rel), os.path.join(stage, rel)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy2(s, d)

    for rel in PICK_FILES + PICK_SINGLE:
        if not os.path.isfile(os.path.join(root, rel)):
            sys.exit(f"缺少必需文件: {rel}")
        copy(rel)
    for d in PICK_DIRS:
        sdir = os.path.join(root, d)
        if not os.path.isdir(sdir):
            sys.exit(f"缺少必需目录: {d}")
        for dirpath, _, files in os.walk(sdir):
            for fn in files:
                rel = os.path.relpath(os.path.join(dirpath, fn), root).replace(os.sep, "/")
                copy(rel)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根
    fnpack = fnpack_binary()
    version = "0.0.0"
    with open(os.path.join(root, "manifest"), encoding="utf-8") as f:
        for line in f:
            if line.split("=", 1)[0].strip() == "version":
                version = line.split("=", 1)[1].strip()
    stage = tempfile.mkdtemp(prefix="momo-fpk-stage-")
    try:
        stage_sources(root, stage)
        print("[fnpack] 执行官方校验+打包 ...")
        subprocess.run([fnpack, "build", "-d", stage], check=True, cwd=stage)
        produced = os.path.join(stage, "momo-ktv.fpk")
        if not os.path.isfile(produced):  # Windows 下可能落在调用方 cwd
            produced = os.path.join(os.getcwd(), "momo-ktv.fpk")
        dist = os.path.join(root, "dist")
        os.makedirs(dist, exist_ok=True)
        out = os.path.join(dist, f"MomoKTV-fnos-{version}.fpk")
        shutil.copyfile(produced, out)
        print(f"\n✅ 打包完成: {out}  ({os.path.getsize(out)//1024} KB)")
    finally:
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    main()
