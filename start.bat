@echo off
echo === LocalNetworkStream (native) clean start ===
taskkill /im node.exe /f >nul 2>&1
rd /s /q media 2>nul
mkdir media 2>nul
if not exist node_modules (
  echo Installing dependencies...
  npm ci
)
start /b node server.js >> logs\server.log 2>&1
echo Started. See logs\server.log
pause
