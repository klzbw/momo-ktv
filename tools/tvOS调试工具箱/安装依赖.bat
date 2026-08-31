@echo off
chcp 65001 >nul
title 安装依赖 - tvOS调试工具箱

cd /d "%~dp0"

echo ========================================
echo    安装tvOS调试工具箱依赖
echo ========================================
echo.

echo [1/2] 升级pip...
python -m pip install --upgrade pip
echo.

echo [2/2] 安装核心依赖...
pip install requests
echo.

echo ========================================
echo    依赖安装完成！
echo ========================================
echo.
echo 双击 "启动工具箱.bat" 启动工具箱
echo.
pause
