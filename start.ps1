param([switch]$Local)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not $Local) {
    docker compose up -d --build --wait --wait-timeout 180
    if ($LASTEXITCODE -ne 0) { throw 'Docker startup failed. Check Docker Desktop and docker compose logs.' }
    Write-Output 'Whatsapper is running at http://127.0.0.1:4010 in Docker.'
    return
}
$env:HOST = '127.0.0.1'
if (-not $env:PORT) {
    $env:PORT = '4010'
}
$taskNode = Get-Command node -ErrorAction SilentlyContinue
$taskNodePath = if ($taskNode) { $taskNode.Source } else {
    Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $taskNodePath)) {
    throw 'Node.js is required to run Whatsapper.'
}
& $taskNodePath app/server.js
