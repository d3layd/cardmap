@echo off
rem Starts CardMap. Double-click this file, or pin a shortcut to it.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo CardMap is not set up yet. Run "npm install" in this folder first.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
