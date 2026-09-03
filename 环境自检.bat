@echo off
chcp 65001 >nul
title 墨墨爱K歌 环境自检
echo ============================================
echo   分离工作站环境自检（缺什么会提示）
echo ============================================
echo.
echo [1] Python（需要 3.10 或 3.11）:
python --version 2>nul
if errorlevel 1 echo   !! 未检测到 Python，请到 https://www.python.org/downloads/ 装 3.11，安装时勾选 Add to PATH
echo.
echo [2] NVIDIA 显卡驱动:
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>nul
if errorlevel 1 echo   !! 未检测到 N 卡或驱动，4070TiS 请装最新 Game Ready/Studio 驱动
echo.
echo [3] ffmpeg:
ffmpeg -version 2>nul | findstr /C:"ffmpeg version"
if errorlevel 1 echo   !! 未检测到 ffmpeg，可在命令行执行： winget install Gyan.FFmpeg
echo.
echo [4] 是否已建虚拟环境:
if exist ".venv\Scripts\python.exe" (echo   已安装，可直接双击"启动AI工作站.bat") else (echo   尚未安装，请先运行 setup_windows.ps1)
echo.
echo 自检结束。把本窗口截图发回即可判断还缺什么。
pause
