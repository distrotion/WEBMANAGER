@echo off
REM ===  Node-RED 1.x on Node 22: fix "Error: spawn EINVAL" at startup (offline)  ===
REM Patches the 3 npm.cmd calls in @node-red\registry\lib\installer.js to use shell:true
REM (backup installer.js.bak-node22), then starts Node-RED once to test.
REM Close the test window (Ctrl+C) and start Node-RED the normal way (ReportService) afterwards.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fix-nodered-node22.ps1" %*
pause
