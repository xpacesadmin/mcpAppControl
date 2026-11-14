# XSAlpha local AI pilot (FLEET_01 only)

This is a separate MCP stdio client of the local desktop backend. It does **not**
enable the Hermes connector, add a network listener, change proxy routing, or
send provider credentials to a device. The desktop backend stays bound to
`127.0.0.1:8733` and its existing bearer token file remains local.

## Preconditions

1. Start the existing VLAN 60 allowlist desktop lab (`scripts/fleet/start-mcp-cohort-lab.ps1`).
2. Confirm `lab_status` says Hermes disabled and FLEET_01 is in scope.
3. Confirm FLEET_01 (`192.168.60.199:5555`) has the XSAlpha APK and
   Accessibility enabled. `AGENT_PING` must show `ready=true` before relying
   on XSAlpha screen hierarchy. If TikMatrix still owns UiAutomation, release
   **only FLEET_01** from that TikMatrix session and recheck. Do not release
   every device or change FLEET_01's proxy.
4. Keep the test account's private data off screen. The default pilot tools do
   not expose screen captures, UI text, account inventories, or credentials.

## Local client configuration

Launch the bundled `mcp-server/bundle/appcontrol-mcp.cjs` with a local Node
runtime. Set these process environment variables in the MCP client's private
configuration (not in Git or chat):

```text
BACKEND_URL=http://127.0.0.1:8733/api/v1
BACKEND_TOKEN_FILE=<absolute path to the existing local api-token.txt>
MCP_LOCAL_AGENT_TEST=true
MCP_LOCAL_AGENT_DEVICE_ID=1
```

The token file is read by the stdio process; the token value is never placed
in the client configuration. If the local database gives FLEET_01 a different
numeric ID, use the verified ID instead of `1`.

The scoped server advertises only `lab_status` and `device_command`. It also
rejects guessed tool names and commands at dispatch time. The allowed commands
are `AGENT_PING`, `GET_FOREGROUND_APP`, `MEDIA_RESUME_IF_PAUSED`, `PRESS_HOME`,
`PRESS_BACK`, `SCROLL`, and `OPEN_APP`. `OPEN_APP` may launch only Spotify or
YT Music. Every `device_command` call requires `confirm=true` and the one
configured device ID. No installation, account action, proxy change, file
transfer, raw ADB, screen text, or Hermes tool is available in this profile.
The pilot also rejects a backend URL outside the local desktop listener.
For an app-open action, the package belongs inside the nested `params` object:
`{"device_id":1,"command":"OPEN_APP","confirm":true,"params":{"package_name":"com.spotify.music"}}`.
The server also normalizes `package`/`packageName` aliases, but the package must
still be Spotify or YT Music.

Current FLEET_01 state: after TikMatrix released UiAutomation, `AGENT_PING`
reported `ready=true` and a read-only XSAlpha hierarchy request returned a
nonempty XML tree. A Samsung Android 9 `dumpsys accessibility` format had
previously caused a false `accessibility_bound=false`; the parser now accepts
its `packageName=` bound-service entry. Do not re-enable TikMatrix's Auto
WakeUP Agent during XSAlpha testing, or it may reacquire UiAutomation. No AI
client has been attached yet.

## Bounded first test

1. `lab_status`, then `device_command` with `AGENT_PING` on FLEET_01.
2. `GET_FOREGROUND_APP` to establish a baseline. If XSAlpha is not ready,
   stop the AI pilot and resolve its binding first.
3. Ask the local AI client to open **one** approved app (Spotify or YT Music),
   then verify the foreground app. Test a single scroll or state-gated Play.
4. Check the FLEET_01 screen and route/egress independently. Stop on an
   unexpected app, account screen, route mismatch, or control failure.

Luna is a candidate client for short, repetitive tool decisions, but choosing
it is a separate model/runtime decision. Before attaching it, review that its
tool calls and results are handled by that AI provider; if screen text or
captures are ever added, they could contain account data. No AI client is
connected by this document alone.
