@echo off
cd /d "%~dp0"
echo Starting ICT live-trade bot (real OKX account)...
node --env-file=.env scripts\live-trade-ict.js
echo.
echo Bot stopped (exit code %ERRORLEVEL%). Press any key to close this window.
pause >nul
