#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify_deploy.py — 验证 NAS 上 auto-lyrics 模块加载和服务响应"""
import paramiko

NAS = ('192.168.3.16', 22)
USER, PASS = 'klzbw', 'Dd112233'
CONTAINER = 'momo-ktv'

def sudo_run(ssh, cmd, timeout=30):
    full = f"echo {PASS} | sudo -S {cmd}"
    stdin, stdout, stderr = ssh.exec_command(full, timeout=timeout)
    out = stdout.read().decode('utf-8', errors='replace')
    err = stderr.read().decode('utf-8', errors='replace')
    return out, err, stdout.channel.recv_exit_status()

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(NAS[0], port=NAS[1], username=USER, password=PASS)

print("=== 1. 验证 auto-lyrics 模块加载 ===")
node_code = (
    "const m=require('/app/server/auto-lyrics');"
    "console.log('exports:', Object.keys(m));"
    "console.log('enqueueMissingAlign:', typeof m.enqueueMissingAlign);"
    "console.log('afterScanAutoLyrics:', typeof m.afterScanAutoLyrics);"
)
out, err, rc = sudo_run(ssh, f"docker exec {CONTAINER} node -e \"{node_code}\"")
print(out)
if err and 'password' not in err.lower():
    print("STDERR:", err[:300])

print("\n=== 2. 验证服务响应 /api/lyrics/stats ===")
out, err, rc = sudo_run(ssh, f"docker exec {CONTAINER} wget -q -O- http://localhost:8080/api/lyrics/stats 2>&1 | head -c 600")
print(out)

print("\n=== 3. 检查容器运行状态 ===")
out, err, rc = sudo_run(ssh, f"docker ps --filter name={CONTAINER} --format 'table {{{{.Names}}}}\t{{{{.Status}}}}\t{{{{.Ports}}}}'")
print(out)

print("\n=== 4. 检查最近日志中有无 AutoLyrics 相关错误 ===")
out, err, rc = sudo_run(ssh, f"docker logs {CONTAINER} 2>&1 | grep -i 'autolyric\\|auto-lyric\\|error.*lyric' | tail -10")
if out.strip():
    print(out)
else:
    print("  (无 AutoLyrics 相关错误日志)")

ssh.close()
print("\n=== 验证完成 ===")
