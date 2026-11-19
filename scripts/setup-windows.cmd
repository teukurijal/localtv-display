@echo off
setlocal
cd /d "%~dp0.."
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22 or newer, reopen this window, and run setup again.
  pause
  exit /b 1
)
call npm ci
if errorlevel 1 goto failed
call npm run install:browser
if errorlevel 1 goto failed
echo.
echo Setup complete. Run scripts\start-windows.cmd to start Queue TV Manager.
pause
exit /b 0
:failed
echo Setup did not complete. Check the error above and your internet connection.
pause
exit /b 1
