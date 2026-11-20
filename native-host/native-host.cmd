@echo off
if exist "C:\nodejs\node.exe" (
  "C:\nodejs\node.exe" "%~dp0native-host.mjs"
) else if exist "%ProgramFiles%\nodejs\node.exe" (
  "%ProgramFiles%\nodejs\node.exe" "%~dp0native-host.mjs"
) else (
  node "%~dp0native-host.mjs"
)
