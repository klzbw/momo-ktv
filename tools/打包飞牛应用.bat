@echo off
chcp 65001 >nul
title 墨墨爱K歌 - 飞牛NAS应用打包

cd /d "%~dp0\.."

echo ========================================
echo    墨墨爱K歌 - 飞牛NAS应用打包工具
echo ========================================
echo.

set VERSION=1.0.0
set PACKAGE_NAME=momo-ktv-fnos-%VERSION%.spk
set TEMP_DIR=%TEMP%\momo-ktv-package

echo [1/5] 清理临时目录...
if exist "%TEMP_DIR%" rmdir /s /q "%TEMP_DIR%"
mkdir "%TEMP_DIR%"

echo [2/5] 复制应用文件...
copy manifest "%TEMP_DIR%\manifest" >nul
xcopy cmd "%TEMP_DIR%\cmd\" /E /I /Y >nul
xcopy config "%TEMP_DIR%\config\" /E /I /Y >nul
xcopy wizard "%TEMP_DIR%\wizard\" /E /I /Y >nul
xcopy app "%TEMP_DIR%\app\" /E /I /Y >nul

echo [3/5] 复制文档...
mkdir "%TEMP_DIR%\docs"
xcopy docs "%TEMP_DIR%\docs\" /E /I /Y >nul
copy README.md "%TEMP_DIR%\README.md" >nul

echo [4/5] 创建版本信息...
echo { > "%TEMP_DIR%\package.json"
echo   "name": "momo-ktv", >> "%TEMP_DIR%\package.json"
echo   "display_name": "墨墨爱K歌", >> "%TEMP_DIR%\package.json"
echo   "version": "%VERSION%", >> "%TEMP_DIR%\package.json"
echo   "description": "局域网KTV点歌系统，手机扫码点歌，电视全屏播放", >> "%TEMP_DIR%\package.json"
echo   "maintainer": "MomoKTV", >> "%TEMP_DIR%\package.json"
echo   "port": 8083 >> "%TEMP_DIR%\package.json"
echo } >> "%TEMP_DIR%\package.json"

echo [5/5] 打包成SPK文件...
cd "%TEMP_DIR%"
tar -czf "%~dp0\%PACKAGE_NAME%" *

cd /d "%~dp0"

echo.
echo ========================================
echo    打包完成！
echo ========================================
echo.
echo 输出文件: %PACKAGE_NAME%
echo 输出路径: %~dp0
echo.
echo 安装方法：
echo 1. 把 %PACKAGE_NAME% 拷贝到飞牛NAS
echo 2. 打开飞牛应用商店，点击「手动安装」
echo 3. 选择 %PACKAGE_NAME% 文件
echo 4. 按照安装向导完成安装
echo.
echo 安装完成后访问: http://NAS_IP:8083
echo.

pause
