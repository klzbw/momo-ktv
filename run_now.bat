@echo off
cd /d C:\Users\Administrator\Desktop\ai-worker
.venv\Scripts\python.exe worker.py --server http://192.168.3.16:8083 --worker pc-51 --mode both --capability gpu >> worker_live.log 2>> worker_live_err.log

