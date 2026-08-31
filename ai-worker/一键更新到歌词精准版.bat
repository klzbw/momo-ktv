@echo off
chcp 65001 >nul
title 墨墨爱K歌 AI工作站 - 更新到「歌词精准版」
cd /d %~dp0
echo ============================================
echo   墨墨爱K歌 - AI工作站 更新程序
echo   本次更新：官方歌词纠错（解决认错字/同音字/乱码）
echo ============================================
echo.
if not exist ".venv\Scripts\python.exe" (
  echo [错误] 没找到 .venv 虚拟环境，说明这台电脑还没做过首次环境安装。
  echo 请先在本目录打开 PowerShell 执行一次：
  echo    powershell -ExecutionPolicy Bypass -File .\setup_windows.ps1
  pause
  exit /b 1
)
echo [1/2] 安装/更新歌词纠错依赖 pypinyin（很小，约几 MB）...
".venv\Scripts\python.exe" -m pip install -U "pypinyin>=0.51.0"
if errorlevel 1 (
  echo [警告] 依赖安装失败，请检查网络后重试。
  pause
  exit /b 1
)
echo.
echo [2/2] 自检纠错模块能否正常加载...
".venv\Scripts\python.exe" -c "import lyric_matcher, pypinyin; print('lyric_matcher OK, pypinyin', pypinyin.__version__)"
if errorlevel 1 (
  echo [警告] 自检失败，请把本窗口截图发给开发者。
  pause
  exit /b 1
)
echo.
echo ============================================
echo   更新完成！
echo   1) 关闭旧的「启动AI工作站」黑窗口（Ctrl+C 或直接关）
echo   2) 重新双击「启动AI工作站.bat」即可生效
echo ============================================
pause
