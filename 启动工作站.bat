@echo off
chcp 65001 >nul
title 墨墨爱K歌 · AI 工作站
cd /d "%~dp0"

echo ============================================================
echo   墨墨爱K歌 · AI 工作站 启动中...
echo ============================================================
echo.

if not exist ".venv\Scripts\python.exe" (
    echo [错误] 未找到虚拟环境 .venv
    pause
    exit /b 1
)

echo [1/3] 启动工作站服务...
start "墨墨AI工作站 - 运行日志" /D "%~dp0" run_station.bat

echo [2/3] 等待服务就绪（检测端口 8765，最多30秒）...
set /a waited=0
:waitloop
timeout /t 2 /nobreak >nul
set /a waited+=2
netstat -ano | findstr ":8765.*LISTENING" >nul 2>nul
if %errorlevel%==0 goto ready
if %waited% geq 30 goto timeout
goto waitloop

:ready
echo       服务已就绪（用时 %waited% 秒）
goto openbrowser

:timeout
echo       警告：30秒内未检测到服务，仍尝试打开浏览器

:openbrowser
echo [3/3] 自动打开浏览器...
start "" "http://localhost:8765"

echo.
echo ============================================================
echo   工作站已启动！
echo   本机访问: http://localhost:8765
echo   局域网:   http://192.168.3.51:8765
echo   停止方式: 在「运行日志」窗口按 Ctrl+C
echo ============================================================
echo.
echo 本窗口可关闭，不影响工作站运行。
pause
