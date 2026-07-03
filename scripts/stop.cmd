@echo off
REM Double-click to stop WEBMANAGER on Windows
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*
pause
