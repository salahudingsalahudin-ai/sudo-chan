import { NextResponse } from 'next/server';

const RELEASE_TAG = 'v0.1.0';
const RELEASE_BASE = `https://github.com/salahudingsalahudin-ai/sudo-chan/releases/download/${RELEASE_TAG}`;

const DOWNLOAD_MAP: Record<string, string> = {
  windows: `${RELEASE_BASE}/Sudo-chan-0.1.0-win-x64.exe`,
  macos: `${RELEASE_BASE}/Sudo-chan-0.1.0-mac-arm64.dmg`,
  'linux-deb': `${RELEASE_BASE}/Sudo-chan-0.1.0-linux-amd64.deb`,
  'linux-appimage': `${RELEASE_BASE}/Sudo-chan-0.1.0-linux-x86_64.AppImage`,
  checksums: `${RELEASE_BASE}/SHA256SUMS`,
};

function generateWindowsWebInstaller(): string {
  const winPkgUrl = `${RELEASE_BASE}/Sudo-chan-0.1.0-win-x64.exe`;
  return `@echo off
setlocal enabledelayedexpansion
title Sudo-chan Web Installer v0.1.0
chcp 65001 >nul 2>&1
color 0B
cls

echo ================================================================
echo             SUDO-CHAN DESKTOP COMPANION SETUP
echo               Lightweight Web Installer v0.1.0
echo ================================================================
echo.
echo  Target OS:  Windows 10 / 11 (64-bit)
echo  Features:   Urdu and English Voice, Screen AI Help, Desktop Mascot
echo.
echo  [1/3] Connecting to download server...
echo.

set "DEST_DIR=%TEMP%\\SudoChanSetup"
if not exist "%DEST_DIR%" mkdir "%DEST_DIR%"
set "DEST_EXE=%DEST_DIR%\\Sudo-chan-0.1.0-win-x64.exe"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference = 'Continue'; " ^
  "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
  "$wc = New-Object System.Net.WebClient; " ^
  "$wc.Headers.Add('User-Agent', 'SudoChan-WebBootstrapper/0.1.0'); " ^
  "Write-Host '  [2/3] Downloading full package (Sudo-chan-Setup.exe ~99 MB)...' -ForegroundColor Cyan; " ^
  "try { " ^
  "  $wc.DownloadFile('${winPkgUrl}', '%DEST_EXE%'); " ^
  "  Write-Host '  [✓] Download finished successfully!' -ForegroundColor Green; " ^
  "} catch { " ^
  "  Write-Host '  [!] Download failed: ' $_.Exception.Message -ForegroundColor Red; " ^
  "  exit 1; " ^
  "}"

if %ERRORLEVEL% NEQ 0 (
  echo.
  echo  [X] Download failed. Opening download page in your browser...
  start https://sudo-chan.vercel.app/download
  pause
  exit /b 1
)

echo.
echo  [3/3] Launching Sudo-chan Setup Wizard...
start "" "%DEST_EXE%"
echo.
echo  ================================================================
echo   Installation started! Sudo-chan will appear on your desktop.
echo   You can safely close this installer window.
echo  ================================================================
timeout /t 4 >nul
exit /b 0
`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const platform = (searchParams.get('platform') || '').toLowerCase();

  if (platform === 'windows-web') {
    const script = generateWindowsWebInstaller();
    return new NextResponse(script, {
      status: 200,
      headers: {
        'Content-Type': 'application/x-bat; charset=utf-8',
        'Content-Disposition': 'attachment; filename="Sudo-chan-Web-Installer.cmd"',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  const directUrl = DOWNLOAD_MAP[platform];
  if (directUrl) {
    return NextResponse.redirect(directUrl, {
      status: 302,
      headers: {
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  // Fallback to latest releases
  return NextResponse.redirect('https://github.com/salahudingsalahudin-ai/sudo-chan/releases/latest', 302);
}
