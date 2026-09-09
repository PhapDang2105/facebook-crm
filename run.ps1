param([int]$Port = 8080)
$ErrorActionPreference = 'Stop'
$nodePath = Join-Path $PSScriptRoot 'tools/node/node.exe'
if (-not (Test-Path -LiteralPath $nodePath)) { throw 'Portable Node.js runtime was not found in tools/node.' }
& $nodePath "$PSScriptRoot/app/server.mjs" $Port
