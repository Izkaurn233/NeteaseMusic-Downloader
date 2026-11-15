@echo off
setlocal
node "%~dp0bin\nj-web.js" %*
if errorlevel 1 pause
