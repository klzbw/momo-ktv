@echo off
chcp 65001 >nul
title Install Dependencies

cd /d "%~dp0"

echo ========================================
echo    Install PC Toolbox Dependencies
echo ========================================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found! Please install Python 3.10+ first.
    pause
    exit /b 1
)

echo [1/3] Upgrading pip...
python -m pip install --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple
echo.

echo [2/3] Installing core dependencies...
python -m pip install requests paramiko -i https://pypi.tuna.tsinghua.edu.cn/simple
echo.

echo [3/3] Installing AI dependencies (optional, large ~3GB)...
echo Press Ctrl+C to skip if you do not need AI workstation.
python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
python -m pip install demucs whisperx -i https://pypi.tuna.tsinghua.edu.cn/simple
echo.

echo ========================================
echo    Done! Double-click "start toolbox".
echo ========================================
pause
