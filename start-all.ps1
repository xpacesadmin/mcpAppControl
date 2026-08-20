[CmdletBinding()]
param(
    [string]$FleetAllowlistFile = $(if ($env:MCP_ADB_ALLOWLIST_FILE) {
        $env:MCP_ADB_ALLOWLIST_FILE
    } else {
        Join-Path $env:APPDATA 'MCP Control Bsolutions V2leet-allowlist.txt'
    })
)

$ErrorActionPreference = 'Stop'

$projectRoot = $PSScriptRoot
$desktopRoot = Join-Path $projectRoot 'desktop'
$adbPath = Join-Path $desktopRoot 'vendor\platform-tools\adb.exe'
$logRoot = Join-Path $env:LOCALAPPDATA 'MCP-Control-Bsolutions\logs'
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

# Safe lab defaults. Fleet expansion is driven only by the explicit local
# allowlist; no subnet scan or automatic agent installation is performed.
$env:MCP_LAB_MODE = '1'
$env:MCP_CANARY_FULL = '1'
$env:MCP_HERMES_ENABLED = '0'
$env:MCP_AUTO_INSTALL_AGENT = '0'
$env:MCP_ALLOW_NETWORK_SCAN = '0'
$env:MCP_ADB_ALLOWLIST_FILE = $FleetAllowlistFile

if (-not $env:MCP_ADB_ALLOWLIST) {
    if (Test-Path -LiteralPath $FleetAllowlistFile -PathType Leaf) {
        $approvedSerials = Get-Content -LiteralPath $FleetAllowlistFile |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -and -not $_.StartsWith('#') } |
            Select-Object -Unique
        $env:MCP_ADB_ALLOWLIST = $approvedSerials -join ','
    } else {
        $env:MCP_ADB_ALLOWLIST = ''
        Write-Warning "Fleet allowlist not found: $FleetAllowlistFile"
        Write-Warning 'Create it locally with one owner-approved ADB serial per line.'
    }
}

if (Test-Path -LiteralPath $adbPath -PathType Leaf) {
    $env:ADB_PATH = $adbPath
}

$approvedCount = @($env:MCP_ADB_ALLOWLIST -split ',' | Where-Object { $_.Trim() }).Count
Write-Host "Approved ADB devices loaded: $approvedCount"
Write-Host 'Hermes connector: disabled'
Write-Host 'Network scan: disabled'

$packagedCandidates = @(
    (Join-Path $desktopRoot 'release-final\win-unpacked\Bsolutions Control App.exe'),
    (Join-Path $desktopRoot 'release-installer\win-unpacked\Bsolutions Control App.exe'),
    (Join-Path $desktopRoot 'release\win-unpacked\Bsolutions Control App.exe'),
    (Join-Path $desktopRoot 'release-final\win-unpacked\MCP AppControl.exe'),
    (Join-Path $desktopRoot 'release-installer\win-unpacked\MCP AppControl.exe'),
    (Join-Path $desktopRoot 'release\win-unpacked\MCP AppControl.exe')
)

$packagedApp = $packagedCandidates |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1

if ($packagedApp) {
    Write-Host "Starting Bsolutions Control App from: $packagedApp"
    Start-Process -FilePath $packagedApp
    return
}

$electronBinary = Join-Path $desktopRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronBinary -PathType Leaf)) {
    throw 'No Windows build or local Electron dependency found. Run: cd desktop; npm install'
}

Write-Host 'Starting Bsolutions Control App in development mode...'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutLog = Join-Path $logRoot "mcp-$stamp.out.log"
$stderrLog = Join-Path $logRoot "mcp-$stamp.err.log"
$startArgs = @{
    FilePath = $electronBinary
    ArgumentList = '.'
    WorkingDirectory = $desktopRoot
    RedirectStandardOutput = $stdoutLog
    RedirectStandardError = $stderrLog
}
Start-Process @startArgs
Write-Host "Logs: $stdoutLog"