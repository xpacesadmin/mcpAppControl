[CmdletBinding()]
param(
    [ValidateSet('Validate','EnrollRoutes','AssignOne','VerifyOne','ReleaseOne')]
    [string]$Mode = 'Validate',
    [int]$FleetNumber,
    [string]$ManifestPath = '',
    [string]$ApiBaseUrl = 'http://127.0.0.1:8733/api/v1',
    [string]$TokenFile,
    [string]$OperationId,
    [switch]$Confirm
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $ManifestPath) { $ManifestPath = Join-Path $PSScriptRoot '..\..\docs\proxy-routes\fleet60-cohort-20.plan.json' }

function Assert-Manifest {
    param([object]$Manifest)
    if ($Manifest.credential_free -ne $true) { throw 'Manifest must declare credential_free=true' }
    $routes = @($Manifest.routes)
    if ($routes.Count -ne 20) { throw "Expected exactly 20 active routes; found $($routes.Count)" }
    $secretNames = @('password','token','username','credentials','secret','authorization')
    function Test-Properties([object]$Value) {
        if ($null -eq $Value) { return }
        if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
            foreach ($item in $Value) { Test-Properties $item }
            return
        }
        if ($Value -is [pscustomobject]) {
            foreach ($property in $Value.PSObject.Properties) {
                if ($secretNames -contains $property.Name.ToLowerInvariant()) {
                    throw "Secret-bearing property is prohibited in the cohort manifest: $($property.Name)"
                }
                Test-Properties $property.Value
            }
        }
    }
    Test-Properties $Manifest

    $routeIds = @{}; $serials = @{}; $listeners = @{}; $providerPorts = @{}; $publicIps = @{}
    foreach ($route in $routes) {
        if ([int]$route.assigned_fleet_vlan -ne 60) { throw "Route $($route.route_id) is outside VLAN 60" }
        if ([string]$route.classification -ne 'dedicated_static') { throw "Route $($route.route_id) is not dedicated_static" }
        if ([string]$route.protocol -ne 'HTTP') { throw "Route $($route.route_id) must use HTTP for the current 3proxy chain" }
        if ([string]$route.adb_serial -notmatch '^192\.168\.60\.\d{1,3}:5555$') { throw "Invalid ADB serial: $($route.adb_serial)" }
        if (([string]$route.adb_serial).Split(':')[0] -ne [string]$route.reserved_device_ip) { throw "ADB/reserved IP mismatch for $($route.route_id)" }
        if ([int]$route.internal_endpoint.port -ne (8200 + [int]$route.fleet_number)) { throw "Unexpected listener for $($route.route_id)" }
        if ([int]$route.provider_endpoint.port -ne (10000 + [int]$route.fleet_number)) { throw "Unexpected provider port for $($route.route_id)" }
        foreach ($entry in @(
            @{ Set=$routeIds; Key=[string]$route.route_id; Label='route ID' },
            @{ Set=$serials; Key=[string]$route.adb_serial; Label='ADB serial' },
            @{ Set=$listeners; Key=[string]$route.internal_endpoint.port; Label='listener' },
            @{ Set=$providerPorts; Key=[string]$route.provider_endpoint.port; Label='provider port' },
            @{ Set=$publicIps; Key=[string]$route.expected_public_ip; Label='public IP' }
        )) {
            if ($entry.Set.ContainsKey($entry.Key)) { throw "Duplicate $($entry.Label): $($entry.Key)" }
            $entry.Set[$entry.Key] = $true
        }
    }
    $fleet1 = $routes | Where-Object { [int]$_.fleet_number -eq 1 }
    if ($fleet1.adb_serial -ne '192.168.60.199:5555' -or [int]$fleet1.internal_endpoint.port -ne 8201 -or $fleet1.expected_public_ip -ne '13.143.18.160') {
        throw 'Fleet 1 canary mapping changed unexpectedly'
    }
    return $routes
}

function Get-Headers {
    if (-not $TokenFile) { throw 'TokenFile is required for API modes' }
    $resolved = (Resolve-Path -LiteralPath $TokenFile).Path
    if (-not [IO.Path]::IsPathRooted($resolved)) { throw 'TokenFile must be absolute' }
    $apiToken = [IO.File]::ReadAllText($resolved).Trim()
    if (-not $apiToken) { throw 'TokenFile is empty' }
    return @{ Authorization = "Bearer $apiToken" }
}

function Invoke-McpApi {
    param([string]$Method,[string]$Path,[object]$Body)
    $parameters = @{
        Uri = $ApiBaseUrl.TrimEnd('/') + $Path
        Method = $Method
        Headers = $script:Headers
        ContentType = 'application/json'
    }
    if ($null -ne $Body) { $parameters.Body = ($Body | ConvertTo-Json -Depth 8 -Compress) }
    return Invoke-RestMethod @parameters
}

