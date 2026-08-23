@echo off
rem ============================================================
rem  Install DocMaster as a real Windows service (boot start,
rem  no console, auto-restart). This needs Administrator rights,
rem  so it re-launches itself elevated (a UAC prompt appears).
rem ============================================================
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

cd /d "%~dp0.."
echo Installing DocMaster service...
node "scripts\service-install.js"
echo.
echo When done, manage it in services.msc (name: DocMaster) or with:
echo    sc stop DocMaster   /   sc start DocMaster
pause
