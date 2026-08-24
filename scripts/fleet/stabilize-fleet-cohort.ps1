[CmdletBinding()]
param(
    [ValidateSet('Validate','Apply')]
    [string]$Mode = 'Validate',
    [ValidateSet(60,61)]
    [int]$Vlan = 60,
    [string]$AllowlistFile = '',
    [string[]]$Devices = @(),
    [string]$AdbPath = '',
    [string]$Timezone = 'America/Chicago',
    [switch]$Confirm
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path

if (-not $AllowlistFile) {
    $name = if ($Vlan -eq 60) { 'fleet-allowlist.txt' } else { 'fleet-vlan61-allowlist.txt' }
    $AllowlistFile = Join-Path $env:APPDATA "MCP Control Bsolutions V2\$name"
}
$allowlistPath = (Resolve-Path -LiteralPath $AllowlistFile).Path
$allowed = @(Get-Content -LiteralPath $allowlistPath |
    Where-Object { $_ -and -not $_.Trim().StartsWith('#') } |
    ForEach-Object { $_.Trim() })

if ($allowed.Count -lt 1 -or $allowed.Count -gt 20) { throw "Expected 1-20 VLAN $Vlan devices; found $($allowed.Count)" }
if (($allowed | Sort-Object -Unique).Count -ne $allowed.Count) { throw 'Allowlist contains duplicate devices' }
if (@($allowed | Where-Object { $_ -notmatch "^192\.168\.$Vlan\.\d{1,3}:5555$" }).Count) {
    throw "Allowlist contains a device outside VLAN $Vlan"
}

if ($Devices.Count) {
    $outside = @($Devices | Where-Object { $allowed -notcontains $_ })
    if ($outside.Count) { throw "Requested device is outside the exact allowlist: $($outside -join ', ')" }
    $targets = @($Devices)
} else {
    $targets = @($allowed)
}

$adbCandidates = @(
    $AdbPath,
    $env:ADB_PATH,
    (Join-Path $env:APPDATA 'com.tikmatrix\platform-tools\adb.exe'),
    (Join-Path $repoRoot 'desktop\vendor\platform-tools\adb.exe')
) | Where-Object { $_ }
$resolvedAdb = $adbCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $resolvedAdb) { throw 'No approved ADB runtime found. Pass -AdbPath or install the existing TikMatrix/platform-tools runtime.' }
$resolvedAdb = (Resolve-Path -LiteralPath $resolvedAdb).Path

if ($Mode -eq 'Apply' -and -not $Confirm) { throw 'Apply mode requires -Confirm' }
if ($Timezone -notmatch '^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+$') { throw 'Invalid IANA timezone' }

$results = @()
foreach ($device in $targets) {
    $state = (& $resolvedAdb -s $device get-state 2>$null | Select-Object -First 1)
    $state = if ($state) { $state.Trim() } else { 'offline' }
    if ($Mode -eq 'Apply' -and $state -eq 'device') {
        $epochMs = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
        & $resolvedAdb -s $device shell settings put global auto_time 0 | Out-Null
        & $resolvedAdb -s $device shell settings put global auto_time_zone 0 | Out-Null
        & $resolvedAdb -s $device shell cmd alarm set-timezone $Timezone | Out-Null
        & $resolvedAdb -s $device shell cmd alarm set-time $epochMs | Out-Null
        & $resolvedAdb -s $device shell input keyevent 224 | Out-Null
        & $resolvedAdb -s $device shell settings put global stay_on_while_plugged_in 3 | Out-Null
        & $resolvedAdb -s $device shell settings put system screen_off_timeout 1800000 | Out-Null
        & $resolvedAdb -s $device shell settings put global window_animation_scale 0 | Out-Null
        & $resolvedAdb -s $device shell settings put global transition_animation_scale 0 | Out-Null
        & $resolvedAdb -s $device shell settings put global animator_duration_scale 0 | Out-Null
    }

    $timezoneObserved = ''
    $deviceEpoch = 0
    $proxyObserved = ''
    $timeDelta = $null
    if ($state -eq 'device') {
        $timezoneObserved = ((& $resolvedAdb -s $device shell getprop persist.sys.timezone 2>$null | Select-Object -First 1) -as [string]).Trim()
        $epochText = ((& $resolvedAdb -s $device shell date +%s 2>$null | Select-Object -First 1) -as [string]).Trim()
        [void][long]::TryParse($epochText, [ref]$deviceEpoch)
        if ($deviceEpoch) { $timeDelta = [Math]::Abs($deviceEpoch - [DateTimeOffset]::Now.ToUnixTimeSeconds()) }
        $proxyObserved = ((& $resolvedAdb -s $device shell settings get global http_proxy 2>$null | Select-Object -First 1) -as [string]).Trim()
    }

    $results += [pscustomobject]@{
        Device = $device
        Vlan = $Vlan
        AdbState = $state
        Timezone = $timezoneObserved
        TimeDeltaSeconds = $timeDelta
        TimeHealthy = ($null -ne $timeDelta -and $timeDelta -le 10)
        ProxyPreserved = $proxyObserved
        Mode = $Mode
    }
}

$logDir = Join-Path $env:APPDATA 'MCP Control Bsolutions V2\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logPath = Join-Path $logDir ("fleet-vlan{0}-stabilize-{1}.csv" -f $Vlan,(Get-Date -Format 'yyyyMMdd-HHmmss'))
$results | Export-Csv -NoTypeInformation -LiteralPath $logPath
$results | Format-Table -AutoSize

$online = @($results | Where-Object { $_.AdbState -eq 'device' }).Count
$healthy = @($results | Where-Object { $_.TimeHealthy }).Count
Write-Output "MODE=$Mode"
Write-Output "VLAN=$Vlan"
Write-Output "TARGETS=$($targets.Count)"
Write-Output "ONLINE=$online"
Write-Output "TIME_HEALTHY=$healthy"
Write-Output "LOG=$logPath"
if ($Mode -eq 'Apply' -and $healthy -ne $online) { throw 'One or more online devices failed time verification' }
