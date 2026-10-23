@echo off
REM ============================================================================
REM Builds this package and produces a versioned .tgz - the exact file `npm publish` uploads - named from the
REM version in package.json: automation-referenced-automation-sas-<version>.tgz
REM
REM Two ways to use it:
REM   1. Publish it to the registry:  scripts\publish-package.bat
REM      Other repos then get it BY VERSION from their package.json (README: Publishing a package).
REM   2. Keep it local: put the .tgz where the consuming repo can see it and install it there with
REM      `npm install --no-save <file>.tgz` (README: Using a package without a registry) - or run
REM      scripts\setup.bat --local in the consumer, which builds and installs every @automation dependency this way.
REM
REM Usage: scripts\create-package.bat [--local] [output-dir]
REM   --local     build against the sibling @automation packages in ..\shared-packages instead of the registry
REM   output-dir  default ..\shared-packages (sibling to this repo)
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

set "LOCAL=0"
if "%~1"=="--local" (
  set "LOCAL=1"
  shift
)
set "OUT_DIR=%~1"
if "%OUT_DIR%"=="" set "OUT_DIR=..\shared-packages"

REM Every npm command below fetches packages from this registry.
if defined NPM_REGISTRY_URL call npm config set registry "%NPM_REGISTRY_URL%"

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

if "%LOCAL%"=="1" (
  REM The packages this one depends on come from ..\shared-packages instead of the registry (see scripts\setup.bat).
  set "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"
  call scripts\setup.bat --local
  if errorlevel 1 exit /b 1
) else (
  call npm ci
  if errorlevel 1 exit /b 1
)
call npm run clean
if errorlevel 1 exit /b 1
call npm run build
if errorlevel 1 exit /b 1

REM `npm pack` runs the "prepack" script (build) again and writes <name>-<version>.tgz into the current directory.
for /f "delims=" %%T in ('npm pack --silent') do set "TARBALL=%%T"
if not defined TARBALL (
  echo ERROR: npm pack did not produce a tarball. 1>&2
  exit /b 1
)
move /y "%TARBALL%" "%OUT_DIR%\" >nul

echo.
echo Package written to: %OUT_DIR%\%TARBALL%
echo Publish it:             scripts\publish-package.bat
echo Or install it locally:  npm install --no-save %OUT_DIR%\%TARBALL%
endlocal
exit /b 0
