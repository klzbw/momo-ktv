@echo off
chcp 65001 >nul
title Install Dependencies

cd /d "%~dp0"

echo ========================================
echo    Install tvOS Toolbox Dependencies
echo ========================================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found! Please install Python 3.10+ first.
    pause
    exit /b 1
)

echo [1/2] Upgrading pip...
python -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
echo.

echo [2/2] Installing core dependencies...
python -m pip install requests -i https://pypi.tuna.tsinghua.edu.cn/simple
echo.

echo ========================================
echo    Done! Double-click "start toolbox".
echo ========================================
pause
