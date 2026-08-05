@echo off
rem Doble clic para hospedar tu instancia. La ventana tiene que quedarse abierta:
rem si la cierras, tu comunidad se apaga.
cd /d "%~dp0"
title Distop - tu comunidad esta en linea

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Falta Node.js. Instala la version 24 o superior desde https://nodejs.org
  echo   y vuelve a abrir este archivo.
  echo.
  pause
  exit /b 1
)

node scripts\host.mjs %*
if errorlevel 1 pause
