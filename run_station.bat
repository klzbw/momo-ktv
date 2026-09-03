@echo off
chcp 65001 >nul
title 墨墨AI工作站 - 运行日志
cd /d "%~dp0"

echo ============================================================
echo   墨墨爱K歌 · AI 工作站服务运行中
echo   控制面板: http://localhost:8765
echo   按 Ctrl+C 停止服务
echo ============================================================
echo.

".venv\Scripts\python.exe" station.py --port 8765 --server http://192.168.3.16:8083 --worker pc-51 --mode both --capability gpu --threads 2 --autostart

echo.
echo ============================================================
echo   服务已退出，按任意键关闭此窗口
echo ============================================================
pause >nul
