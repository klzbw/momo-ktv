@echo off
chcp 65001 >nul
title 墨墨爱K歌 - 飞牛NAS应用打包

rem 在仓库根目录（本脚本的上一级）调用跨平台 Python 打包脚本，
rem 自动设置 cmd 生命周期脚本的可执行权限，产物输出到 dist\*.fpk
cd /d "%~dp0\.."

where python >nul 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Python，请先安装 Python 3 并勾选 Add Python to PATH。
    pause
    exit /b 1
)

python tools/build_fnos_fpk.py
echo.
pause
