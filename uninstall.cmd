@echo off
REM ===  WEBMANAGER - one-click uninstall  ===
REM Double-click to remove the services + firewall rules (data is kept).
REM To also delete C:\webmanager, run:  uninstall.cmd -Purge
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\uninstall.ps1" %*
