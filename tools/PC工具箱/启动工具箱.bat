@echo off
chcp 65001 >nul
title MomoKTV PC Toolbox

cd /d "%~dp0"

echo ========================================
echo    MomoKTV - PC Toolbox v1.0.0
echo ========================================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found!
    echo Please install Python 3.10+ from:
    echo https://www.python.org/downloads/
    echo Remember to check "Add Python to PATH"
    echo.
    pause
    exit /b 1
)

python -c "import requests" >nul 2>&1
if errorlevel 1 (
    echo [INFO] First run, installing dependencies...
    python -m pip install --upgrade pip
    python -m pip install requests paramiko -i https://pypi.tuna.tsinghua.edu.cn/simple
    echo.
)

echo Starting toolbox...
python momo_toolbox.py

if errorlevel 1 (
    echo.
    echo [ERROR] Failed to start!
    echo If module missing, run install-dependencies.bat
    pause
)
