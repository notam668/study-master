@echo off
cd /d D:\server
set NODE_EXE=node
if exist D:\node.exe set NODE_EXE=D:\node.exe

echo [StudyMaster] Starting CloudBase Sync...
"%NODE_EXE%" services/run_sync.js
echo.
pause
