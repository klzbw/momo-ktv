@echo off
chcp 65001 >nul
title 墨墨爱K歌 · AI 分离工作站
cd /d "%~dp0"

echo ============================================================
echo   墨墨爱K歌 · AI 分离工作站 启动中...
echo ============================================================
echo.

if not exist ".venv\Scripts\python.exe" (
    echo [错误] 未找到虚拟环境 .venv，请先运行 setup_windows.ps1 安装环境
    pause
    exit /b 1
)

echo 启动后请用浏览器打开: http://localhost:8765
echo 按 Ctrl+C 可停止工作站
echo.

".venv\Scripts\python.exe" station.py --port 8765 --server http://192.168.3.16:8083 --worker pc-51 --mode both --capability gpu --threads 2

pause
