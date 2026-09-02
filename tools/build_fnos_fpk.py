#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
墨墨爱K歌 · 飞牛 fnOS 第三方应用(.fpk) 一键打包脚本（跨平台，Windows/macOS/Linux 均可）

用法：
    python tools/build_fnos_fpk.py
在【仓库根目录】运行（能看到 manifest、cmd、wizard、app 这些目录）。
产物输出到 dist/momo-ktv-fnos-<version>.fpk。

说明：
- .fpk 本质是 tar.gz；飞牛安装时把 app/ 解压为 target(TRIM_APPDEST)，cmd/config/wizard
  放到对应系统目录。
- cmd/ 下生命周期脚本必须带可执行位，本脚本统一设为 0755（Windows 上手工压缩容易丢权限，
  这也是用 Python 而不是直接 tar 的原因）。
- 飞牛运行时是 `docker compose pull` 拉 GHCR 上的远程镜像，不需要 Dockerfile / server 源码 /
  web 构建上下文，因此 target 的 docker/ 里只保留 docker-compose.yml，包体更小更干净。
"""
import os, io, sys, tarfile, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'dist')


def read_version():
    mpath = os.path.join(ROOT, 'manifest')
    ver = '1.0.0'
    with open(mpath, 'r', encoding='utf-8') as f:
        for line in f:
            mm = re.match(r'\s*version\s*=\s*(.+?)\s*$', line)
            if mm:
                ver = mm.group(1)
    return ver


# 需要打进包的“白名单”路径（相对仓库根）。app/docker 只保留 compose。
def planned_files():
    files = []
    # 顶层身份文件
    for name in ('manifest', 'ICON.PNG', 'ICON_256.PNG', 'LICENSE'):
        if os.path.isfile(os.path.join(ROOT, name)):
            files.append(name)
    # 生命周期 / 配置 / 向导，整目录收录
    for d in ('cmd', 'config', 'wizard'):
        base = os.path.join(ROOT, d)
        for dp, _, fns in os.walk(base):
            for fn in sorted(fns):
                full = os.path.join(dp, fn)
                files.append(os.path.relpath(full, ROOT).replace('\\', '/'))
    # app/ui、app/config 整目录；app/docker 只留 compose
    for sub in ('ui', 'config'):
        base = os.path.join(ROOT, 'app', sub)
        if os.path.isdir(base):
            for dp, _, fns in os.walk(base):
                for fn in sorted(fns):
                    full = os.path.join(dp, fn)
                    files.append(os.path.relpath(full, ROOT).replace('\\', '/'))
    compose = 'app/docker/docker-compose.yml'
    if os.path.isfile(os.path.join(ROOT, compose)):
        files.append(compose)
    # 去重并排序，目录顺序由打包时自动补
    return sorted(set(files))


def main():
    if not os.path.isfile(os.path.join(ROOT, 'manifest')):
        sys.exit('未找到 manifest，请在仓库根目录运行本脚本')
    ver = read_version()
    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, f'momo-ktv-fnos-{ver}.fpk')

    rels = planned_files()
    # 补全所有父目录
    dirs = set()
    for r in rels:
        p = os.path.dirname(r)
        while p:
            dirs.add(p); p = os.path.dirname(p)

    with tarfile.open(out, 'w:gz') as tar:
        for d in sorted(dirs):
            ti = tarfile.TarInfo(d)
            ti.type = tarfile.DIRTYPE; ti.mode = 0o755; ti.mtime = 0
            ti.uid = ti.gid = 0; ti.uname = ti.gname = 'root'
            tar.addfile(ti)
        for r in rels:
            data = open(os.path.join(ROOT, r.replace('/', os.sep)), 'rb').read()
            ti = tarfile.TarInfo(r)
            ti.size = len(data); ti.mtime = 0
            ti.uid = ti.gid = 0; ti.uname = ti.gname = 'root'
            ti.mode = 0o755 if r.startswith('cmd/') else 0o644
            tar.addfile(ti, io.BytesIO(data))

    size = os.path.getsize(out) / 1024 / 1024
    print(f'打包完成: {out}  ({size:.2f} MB, {len(rels)} 个文件)')
    print('安装：飞牛应用中心 -> 手动安装 -> 选择该 .fpk -> 按向导完成')


if __name__ == '__main__':
    main()
