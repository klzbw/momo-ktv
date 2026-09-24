#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""hot_update.py — 热更新 momo-ktv 服务端歌词自动生成模块到 NAS Docker 容器"""
import base64, paramiko, os, sys, time

NAS = ('192.168.3.16', 22)
USER, PASS = 'klzbw', 'Dd112233'
CONTAINER = 'momo-ktv'
CONTAINER_SERVER_DIR = '/app/server'

LOCAL_DIR = r'C:\Users\Administrator\Doubao\chats\2026-09-24\new-chat\momo-ktv\server'
FILES = ['auto-lyrics.js', 'index.js', 'netktv-scan.js']

def sudo_run(ssh, cmd, timeout=60):
    """执行 sudo 命令，返回 (stdout, stderr, exit_code)"""
    full = f"echo {PASS} | sudo -S {cmd}"
    stdin, stdout, stderr = ssh.exec_command(full, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    return out, err, stdout.channel.recv_exit_status()

def main():
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(NAS[0], port=NAS[1], username=USER, password=PASS)
    sftp = ssh.open_sftp()

    print("=== 步骤1: 确认容器内 server 目录 ===")
    out, err, rc = sudo_run(ssh, f"docker exec {CONTAINER} ls {CONTAINER_SERVER_DIR}/auto-lyrics.js 2>&1; docker exec {CONTAINER} ls {CONTAINER_SERVER_DIR}/index.js 2>&1")
    print(out)
    if err and 'No such file' not in err:
        print("WARN:", err[:200])

    all_ok = True
    for fname in FILES:
        local_path = os.path.join(LOCAL_DIR, fname)
        remote_tmp = f'/tmp/{fname}'
        print(f"\n=== 更新 {fname} ===")

        # 1. SFTP 上传
        sftp.put(local_path, remote_tmp)
        print(f"  [SFTP] uploaded -> {remote_tmp}")

        # 2. docker cp 到容器
        out, err, rc = sudo_run(ssh, f"docker cp {remote_tmp} {CONTAINER}:{CONTAINER_SERVER_DIR}/{fname}")
        if rc != 0:
            print(f"  [docker cp] FAIL: {err[:300]}")
            all_ok = False
            continue
        print(f"  [docker cp] OK")

        # 3. 容器内 node --check
        out, err, rc = sudo_run(ssh, f"docker exec {CONTAINER} node --check {CONTAINER_SERVER_DIR}/{fname}")
        if rc != 0:
            print(f"  [node --check] FAIL: {err[:300]}")
            all_ok = False
        else:
            print(f"  [node --check] OK")

        # 4. 清理 /tmp
        ssh.exec_command(f"rm -f {remote_tmp}")

    sftp.close()

    if not all_ok:
        print("\n!!! 有文件语法检查失败，不重启容器 !!!")
        ssh.close()
        sys.exit(1)

    print("\n=== 步骤3: 重启容器使改动生效 ===")
    out, err, rc = sudo_run(ssh, f"docker restart {CONTAINER}", timeout=120)
    print(f"  restart exit={rc}")
    if out.strip(): print("  stdout:", out.strip()[:200])
    if err.strip(): print("  stderr:", err.strip()[:200])

    # 等待容器启动
    print("  等待容器启动 8秒...")
    time.sleep(8)

    print("\n=== 步骤4: 检查容器状态和最近日志 ===")
    out, err, rc = sudo_run(ssh, f"docker ps --filter name={CONTAINER} --format '{{{{.Names}}}} {{{{.Status}}}}'")
    print("  ", out.strip())
    out, err, rc = sudo_run(ssh, f"docker logs --tail 30 {CONTAINER} 2>&1")
    print("  最近日志:")
    for line in out.strip().split('\n')[-20:]:
        print("   ", line)

    ssh.close()
    print("\n=== 热更新完成 ===")

if __name__ == '__main__':
    main()
