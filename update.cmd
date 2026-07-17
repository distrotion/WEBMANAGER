@echo off
REM ===  WEBMANAGER - quick UPDATE (no full reinstall)  ===
REM Double-click after `git pull` to swap in new code + restart the service.
REM Use this for updates. Use setup.cmd only for the FIRST install.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %*
