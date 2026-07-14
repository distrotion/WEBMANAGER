@echo off
REM ===  WEBMANAGER - one-click service restart  ===
REM Double-click to restart the wm-manager (+ nginx) Windows services.
REM Elevates to admin automatically. Does NOT touch your PM2 apps.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart.ps1" %*
