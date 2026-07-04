@echo off
REM ===  WEBMANAGER - one-click Windows setup  ===
REM Double-click this file. It checks the system, installs everything,
REM and tells you if the panel is ready. (Elevates to admin automatically.)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
