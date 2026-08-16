@echo off
cd /d "%~dp0"
title Discord Verify Bot

if not exist .env (
  echo ERROR: .env was not found.
  echo Copy .env.example to .env and fill in the values.
  pause
  exit /b 1
)

if not exist config.json (
  echo {"channelRules":{},"permissionSnapshots":{}} > config.json
)

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found in PATH.
  echo Install Node.js and run this file again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
)

echo Starting Discord Verify Bot...
node index.js
pause
