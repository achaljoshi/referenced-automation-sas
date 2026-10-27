@echo off
REM ============================================================================
REM One-shot setup: installs this repo's dependencies. Also installs the Chromium binary Playwright needs plus its OS-level dependencies.
REM
REM Packages - the @automation\* ones too - are installed BY VERSION from the npm registry in NPM_REGISTRY_URL: the
REM versions are the ones in package.json. To pick up a newer version of a package, change its version there and run
REM `npm install` (README: Upgrading a package).
REM
REM Without these packages in a registry yet - or to try a change you have not published - use local mode:
REM   scripts\setup.bat --local
REM It builds the sibling repos this one depends on (referenced-automation-utils, referenced-automation-api, referenced-automation-ui), keeps their .tgz
REM files in ..\shared-packages and installs those instead. Nothing in package.json or package-lock.json changes. The
REM sibling repos must be checked out next to this one. (USE_LOCAL_PACKAGES=1 does the same.)
REM
REM Usage: scripts\setup.bat [--local]
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

set "LOCAL=0"
if "%~1"=="--local" set "LOCAL=1"
if "%USE_LOCAL_PACKAGES%"=="1" set "LOCAL=1"
set "SHARED_PACKAGES_DIR=..\shared-packages"

REM Every npm command below fetches packages from this registry.
if defined NPM_REGISTRY_URL (
  call npm config set registry "%NPM_REGISTRY_URL%"
) else (
  echo NOTE: NPM_REGISTRY_URL is not set - npm keeps using the registry it is already configured with.
)

REM Fail early, with the fix, if Node does not trust the HTTPS certificate of the registry (and of the browser download host) -
REM usually a company proxy that re-signs HTTPS. The fix is NODE_EXTRA_CA_CERTS, never NODE_TLS_REJECT_UNAUTHORIZED=0.
set "TLS_ARGS=--browsers"
if "%PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD%"=="1" set "TLS_ARGS="
call node scripts\check-tls.js %TLS_ARGS%
if errorlevel 1 exit /b 1

if "%LOCAL%"=="1" (
  echo.
  echo == Local mode: making sure the @automation packages exist in %SHARED_PACKAGES_DIR% ==
  call :ensure_package referenced-automation-utils
  if errorlevel 1 exit /b 1
  call :ensure_package referenced-automation-api
  if errorlevel 1 exit /b 1
  call :ensure_package referenced-automation-ui
  if errorlevel 1 exit /b 1
  call :latest_tarball referenced-automation-utils TARBALL_0
  call :latest_tarball referenced-automation-api TARBALL_1
  call :latest_tarball referenced-automation-ui TARBALL_2
  echo.
  echo == Installing dependencies ^(the @automation packages from %SHARED_PACKAGES_DIR%; package.json and the lockfile stay as they are^) ==
  call npm install --no-save --no-audit --no-fund "!TARBALL_0!" "!TARBALL_1!" "!TARBALL_2!"
  if errorlevel 1 exit /b 1
) else (
  echo.
  echo == Installing dependencies from the registry ==========================
  call npm ci
  if errorlevel 1 (
    echo. 1>&2
    echo npm ci failed. If it stopped on an @automation\* package, that version is not in the registry yet: 1>&2
    echo publish it ^(see the README: Publishing a package^) or run scripts\setup.bat --local. 1>&2
    exit /b 1
  )
)

if "%PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD%"=="1" (
  echo.
  echo == Skipping Playwright browser download ^(PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1^) ==
  echo Set BROWSER to a system-installed browser channel instead, e.g.:
  echo   set BROWSER=msedge ^&^& npm test   ^(or BROWSER=chrome^)
) else (
  echo.
  echo == Installing Playwright browsers =====================================
  call npx playwright install --with-deps chromium
  if errorlevel 1 exit /b 1
)

echo.
echo Setup complete. Try: npm test
endlocal
exit /b 0

:ensure_package
set "REPO_NAME=%~1"
set "FOUND="
for %%F in ("%SHARED_PACKAGES_DIR%\automation-%REPO_NAME%-*.tgz") do set "FOUND=%%F"
if defined FOUND (
  echo == %REPO_NAME%: already packaged ==
  exit /b 0
)
set "REPO_DIR=..\%REPO_NAME%"
if not exist "%REPO_DIR%" (
  echo ERROR: %REPO_NAME% is not packaged and not checked out at %REPO_DIR%. 1>&2
  echo Clone it as a sibling of this repo first: 1>&2
  echo   git clone https://github.com/achaljoshi/%REPO_NAME%.git %REPO_DIR% 1>&2
  exit /b 1
)
echo == Building %REPO_NAME% (dependency) ==
pushd "%REPO_DIR%"
REM %REPO_DIR% is a sibling of this repo at the same depth, so the relative path to the shared packages folder is
REM unchanged after pushd. Its own create-package --local builds the packages IT depends on first.
call scripts\create-package.bat --local "%SHARED_PACKAGES_DIR%"
set "BUILD_RESULT=%ERRORLEVEL%"
popd
exit /b %BUILD_RESULT%

REM The newest tarball (last in name order) of a package in %SHARED_PACKAGES_DIR%.
:latest_tarball
set "LATEST="
for /f "delims=" %%F in ('dir /b /o:n "%SHARED_PACKAGES_DIR%\automation-%~1-*.tgz"') do set "LATEST=%SHARED_PACKAGES_DIR%\%%F"
set "%~2=%LATEST%"
exit /b 0
