@echo off
title HelmutReads Deploy
cd /d "%~dp0"

echo.
echo ============================================
echo   HELMUTREADS - CLOUDFLARE DEPLOY
echo ============================================
echo.
echo This builds the client, migrates D1, and deploys the Worker.
echo One-time setup must be done first (see DEPLOY.md).
echo.

echo [1/5] Installing exact dependencies...
call npm.cmd ci
if errorlevel 1 (
  echo.
  echo INSTALL FAILED. Nothing was deployed.
  pause
  exit /b 1
)

echo.
echo [2/5] Running tests...
call npm.cmd test
if errorlevel 1 (
  echo.
  echo TESTS FAILED. Nothing was deployed.
  pause
  exit /b 1
)

echo.
echo [3/5] Typechecking...
call npm.cmd run typecheck
if errorlevel 1 (
  echo.
  echo TYPECHECK FAILED. Nothing was deployed.
  pause
  exit /b 1
)

echo.
echo [4/5] Building client...
call npm.cmd run build:client
if errorlevel 1 (
  echo.
  echo BUILD FAILED. Nothing was deployed.
  pause
  exit /b 1
)

echo.
echo [5/5] Migrating D1 and deploying...
call npx wrangler d1 migrations apply helmut-reads --remote
if errorlevel 1 (
  echo.
  echo MIGRATION FAILED. Nothing was deployed.
  pause
  exit /b 1
)
call npx wrangler deploy
if errorlevel 1 (
  echo.
  echo DEPLOY FAILED. Check the output above.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   DEPLOY COMPLETE
echo ============================================
echo.
echo Open https://helmutreads.com and test:
echo 1. Sign in with email + code
echo 2. Drop a plate photo, watch both phases
echo 3. Check the usage dashboard numbers
echo 4. Billing section shows plan status
echo.
pause
