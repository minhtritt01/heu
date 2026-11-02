@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Dang don thu vien cu bi hong...
taskkill /f /im electron.exe >nul 2>nul
taskkill /f /im node.exe >nul 2>nul
if exist node_modules rmdir /s /q node_modules
if exist node_modules (
  echo Van con file bi khoa. Hay khoi dong lai may roi chay lai file nay.
  pause
  exit /b
)
if exist package-lock.json del /f /q package-lock.json
call npm cache verify
echo Dang cai lai thu vien, mat khoang 2-5 phut...
call npm install --no-audit --no-fund
if exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo XONG! Gio bam dup Chay-app.bat de mo app.
) else (
  echo.
  echo Van loi. Chup man hinh cua so nay gui cho Claude.
)
pause