function Resolve-Device {
    param([object]$Route)
    $response = Invoke-McpApi -Method GET -Path '/devices?per_page=200' -Body $null
    $items = if ($response.data.data) { @($response.data.data) } elseif ($response.data) { @($response.data) } else { @() }
    $matches = @($items | Where-Object {
        [string]$_.adb_serial -eq [string]$Route.adb_serial -or [string]$_.serial_number -eq [string]$Route.adb_serial
    })
    if ($matches.Count -ne 1) { throw "Expected one live MCP device for $($Route.adb_serial); found $($matches.Count)" }
    return $matches[0]
}

$manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$routes = @(Assert-Manifest $manifest)

if ($Mode -eq 'Validate') {
    $routes | Select-Object fleet_number,route_id,adb_serial,@{n='listener';e={$_.internal_endpoint.port}},@{n='provider_port';e={$_.provider_endpoint.port}},expected_public_ip,rollout_state | Format-Table -AutoSize
    Write-Host 'VALID: 20 exact VLAN 60 devices, 20 unique listeners, 20 unique dedicated IPs, 5 reserve lines.'
    exit 0
}

if (-not $Confirm) { throw 'Write/test API modes require -Confirm' }
$script:Headers = Get-Headers

if ($Mode -eq 'EnrollRoutes') {
    foreach ($route in $routes) {
        $body = @{
            route_id = [string]$route.route_id
            provider = [string]$route.provider
            internal_host = [string]$route.internal_endpoint.hostname_or_ip
            internal_port = [int]$route.internal_endpoint.port
            protocol = [string]$route.protocol
            country = [string]$route.location.country
            classification = [string]$route.classification
            expected_public_ip = [string]$route.expected_public_ip
            assigned_fleet_vlan = 60
            confirm = $true
            idempotency_key = "enroll-$($route.route_id)-v1"
        }
        [void](Invoke-McpApi -Method POST -Path '/proxy-routes' -Body $body)
        Write-Host "ENROLLED $($route.route_id)"
    }
    exit 0
}

if (-not $FleetNumber -or $FleetNumber -lt 1 -or $FleetNumber -gt 20) { throw 'FleetNumber 1-20 is required for this mode' }
if (-not $OperationId -or $OperationId -notmatch '^[A-Za-z0-9._-]{3,80}$') { throw 'A unique OperationId is required for this mode' }
$route = $routes | Where-Object { [int]$_.fleet_number -eq $FleetNumber }
$device = Resolve-Device $route

switch ($Mode) {
    'AssignOne' {
        $currentRoutes = @((Invoke-McpApi -Method GET -Path "/proxy-routes?assigned_device_id=$($device.id)" -Body $null).data)
        $current = $currentRoutes | Where-Object { $null -ne $_.assigned_device_id } | Select-Object -First 1
        if ($current -and [string]$current.route_id -ne [string]$route.route_id) {
            throw "Device already has route $($current.route_id). Release it explicitly before changing routes."
        }
        $probeResult = Invoke-McpApi -Method POST -Path "/proxy-routes/$($route.route_id)/test" -Body @{
            device_id=[int]$device.id; timeout_ms=10000; confirm=$true; idempotency_key="test-$($route.route_id)-$OperationId"
        }
        if (-not $probeResult.data.probe.reachable) {
            throw "Pre-assignment route probe failed for $($route.route_id): $($probeResult.data.probe.error)"
        }
        if ([string]$probeResult.data.probe.observed_public_ip -ne [string]$route.expected_public_ip) {
            throw "Pre-assignment route IP mismatch for $($route.route_id): expected $($route.expected_public_ip), observed $($probeResult.data.probe.observed_public_ip)"
        }
        [void](Invoke-McpApi -Method POST -Path "/proxy-routes/$($route.route_id)/assign" -Body @{
            device_id=[int]$device.id; expected_previous_route_id=$(if($current){[string]$current.route_id}else{$null}); confirm=$true; idempotency_key="assign-$($route.route_id)-$OperationId"
        })
        $verified = Invoke-McpApi -Method POST -Path "/proxy-routes/$($route.route_id)/verify-device-egress" -Body @{
            device_id=[int]$device.id; confirm=$true; idempotency_key="verify-$($route.route_id)-$OperationId"
        }
        Write-Host "VERIFIED Fleet $FleetNumber route=$($route.route_id) device=$($route.adb_serial) egress=$($verified.data.observed_public_ip)"
    }
    'VerifyOne' {
        $verified = Invoke-McpApi -Method POST -Path "/proxy-routes/$($route.route_id)/verify-device-egress" -Body @{
            device_id=[int]$device.id; confirm=$true; idempotency_key="verify-$($route.route_id)-$OperationId"
        }
        Write-Host "VERIFIED Fleet $FleetNumber egress=$($verified.data.observed_public_ip)"
    }
    'ReleaseOne' {
        [void](Invoke-McpApi -Method POST -Path "/proxy-routes/$($route.route_id)/release" -Body @{
            device_id=[int]$device.id; restore_mode='previous'; confirm=$true; idempotency_key="release-$($route.route_id)-$OperationId"
        })
        Write-Host "RELEASED Fleet $FleetNumber and restored its recorded previous proxy state"
    }
}
