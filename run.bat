@echo off
chcp 65001 >nul
title BIM 4D 模拟软件

echo ============================================================
echo   BIM 4D 模拟软件 - 启动脚本
echo ============================================================
echo.

REM ---- 进入后端目录 ----
cd /d "%~dp0backend"

REM ---- 检查 Python ----
python --version >nul 2>&1
if errorlevel 1 (
    echo [错误] 未检测到 Python，请先安装 Python 3.10+
    pause
    exit /b 1
)

REM ---- 安装依赖（首次运行）----
if not exist ".deps_installed" (
    echo [初始化] 首次运行，正在安装依赖...
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo.
        echo [错误] 依赖安装失败，请检查网络或手动运行：
        echo   python -m pip install -r requirements.txt
        pause
        exit /b 1
    )
    echo done > ".deps_installed"
    echo [初始化] 依赖安装完成！
    echo.
)

REM ---- 启动服务 ----
echo [启动] 后端服务启动中...
echo [启动] 浏览器请访问: http://localhost:8000
echo.
start /b "" cmd /c "timeout /t 3 >nul && start http://localhost:8000"
python main.py

pause
