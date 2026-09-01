@echo off
chcp 65001 >nul
title Install Dependencies

cd /d "%~dp0"

echo ========================================
echo    Install PC Toolbox Dependencies
echo ========================================
echo.

echo [1/3] Upgrading pip...
python -m pip install --upgrade pip
echo.

echo [2/3] Installing core dependencies...
pip install requests paramiko
echo.

echo [3/3] Installing AI dependencies (optional, large)...
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install demucs whisperx
echo.

echo ========================================
echo    Done! Double-click "start toolbox".
echo ========================================
pause
