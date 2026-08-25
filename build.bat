@echo off
REM Puca - Unified Build & Deploy Script (Windows)
REM Builds frontend and syncs to all platforms (desktop + mobile)

setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set FRONTEND_DIR=%SCRIPT_DIR%frontend
set PLATFORM=all
set PROD=false
set DEPLOY=false

REM Parse arguments
:parse_args
if "%~1"=="" goto :main
if /i "%~1"=="--platform" (set PLATFORM=%~2& shift & shift & goto :parse_args)
if /i "%~1"=="-p" (set PLATFORM=%~2& shift & shift & goto :parse_args)
if /i "%~1"=="--prod" (set PROD=true& shift & goto :parse_args)
if /i "%~1"=="--deploy" (set DEPLOY=true& shift & goto :parse_args)
if /i "%~1"=="-d" (set DEPLOY=true& shift & goto :parse_args)
if /i "%~1"=="--help" goto :help
if /i "%~1"=="-h" goto :help
echo Unknown parameter: %~1
exit /b 1

:help
echo Usage: build.bat [options]
echo   --platform, -p  ^<all^|web^|ios^|android^|desktop^>  Target platform (default: all)
echo   --prod          Production build
echo   --deploy, -d    Deploy after build
exit /b 0

:main
echo [BUILD] Starting build for platform: %PLATFORM%
echo.

REM Build frontend
echo [BUILD] Building frontend...
cd /d "%FRONTEND_DIR%"

if not exist "node_modules" (
    echo [BUILD] Installing dependencies...
    call npm install
)

echo [BUILD] Type checking...
call npm run lint
if errorlevel 1 echo [WARN] Lint warnings found

echo [BUILD] Building...
call npm run build
if errorlevel 1 (
    echo [ERROR] Frontend build failed
    exit /b 1
)
echo [SUCCESS] Frontend build complete

REM Sync Capacitor
if "%PLATFORM%"=="web" goto :skip_capacitor
if "%PLATFORM%"=="desktop" goto :skip_capacitor

echo [BUILD] Syncing Capacitor platforms...

if "%PLATFORM%"=="ios" goto :sync_ios
if "%PLATFORM%"=="all" goto :sync_ios
goto :check_android

:sync_ios
echo [BUILD] Syncing iOS...
call npx cap sync ios
echo [SUCCESS] iOS synced

:check_android
if "%PLATFORM%"=="android" goto :sync_android
if "%PLATFORM%"=="all" goto :sync_android
goto :skip_capacitor

:sync_android
echo [BUILD] Syncing Android...
call npx cap sync android
echo [SUCCESS] Android synced

:skip_capacitor

REM Build Desktop
if "%PLATFORM%"=="desktop" goto :build_desktop
if "%PLATFORM%"=="all" goto :build_desktop
goto :deploy

:build_desktop
if "%PROD%"=="true" (
    echo [BUILD] Building desktop app Tauri...
    call npm run tauri:build
    echo [SUCCESS] Desktop build complete
) else (
    echo [BUILD] Skipping desktop build (use --prod for release build)
)

:deploy
if "%DEPLOY%"=="false" goto :done

echo [BUILD] Deploying...
if "%PLATFORM%"=="all" goto :deploy_ota
if "%PLATFORM%"=="ios" goto :deploy_ota
if "%PLATFORM%"=="android" goto :deploy_ota
goto :done

:deploy_ota
echo [BUILD] Pushing OTA update via Capgo...
call npx @capgo/cli bundle upload --channel production
if errorlevel 1 (
    echo [WARN] Capgo deployment failed or not configured
) else (
    echo [SUCCESS] OTA update pushed
)

:done
echo.
echo [SUCCESS] === Build Complete ===
echo.
echo Next steps:
echo   iOS:     cd frontend ^&^& npx cap open ios
echo   Android: cd frontend ^&^& npx cap open android  
echo   Desktop: cd frontend ^&^& npm run tauri:dev
echo   Web:     cd frontend ^&^& npm run preview
