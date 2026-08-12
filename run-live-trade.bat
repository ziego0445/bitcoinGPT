@echo off
cd /d "%~dp0"
echo Starting live-trade bot (real Bitget account)...
node --env-file=.env scripts\live-trade.js
echo.
echo Bot stopped (exit code %ERRORLEVEL%). Press any key to close this window.
pause >nul
