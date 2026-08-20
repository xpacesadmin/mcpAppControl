# Fleet lab runtime

This runtime keeps the Hermes connector, subnet scanning, and automatic Android
agent installation disabled. Device inventory is populated only from explicit
owner-approved ADB serials.

## Lab VM allowlist

Create this local file on the machine running the desktop application:

    %APPDATA%\MCP Control Bsolutions V2leet-allowlist.txt

Put one approved ADB serial on each line. Blank lines and lines beginning with
# are ignored. Do not put account credentials, proxy credentials, tokens, or
provider URLs in this file.

Start the application with start-all.ps1. A different restricted file can be
selected with -FleetAllowlistFile.

The dashboard and the devices_list MCP operation can inventory the complete
allowlist. Lab write operations and scrcpy control remain scoped to the canary
selected through configure_lab.

## Stabilizer portability

devices_stabilize now defaults to copying the epoch from the machine running
the MCP and verifies the device clock after setting it. The timezone is selected
in this order:

1. the tool timezone argument;
2. MCP_DEFAULT_TIMEZONE;
3. the MCP host operating-system timezone;
4. UTC.

The Lab VM therefore needs a healthy host clock. Set MCP_DEFAULT_TIMEZONE to an
IANA identifier such as America/Chicago when the VM timezone should not be used.
clock_source=automatic remains available when Android network time is preferred.

## Stable route rotation

rotate_proxy_route changes only one named device from its expected active route
to a verified, unassigned route. The operation requires confirmation and an
idempotency key. It chooses the next compatible route deterministically unless
target_route_id is supplied, verifies the observed egress IP, and reactivates
the previous assignment on mismatch.

Provider credentials never enter the MCP route registry. Route enforcement is
behind the proxy-route adapter. The current canary adapter can use Android
global proxy while the soft-router adapter is pending; later, that callback is
replaced by the soft-router route script without changing the MCP tool contract.

## Screen control

The upstream scrcpy mirror is available in the lab dashboard. Its WebSocket and
frame endpoints validate the selected canary before starting a session. Opening
a mirror does not enable Hermes.

## Provider IP refresh requests

request_proxy_rotation does not accept a rotation URL, headers, a token, or a
request body. It sends only the active route ID, named device ID, and idempotency
key to an internal Proxy Orch control adapter. Configure the Lab VM with:

    MCP_PROXY_ORCH_CONTROL_URL=http://<private-proxy-orch-control-address>:<port>
    MCP_PROXY_ORCH_CONTROL_TOKEN_FILE=<restricted-local-token-file>

The token file is an MCP-to-Proxy-Orch control credential; upstream provider
credentials and provider refresh URLs remain on Proxy Orch. The control endpoint
must implement POST /api/v1/proxy-routes/{route_id}/rotate. Until that adapter is
deployed, the MCP returns a configuration error and performs no rotation.

The collaborator's legacy /api/v1/proxy_rotation endpoints are disabled because
they stored provider URLs, headers, and request bodies in the MCP database.
