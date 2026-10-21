@echo off
setlocal
rem The whole block is parsed before Node updates this launcher on disk.
(
  cd /d "%~dp0"
  node scripts\update-windows.ts %*
  if errorlevel 1 (
    echo.
    echo Update stopped. See the log path printed above.
    if not "%SV_UPDATE_NO_PAUSE%"=="1" pause
    exit /b 1
  )
  if not "%SV_UPDATE_NO_PAUSE%"=="1" pause
  exit /b 0
)
