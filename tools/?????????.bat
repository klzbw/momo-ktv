@echo off
chcp 65001 >nul
cd /d %~dp0..
echo ============================================================
echo   MomoKTV - Build fnOS .fpk (official fnpack)
echo ============================================================
where python >nul 2>nul || (echo [ERROR] Python not found. Install Python 3 first. & pause & exit /b 1)
python tools\build_fnos_fpk.py
echo.
pause