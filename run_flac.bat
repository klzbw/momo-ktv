@echo off
cd /d C:\Users\Administrator\Desktop\ai-worker
echo ===== RUN START %date% %time% ===== >> flac_run.log
.venv\Scripts\python.exe -X utf8 flac_convert.py --mode cue --workers 20 --smb-user klzbw --smb-pass Dd112233 >> flac_run.log 2>&1
echo ===== RUN DONE exit=%errorlevel% %date% %time% ===== >> flac_run.log