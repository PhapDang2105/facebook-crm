$ErrorActionPreference = 'Stop'

$settingsPath = Join-Path $env:LOCALAPPDATA 'Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json'
if (-not (Test-Path -LiteralPath $settingsPath)) {
    throw 'Windows Terminal settings.json was not found.'
}

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = "$settingsPath.backup-$timestamp"
Copy-Item -LiteralPath $settingsPath -Destination $backupPath

$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
$bindings = @($settings.keybindings | Where-Object {
    $_.keys -notin @('ctrl+v', 'ctrl+shift+v')
})

$imagePasteBinding = [pscustomobject]@{
    command = [pscustomobject]@{
        action = 'sendInput'
        input = [string][char]0x16
    }
    keys = 'ctrl+v'
}

$textPasteBinding = [pscustomobject]@{
    id = 'Terminal.PasteFromClipboard'
    keys = 'ctrl+shift+v'
}

$settings.keybindings = @($bindings) + $imagePasteBinding + $textPasteBinding
$settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath -Encoding utf8

Write-Host "Updated: $settingsPath"
Write-Host "Backup:  $backupPath"
Write-Host 'Ctrl+V sends the image-paste key to Codex.'
Write-Host 'Ctrl+Shift+V performs regular terminal paste.'

