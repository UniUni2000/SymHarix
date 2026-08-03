@echo off
setlocal
set "SYMHARIX_APP_ROOT=%~dp0.."
set "PATH=%~dp0;%PATH%"
"%~dp0bun.exe" --no-env-file run "%~dp0..\src\cli\distribution.ts" %*
exit /b %ERRORLEVEL%
