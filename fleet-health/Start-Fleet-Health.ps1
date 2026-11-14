[CmdletBinding()]
param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node -ErrorAction Stop).Source
$launchFile = Join-Path $PSScriptRoot 'data\launch.json'
$launch = $null
if (Test-Path -LiteralPath $launchFile) {
    $candidate = Get-Content -LiteralPath $launchFile -Raw | ConvertFrom-Json
    try {
        $parts = $candidate.url.Split('#')
        $null = Invoke-RestMethod -Uri ($parts[0] + 'api/state') -Headers @{ 'x-fleet-token' = $parts[1] } -TimeoutSec 2
        $launch = $candidate
    } catch { }
}
if (-not $launch) {
    New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot 'data') -Force | Out-Null
    $env:FLEET_CODEX = (Get-Command codex -ErrorAction SilentlyContinue).Source
    Start-Process -FilePath $node -ArgumentList @('"' + (Join-Path $PSScriptRoot 'server.js') + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $PSScriptRoot 'data\server.log') -RedirectStandardError (Join-Path $PSScriptRoot 'data\server-error.log') | Out-Null
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        Start-Sleep -Milliseconds 300
        if (Test-Path -LiteralPath $launchFile) {
            $candidate = Get-Content -LiteralPath $launchFile -Raw | ConvertFrom-Json
            try {
                $parts = $candidate.url.Split('#')
                $null = Invoke-RestMethod -Uri ($parts[0] + 'api/state') -Headers @{ 'x-fleet-token' = $parts[1] } -TimeoutSec 1
                $launch = $candidate
                break
            } catch { }
        }
    }
}
if (-not $launch) { throw 'Console did not start. Check fleet-health/data/server-error.log.' }
if (-not $NoBrowser) { Start-Process $launch.url }
Write-Output 'Fleet Health is running locally on port 8790. An owner-enabled 60-second health monitor resumes if configured; repairs never start automatically.'
