@echo off
REM ============================================================================
REM Publishes this package to the npm registry in NPM_REGISTRY_URL, at the version in package.json. Other repos then
REM get it by version: they list "@automation/referenced-automation-sas": "^<version>" in package.json.
REM
REM Usage: scripts\publish-package.bat [--dry-run]
REM
REM Before publishing:
REM   - bump the version (a version can be published only once):  npm version patch^|minor^|major
REM     and commit the change; update CHANGELOG.md
REM   - your npm must already be allowed to publish to that registry - this script does not log in for you
REM     (use your organisation's usual way to authenticate npm against it)
REM   --dry-run  builds the package and shows what would be uploaded, without uploading anything
REM ============================================================================
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

if not defined NPM_REGISTRY_URL (
  echo ERROR: set NPM_REGISTRY_URL to your organisation's npm registry URL, then run this again. 1>&2
  exit /b 1
)
call npm config set registry "%NPM_REGISTRY_URL%"

set "DRY_RUN="
if "%~1"=="--dry-run" set "DRY_RUN=--dry-run"

set "OUT_DIR=%TEMP%\automation-publish-%RANDOM%"
call scripts\create-package.bat "%OUT_DIR%"
if errorlevel 1 exit /b 1
set "TARBALL="
for %%T in ("%OUT_DIR%\*.tgz") do set "TARBALL=%%T"

echo.
echo == Publishing %TARBALL% to %NPM_REGISTRY_URL% %DRY_RUN% ==
call npm publish "%TARBALL%" --registry "%NPM_REGISTRY_URL%" %DRY_RUN%
exit /b %ERRORLEVEL%
