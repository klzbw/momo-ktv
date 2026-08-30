@echo off
chcp 65001 >nul
title 墨墨爱K歌 AI分离工作站
cd /d %~dp0
echo ============================================
echo   墨墨爱K歌 - AI 人声分离/逐字歌词 工作站
echo ============================================
if not exist ".venv\Scripts\python.exe" (
  echo [提示] 还没安装环境，先运行 setup_windows.ps1 一次。
  echo 方法：在本文件夹空白处按住 Shift + 右键 -^> 在此处打开 PowerShell，
  echo 然后执行： powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1
  pause
  exit /b
)
echo 正在连接 NAS 服务并开始处理任务，保持本窗口开着即可...
echo 按 Ctrl+C 可停止。
echo.
".venv\Scripts\python.exe" worker.py --server http://192.168.3.16:8083 --worker pc-51 --mode both
pause
