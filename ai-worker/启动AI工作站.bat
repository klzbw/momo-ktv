@echo off
chcp 65001 >nul
title 墨墨爱K歌 - AI工作站

cd /d "%~dp0"

echo ========================================
echo    墨墨爱K歌 - AI工作站 图形化界面
echo ========================================
echo.

:: 检查是否有虚拟环境
if exist ".venv\Scripts\python.exe" (
    echo 使用虚拟环境启动...
    ".venv\Scripts\python.exe" gui.py
) else (
    echo 使用系统Python启动...
    python gui.py
)

if errorlevel 1 (
    echo.
    echo 启动失败！请检查：
    echo 1. 是否已安装Python 3.10
    echo 2. 是否已安装依赖（首次使用请运行「一键安装环境.bat」）
    echo.
    pause
)
