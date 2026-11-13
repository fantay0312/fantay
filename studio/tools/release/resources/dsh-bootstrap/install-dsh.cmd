@echo off
setlocal

where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo DeepSeek Harness installer: Windows PowerShell is required. 1>&2
  exit /b 1
)

if exist "%~dp0install-dsh.ps1" (
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-dsh.ps1" %*
  exit /b
)

set "OD_DSH_PS1=%TEMP%\fantay-install-dsh-%RANDOM%-%RANDOM%.ps1"
rem Publication supplies the colocated immutable PowerShell installer URL.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$uri='__FANTAY_DSH_INSTALLER_URL__'; if ($uri.StartsWith('__')) { Write-Error 'Run the colocated install-dsh.ps1 or use a published Fantay installer.'; exit 1 }; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing $uri -OutFile $env:OD_DSH_PS1"
if errorlevel 1 (
  echo DeepSeek Harness installer: could not download install-dsh.ps1. 1>&2
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%OD_DSH_PS1%" %*
set "OD_DSH_EXIT=%ERRORLEVEL%"
del /q "%OD_DSH_PS1%" >nul 2>nul
exit /b %OD_DSH_EXIT%
