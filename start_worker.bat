@echo off
cd /d "C:\Users\administrator\Desktop\ai-worker"
start "" ".venv\Scripts\pythonw.exe" worker.py --server http://192.168.3.16:8083 --worker pc-51 --mode both --capability gpu
exit

