@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Chua co Node.js. Hay cai ban LTS tai https://nodejs.org roi chay lai file nay.
  start https://nodejs.org
  pause
  exit /b
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo Lan dau: dang cai thu vien, mat khoang 2-5 phut...
  call npm install --no-audit --no-fund
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo.
  echo Cai thu vien chua xong. Hay chay file Sua-loi-cai-dat.bat roi thu lai.
  pause
  exit /b
)
echo Dang mo HEU...
call npm start
