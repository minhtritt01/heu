@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run dist
echo.
echo Xong! File cai dat nam trong thu muc dist
start "" dist
pause
