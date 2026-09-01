@echo off
chcp 65001 >nul
title Install Dependencies

cd /d "%~dp0"

echo ========================================
echo    Install tvOS Toolbox Dependencies
echo ========================================
echo.

echo [1/2] Upgrading pip...
python -m pip install --upgrade pip
echo.

echo [2/2] Installing core dependencies...
pip install requests
echo.

echo ========================================
echo    Done! Double-click "start toolbox".
echo ========================================
pause
