$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
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
