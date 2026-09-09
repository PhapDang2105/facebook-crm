param([int]$Port = 8080)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$healthUrl = "http://localhost:$Port/api/health"
$appUrl = "http://localhost:$Port/"
$logDirectory = Join-Path $root 'logs'
$outputLog = Join-Path $logDirectory 'crm-server-output.log'
$errorLog = Join-Path $logDirectory 'crm-server-error.log'
$shell = $null

function Test-CrmServer {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
        return $response.status -eq 'ok'
    } catch {
        return $false
    }
}

if (-not (Test-CrmServer)) {
    if (-not (Test-Path -LiteralPath $logDirectory)) {
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    }
    $serverScript = Join-Path $root 'run.ps1'
    $serverCommand = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$serverScript`" -Port $Port 1>`"$outputLog`" 2>`"$errorLog`""
    $shell = New-Object -ComObject WScript.Shell
    $shell.Run($serverCommand, 0, $false) | Out-Null

    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        Start-Sleep -Milliseconds 250
        if (Test-CrmServer) { $ready = $true; break }
    }
    if (-not $ready) {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show("Khong the khoi dong CRM. Xem log tai: $errorLog", 'CRM startup error') | Out-Null
        exit 1
    }
}

if ($null -eq $shell) { $shell = New-Object -ComObject WScript.Shell }
$shell.Run($appUrl, 1, $false) | Out-Null
