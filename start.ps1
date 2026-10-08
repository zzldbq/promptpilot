$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
if (Get-Command python -ErrorAction SilentlyContinue) {
    & python server.py
} elseif (Test-Path -LiteralPath $bundledPython) {
    & $bundledPython server.py
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 server.py
} else {
    throw 'Python 3.10+ is required. System Python and bundled Codex Python were not found.'
}
