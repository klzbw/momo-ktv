@echo off
chcp 65001 >nul
title 墨墨爱K歌 - tvOS调试工具箱

cd /d "%~dp0"

echo ========================================
echo    墨墨爱K歌 - tvOS调试工具箱 v1.0.0
echo ========================================
echo.

:: 检查Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到Python！
    echo.
    echo 请先安装Python 3.10+：
    echo 下载地址: https://www.python.org/downloads/
    echo 安装时请勾选 "Add Python to PATH"
    echo.
    pause
    exit /b 1
)

:: 检查依赖
python -c "import requests" >nul 2>&1
if errorlevel 1 (
    echo [提示] 首次运行，正在安装依赖...
    echo.
    pip install requests
    echo.
    echo 依赖安装完成！
    echo.
)

:: 启动工具箱
echo 正在启动tvOS调试工具箱...
python tvos_debug_toolbox.py

if errorlevel 1 (
    echo.
    echo [错误] 工具箱启动失败！
    echo.
    echo 请检查：
    echo 1. Python版本是否为3.10+
    echo 2. 是否安装了依赖（运行 安装依赖.bat）
    echo.
    pause
)
