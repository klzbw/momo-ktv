#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import paramiko
NAS = ('192.168.3.16', 22)
USER, PASS = 'klzbw', 'Dd112233'
CONTAINER = 'momo-ktv'

def sudo_run(ssh, cmd, timeout=30):
    full = f"echo {PASS} | sudo -S {cmd}"
    stdin, stdout, stderr = ssh.exec_command(full, timeout=timeout)
    return stdout.read().decode('utf-8', errors='replace'), stderr.read().decode('utf-8', errors='replace'), stdout.channel.recv_exit_status()

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(NAS[0], port=NAS[1], username=USER, password=PASS)

# 用 node 发 HTTP 请求验证 API
node_http = (
    "const http=require('http');"
    "http.get('http://localhost:8080/api/lyrics/stats',r=>{"
    "let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log('STATUS',r.statusCode,d.slice(0,300)))"
    "}).on('error',e=>console.log('ERR',e.message));"
)
out, err, rc = sudo_run(ssh, f"docker exec {CONTAINER} node -e \"{node_http}\"")
print("=== /api/lyrics/stats ===")
print(out)
if err and 'password' not in err.lower() and err.strip():
    print("STDERR:", err[:200])

# 验证 enqueueMissingAlign 的 SQL 查询能正常执行（只查不入队）
node_check = (
    "const Database=require('better-sqlite3');"
    "const db=new Database('/data/momo-ktv.db',{readonly:true});"
    "const rows=db.prepare(\"SELECT COUNT(*) c FROM songs WHERE media_type='audio' AND (lyrics_word IS NULL OR lyrics_word='') AND align_status NOT IN ('pending','processing','done') AND (instrumental IS NULL OR instrumental=0)\").all();"
    "console.log('songs needing word lyrics:', rows[0].c);"
    "const total=db.prepare('SELECT COUNT(*) c FROM songs WHERE media_type=\\'audio\\'').get();"
    "console.log('total audio songs:', total.c);"
    "const hasWord=db.prepare(\"SELECT COUNT(*) c FROM songs WHERE lyrics_word IS NOT NULL AND lyrics_word<>''\").get();"
    "console.log('songs with word lyrics:', hasWord.c);"
)
out, err, rc = sudo_run(ssh, f"docker exec {CONTAINER} node -e \"{node_check}\"")
print("\n=== 数据库歌词覆盖率 ===")
print(out)
if err and 'password' not in err.lower() and err.strip():
    print("STDERR:", err[:200])

ssh.close()
