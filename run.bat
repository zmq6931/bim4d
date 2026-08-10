@echo off
title BIM 4D Simulation

echo ============================================================
echo   BIM 4D Simulation - Starting...
echo ============================================================
echo.

REM ---- Enter backend directory ----
cd /d "%~dp0backend"

REM ---- Check Python ----
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Please install Python 3.10+
    echo Download: https://www.python.org/downloads/
    pause
    exit /b 1
)

echo [INFO] Python found.

REM ---- Install dependencies (first run only) ----
if not exist ".deps_installed" (
    echo [INFO] First run - installing dependencies...
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo.
        echo [ERROR] Dependency install failed. Try manually:
        echo   cd backend
        echo   python -m pip install -r requirements.txt
        pause
        exit /b 1
    )
    echo done > ".deps_installed"
    echo [INFO] Dependencies installed!
    echo.
)

REM ---- Start server ----
echo [INFO] Starting server at http://localhost:8000
echo [INFO] Press Ctrl+C to stop.
echo.

start http://localhost:8000
python main.py

pause
