@echo off
chcp 65001 >nul
title 安装依赖 - 墨墨爱K歌PC工具箱

cd /d "%~dp0"

echo ========================================
echo    安装PC工具箱依赖
echo ========================================
echo.

echo [1/3] 升级pip...
python -m pip install --upgrade pip
echo.

echo [2/3] 安装核心依赖...
pip install requests paramiko
echo.

echo [3/3] 安装可选依赖（AI工作站）...
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install demucs whisperx
echo.

echo ========================================
echo    依赖安装完成！
echo ========================================
echo.
echo 双击 "启动工具箱.bat" 启动工具箱
echo.
pause
