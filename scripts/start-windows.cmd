@echo off
setlocal
cd /d "%~dp0.."
title Queue TV Manager
echo Keep this window open while the TVs are in use.
echo Open http://localhost:8443 in your PC browser after the service starts.
call npm start
if errorlevel 1 pause
