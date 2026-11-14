param(
    [Parameter(Mandatory = $true)]
    [int[]]$LastOctets,
    [string]$AdbPath = 'C:\Users\Snarvin\Documents\Xpase S Alpha 1\mcpAppControl-working\desktop\vendor\platform-tools\adb.exe'
)

$ErrorActionPreference = 'Stop'
$allowed = @(183, 194, 195, 196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 213, 214)
$dumpPath = '/sdcard/xsalpha-language-check.xml'

function Get-DeviceLine([string]$Serial, [string[]]$Arguments) {
    $result = & $AdbPath -s $Serial shell @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "ADB failed on $Serial for $($Arguments -join ' '): $result" }
    return (($result | Select-Object -First 1) -as [string]).Trim()
}

function Get-Ui([string]$Serial) {
    & $AdbPath -s $Serial shell uiautomator dump $dumpPath | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "UI dump failed on $Serial" }
    $raw = (& $AdbPath -s $Serial shell cat $dumpPath) -join ''
    if ($LASTEXITCODE -ne 0) { throw "UI read failed on $Serial" }
    return [xml]$raw
}

function Find-Node($Document, [string]$Attribute, [string]$Value) {
    return $Document.SelectNodes('//node') | Where-Object { $_.GetAttribute($Attribute) -eq $Value } | Select-Object -First 1
}

function Tap-Node([string]$Serial, $Node) {
    if (-not $Node) { throw "Missing expected UI control on $Serial" }
    $bounds = $Node.GetAttribute('bounds')
    if ($bounds -notmatch '^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$') { throw "Invalid UI bounds on $Serial" }
    $x = [int](([int]$Matches[1] + [int]$Matches[3]) / 2)
    $y = [int](([int]$Matches[2] + [int]$Matches[4]) / 2)
    & $AdbPath -s $Serial shell input tap $x $y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "UI tap failed on $Serial" }
}

foreach ($octet in $LastOctets) {
    if ($octet -notin $allowed) { throw "Device .$octet is outside the Box 2 allowlist" }
    $serial = "192.168.61.${octet}:5555"
    $config = Get-DeviceLine $serial @('am', 'get-config')
    if ($config -notmatch 'config: en-rUS') { throw "Unexpected primary locale on .$octet`: $config" }
    if ($config -notmatch 'zh\+Hans\+CN') {
        Write-Output ".$octet already English-only"
        continue
    }

    $stored = Get-DeviceLine $serial @('settings', 'get', 'system', 'system_locales')
    if ($stored -notmatch '^en-US,zh-Hans-CN$' -and $stored -ne 'en-US') {
        throw "Unexpected stored locale list on .$octet`: $stored"
    }

    $opened = $false
    try {
        & $AdbPath -s $serial shell am start -a android.settings.LOCALE_SETTINGS | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Could not open Language settings on .$octet" }
        $opened = $true
        $ui = Get-Ui $serial
        $english = Find-Node $ui 'content-desc' 'English (United States)'
        $chinese = Find-Node $ui 'content-desc' 'Simplified Chinese (China)'
        $remove = Find-Node $ui 'text' 'Remove'
        if (-not $english -or -not $chinese -or -not $remove) {
            throw "Unexpected language list on .$octet; stopped"
        }
        Tap-Node $serial $remove
        $ui = Get-Ui $serial
        $chinese = Find-Node $ui 'content-desc' 'Simplified Chinese (China)'
        $english = Find-Node $ui 'content-desc' 'English (United States)'
        if (-not $chinese -or -not $english) { throw "Missing language checkbox on .$octet" }
        Tap-Node $serial $chinese
        $ui = Get-Ui $serial
        $chinese = Find-Node $ui 'content-desc' 'Simplified Chinese (China)'
        $english = Find-Node $ui 'content-desc' 'English (United States)'
        if ($chinese.GetAttribute('checked') -ne 'true' -or $english.GetAttribute('checked') -ne 'false') {
            throw "Unsafe language selection on .$octet; stopped"
        }
        $remove = Find-Node $ui 'text' 'Remove'
        Tap-Node $serial $remove
        $ui = Get-Ui $serial
        $confirmation = $ui.SelectNodes('//node') | Where-Object {
            $_.GetAttribute('text') -like 'Text will continue to be shown in English*'
        } | Select-Object -First 1
        $confirmButton = $ui.SelectNodes('//node') | Where-Object {
            $_.GetAttribute('text') -eq 'Remove' -and $_.GetAttribute('clickable') -eq 'true'
        } | Select-Object -First 1
        if (-not $confirmation -or -not $confirmButton) {
            throw "Unexpected language removal confirmation on .$octet; stopped"
        }
        Tap-Node $serial $confirmButton
        $after = Get-DeviceLine $serial @('am', 'get-config')
        if ($after -notmatch 'config: en-rUS' -or $after -match 'zh\+Hans\+CN') {
            throw "Effective locale did not become English-only on .$octet`: $after"
        }
        Write-Output ".$octet English-only verified"
    }
    finally {
        if ($opened) { & $AdbPath -s $serial shell input keyevent 4 | Out-Null }
    }
}
