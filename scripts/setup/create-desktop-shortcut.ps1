param([switch]$Desktop)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$shortcutDirectory = if ($Desktop) { [Environment]::GetFolderPath('Desktop') } else { $root }
$shortcutPath = Join-Path $shortcutDirectory 'Open Facebook CRM.lnk'
$launcherPath = Join-Path $root 'app/launcher.ps1'
$powershellPath = Join-Path $PSHOME 'powershell.exe'
$iconPath = Join-Path $root 'assets/branding/logos/facebook-logo-large.ico'

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershellPath
$shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcherPath`""
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = if (Test-Path -LiteralPath $iconPath) { "$iconPath,0" } else { "$env:SystemRoot\System32\shell32.dll,14" }
$shortcut.Description = 'Open Facebook CRM'
$shortcut.Save()

Write-Host "Shortcut created: $shortcutPath"
