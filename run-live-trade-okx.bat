@echo off
cd /d "%~dp0"
echo Starting OKX panic-climax live-trade bot (real OKX account, Bitget signals)...
node --env-file=.env scripts\live-trade-okx.js
echo.
echo Bot stopped (exit code %ERRORLEVEL%). Press any key to close this window.
pause >nul
