@echo off
REM Double-click to start WEBMANAGER on Windows
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
