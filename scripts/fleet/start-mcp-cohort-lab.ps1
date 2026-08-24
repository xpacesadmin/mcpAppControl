[CmdletBinding()]
param(
    [ValidateSet(60,61)]
    [int[]]$Vlan = @(60),
    [string]$AllowlistFile = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$desktopDir = Join-Path $repoRoot 'desktop'
$electron = Join-Path $desktopDir 'node_modules\electron\dist\electron.exe'
$adb = Join-Path $env:APPDATA 'com.tikmatrix\platform-tools\adb.exe'
$vlans = @($Vlan | Sort-Object -Unique)
if (-not $vlans.Count -or $vlans.Count -gt 2) { throw 'Specify VLAN 60, VLAN 61, or both.' }
if (-not $AllowlistFile) {
    $fileName = if ($vlans.Count -eq 2) {
        'fleet-vlan60-61-allowlist.txt'
    } elseif ($vlans[0] -eq 60) {
        'fleet-allowlist.txt'
    } else {
        'fleet-vlan61-allowlist.txt'
    }
    $AllowlistFile = Join-Path $env:APPDATA "MCP Control Bsolutions V2\$fileName"
}
$allowlistPath = (Resolve-Path -LiteralPath $AllowlistFile).Path
$entries = Get-Content -LiteralPath $allowlistPath |
    Where-Object { $_ -and -not $_.Trim().StartsWith('#') } |
    ForEach-Object { $_.Trim() }

$maxDevices = 20 * $vlans.Count
if ($entries.Count -lt 1 -or $entries.Count -gt $maxDevices) {
    throw "The fleet lab allowlist must contain between 1 and $maxDevices devices; found $($entries.Count)."
}
if (($entries | Sort-Object -Unique).Count -ne $entries.Count) {
    throw 'The fleet lab allowlist contains duplicate entries.'
}
$invalid = @($entries | Where-Object {
    if ($_ -notmatch '^192\.168\.(60|61)\.\d{1,3}:5555$') { return $true }
    return $vlans -notcontains [int]$Matches[1]
})
if ($invalid.Count) {
    throw "The fleet lab allowlist contains a device outside VLAN(s) $($vlans -join ',')."
}
if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
    throw "Electron runtime not found at $electron. Run npm install in desktop first."
}
if (-not (Test-Path -LiteralPath $adb -PathType Leaf)) {
    throw "Approved TikMatrix ADB runtime not found at $adb."
}

$env:MCP_LAB_MODE = 'true'
$env:MCP_LAB_SCOPE = 'allowlist'
$env:MCP_ADB_ALLOWLIST_FILE = $allowlistPath
$env:MCP_LAB_FULL = 'true'
$env:MCP_CANARY_FULL = 'true'
$env:MCP_HERMES_ENABLED = 'false'
$env:MCP_AUTO_INSTALL_AGENT = 'false'
$env:ADB_PATH = $adb

$process = Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $desktopDir -PassThru
Write-Output "MCP_PID=$($process.Id)"
Write-Output "LAB_SCOPE=allowlist"
Write-Output "ALLOWLISTED_DEVICES=$($entries.Count)"
Write-Output "FLEET_VLANS=$($vlans -join ',')"
Write-Output 'HERMES_ENABLED=false'
Write-Output 'ADB_RUNTIME=tikmatrix-bundled'
