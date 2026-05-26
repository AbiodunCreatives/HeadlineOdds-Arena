@echo off
setlocal
powershell -ExecutionPolicy Bypass -File "%~dp0fly-stage-secrets.ps1" %*
