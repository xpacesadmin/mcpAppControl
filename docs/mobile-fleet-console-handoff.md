# XSAlpha Mobile Fleet Console — project handoff

## Purpose

Build a separate Android APK that provides a secure mobile companion to the existing MCP/TikMatrix fleet-management workflow. The application should let an authorized owner check fleet health while away from the desktop, open a live view of one device, and send a small set of explicitly scoped commands through the existing MCP control plane.

This is a separate project and branch. It must not turn the owner's phone into an ADB controller, expose the lab to the public Internet, duplicate provider credentials, or enable Hermes.

Suggested product name: **XSAlpha Fleet Console**.

## Non-negotiable boundaries

- Begin read-only. The first usable APK shows status, routes, account health, recent activity, alerts, and audit events; it sends no device commands.
- Connect only while the phone is on the owner's private Tailscale/WireGuard network. Do not expose an API, WebSocket, ADB port, scrcpy port, or dashboard to the public Internet.
- Do not connect the phone directly to TCP 5555, the Android agents, Proxy Orch, 3proxy, or the command router on port 6011.
- All commands follow this path: mobile APK -> authenticated mobile gateway -> loopback MCP API -> existing lab controls -> router -> ADB or XSAlpha Agent.
- Keep the existing desktop API and command router bound to `127.0.0.1`. Do not change them to `0.0.0.0`.
- Never embed the desktop bearer token, proxy credentials, account credentials, provider URLs, TOTP seeds, enrollment credentials, or SSH material in the APK, source tree, build artifacts, logs, screenshots, crash reports, or push notifications.
- Keep `MCP_HERMES_ENABLED=0`. The mobile project must not import, call, or configure the Hermes connector.
- Preserve the fleet kill switch, allowlist, route verification, confirmation, idempotency, rollback, and audit requirements. A mobile client must never bypass them.
- Do not reverse-engineer or embed TikMatrix. Reproduce only the fleet-management experience using owner-controlled MCP APIs and screen streams.

## Repository and branch startup

The current MCP repository is `mcpAppControl-working`. Its working tree may contain uncommitted fleet and YT Music work. In the new task:

1. Inspect `git status`, remotes, and the current branch without modifying anything.
2. Ask the owner which clean commit is the base if the working tree is dirty or the intended base is ambiguous.
3. Create an isolated worktree and branch named `codex/mobile-fleet-console` from the approved base. Do not carry unrelated uncommitted changes into it.
4. Put the Android client in `mobile-console/`. Prefer a distinct gateway package such as `mobile-gateway/` so VPN-facing code is not mixed into the loopback desktop API.
5. Do not commit, push, open a PR, or merge until the owner reviews the design and explicitly approves those operations.

## Recommended architecture

```text
Owner Android phone
  XSAlpha Fleet Console APK
  Android Keystore device key + short-lived session
            |
            | HTTPS/WSS over Tailscale or approved WireGuard only
            v
Lab VM: Mobile Gateway (new, VPN-interface-only listener)
  authentication + RBAC + command policy + rate limits
  per-request confirmation + idempotency + audit attribution
            |
            | localhost only; desktop bearer token stays on Lab VM
            v
MCP desktop API 127.0.0.1:8733
  lab allowlist + kill switch + route checks + audit
            |
            v
Command Router 127.0.0.1:6011 / existing scrcpy bridge
            |
            v
Named fleet device through ADB or XSAlpha Agent
```

The mobile gateway is an authorization boundary, not a generic reverse proxy. It must expose a purpose-built `/mobile/v1` contract and map each allowed operation to a narrow MCP call. It must reject arbitrary URLs, arbitrary ADB commands, raw shell input, direct database access, and pass-through desktop bearer tokens.

Use Android/Kotlin with Jetpack Compose unless the owner chooses another client stack. Store refresh material only in Android Keystore-backed encrypted storage. Avoid broad Android permissions; the console does not need USB debugging, accessibility, device administrator, contacts, SMS, or local-network discovery.

## Authentication and authorization

Use both network and application identity:

1. **Network gate:** Tailscale ACL or approved WireGuard peer permits only the owner's enrolled phone to reach the gateway's private VPN address and port. LAN and WAN interfaces remain closed.
2. **Application pairing:** an administrator starts pairing on the desktop, which produces a single-use, short-lived code or QR payload. Pairing registers the phone's generated public key; it must not contain the desktop API token.
3. **Sessions:** issue short-lived access tokens and rotating refresh tokens bound to the registered mobile device. Store only hashes/server-side identifiers on the gateway. Support immediate revocation and a “revoke all mobile sessions” action from the desktop.
4. **RBAC:** implement at least `viewer`, `operator`, and `administrator`.
   - `viewer`: status, account-health state, route-health state, sanitized logs, and live screen view.
   - `operator`: viewer rights plus approved low-risk commands for explicitly selected devices.
   - `administrator`: operator rights plus mobile session management and emergency stop/resume. Route reassignment, APK installation, account enrollment, credential operations, raw ADB, and network changes remain desktop-only during the initial release.
5. **Step-up confirmation:** multi-device commands, stop/resume, automation start, and any later high-impact feature require biometric/PIN re-authentication plus a confirmation screen listing exact device names and the requested action.

Every write request needs a client-generated idempotency key, actor/session ID, named target device IDs, reason, and confirmation. The gateway must send the existing MCP confirmation fields where required and record success, rejection, timeout, and cancellation without recording secrets.

## Mobile feature phases

### Phase 1 — read-only dashboard

- Fleet totals: online, busy, offline, error, and halted state.
- Named-device list with VLAN, assigned route ID, route health, observed public IP, timezone, battery/health, current task, and last seen.
- Account inventory health such as present, re-sign-in required, possible swap, and last verification time. Never return passwords, cookies, tokens, TOTP values, or full authentication artifacts.
- Active automation/guard status and recent task outcomes.
- Sanitized alerts and audit timeline.
- Pull-to-refresh and authenticated real-time change notifications.
- No command buttons in the first canary build.

### Phase 2 — live view

- Explicitly open one named device at a time; no automatic wall of live streams.
- Reuse the Lab VM's existing scrcpy capture. The mobile gateway authorizes the requested device, starts or attaches to the local stream, and returns a short-lived single-device WSS stream ticket.
- Default to a conservative resolution, frame rate, and bitrate. Stop the stream promptly when the app backgrounds, the session expires, the VPN drops, the device leaves scope, or the operator closes the view.
- The gateway must prevent changing the `serial` after authorization and prevent one device's frames from appearing in another device's session.
- Live viewing remains available to `viewer`; touch/key injection is not part of this phase.

### Phase 3 — scoped commands

Start with a small declarative allowlist, for example:

- refresh device status;
- capture one screenshot;
- screen on/off and Home/Back;
- open an approved installed package;
- play/pause/next media;
- start/stop one already-defined automation on one named device;
- stop a running task;
- fleet emergency stop.

Do not add a terminal, arbitrary shell/ADB field, arbitrary coordinate macro, arbitrary workflow JSON, or generic proxy editor. For each command, show target, action, expected effect, and current route status before confirmation. The backend remains authoritative: a halted lab, route mismatch, device outside the allowlist, missing confirmation, reused/invalid idempotency key, or insufficient role must fail closed.

### Phase 4 — controlled expansion

- Validate one owner-approved canary, preferably `FLEET_01`, before adding more devices.
- Expand to three devices only after reviewing mobile audit events, stream isolation, command accuracy, resource load, and kill-switch behavior.
- Expand to the full approved allowlist only after owner sign-off. Do not scan VLAN 60 or 61 from the phone or gateway.
- Keep Hermes disabled until a separate owner-approved integration phase.

## Existing code to reuse or wrap

The paths below are useful references; do not expose them directly to the mobile network.

- `desktop/main.js` — starts the loopback API, command router, screen mirror, and background services; also owns the local API token lifecycle.
- `desktop/server/app.js` — current Express API, bearer-token middleware, lab endpoints, device endpoints, automation endpoints, account inventory, reports, and audit access.
- `desktop/server/lab_control.js` — device allowlist, allowed command classes, confirmation requirements, emergency stop/resume, idempotency, redaction, and audit helpers. Mobile writes must pass through these controls.
- `desktop/server/db.js` — existing roles, API-key metadata, device/task tables, screenshots, and `audit_events`. Add mobile identities/sessions as a separate schema; do not reuse plaintext user password fields as-is.
- `desktop/router.js` — loopback HTTP/WebSocket bridge to ADB and agents. It is an internal service and must remain unreachable from the phone.
- `desktop/adb/mirror.js` — scrcpy stream lifecycle and the existing authenticated `/mirror` WebSocket.
- `desktop/dashboard/js/mirror-client.js` — current frame protocol/client behavior; use it as a protocol reference rather than copying the local desktop token into the APK.
- `desktop/dashboard/js/dashboard.js`, `views-ui.js`, and `monitor-ui.js` — current status concepts and presentation behavior.
- `desktop/server/proxy_routes.js` — stable route IDs, assignment/verification, rollback, redaction, and route audit behavior.
- `desktop/server/account_inventory.js` — credential-free account-presence health and sanitized audit behavior.
- `desktop/server/anti_idle.js` and `desktop/server/youtube_music_guard.js` — explicit configure/start/stop/status patterns, verified-route checks, bounded execution, and restart-off behavior.
- `mcp-server/src/index.ts` — MCP tool contracts and safe parameter shapes. The mobile app calls the mobile gateway, not the MCP stdio server.
- `start-all.ps1` and `docs/FLEET_LAB_RUNTIME.md` — current lab-mode defaults: exact allowlist, no subnet scan, no automatic agent installation, Hermes off.

Useful existing read APIs to adapt behind `/mobile/v1` include:

- `GET /api/v1/lab/status`
- `GET /api/v1/lab/audit`
- `GET /api/v1/devices`, `/devices/stats`, and `/devices/:id`
- `GET /api/v1/dashboard/stats` and `/dashboard/realtime`
- `GET /api/v1/accounts/inventory`
- `GET /api/v1/proxy-routes` and `/proxy-routes/:routeId`
- `GET /api/v1/tasks`, `/tasks/stats`, and `/reports/*`
- `GET /api/v1/anti-idle`
- `GET /api/v1/youtube-music/guard`

Useful existing guarded writes to wrap, only in their approved phases, include:

- `POST /api/v1/lab/emergency-stop`
- `POST /api/v1/lab/resume`
- `POST /api/v1/devices/batch-command`
- `POST /api/v1/tasks/:id/cancel` and `/api/v1/tasks/stop`
- explicit start/stop endpoints for anti-idle and the YT Music guard

Do not expose legacy proxy/account mutation endpoints merely because they exist. The gateway should maintain its own explicit route allowlist and response DTOs so confidential or unnecessary database fields never reach the phone.

## Kill switch, auditing, and safe failure

- Put a prominent, hold-to-confirm emergency-stop control in the mobile UI. It calls the existing MCP emergency stop and reports whether cancellation requests succeeded. It must not clear or bypass device proxy state.
- When the lab is halted, the mobile gateway permits read-only status/audit access and rejects other writes. Resume requires administrator role, step-up authentication, reason, confirmation, and a new idempotency key; schedules stay disabled unless separately reviewed.
- Audit pairing, login, refresh, logout, revocation, view starts/stops, command requests, confirmations, rejections, results, kill-switch operations, and permission changes.
- Include actor, mobile-device identity, role, named fleet target, operation, idempotency key, result, and timestamp. Redact authorization headers, session identifiers, email addresses where not required, screen contents, provider details, and all secrets.
- Rate-limit authentication, screen starts, refreshes, and commands. Reject concurrent/conflicting writes to the same device and provide a visible cancellation path.
- If VPN connectivity, gateway authentication, route verification, or target identity becomes uncertain, stop issuing new commands and show a clear stale/offline state.

## Initial mobile API contract

Define and version a small contract rather than mirroring every desktop endpoint:

```text
POST   /mobile/v1/pair/complete
POST   /mobile/v1/session/refresh
POST   /mobile/v1/session/logout
GET    /mobile/v1/me
GET    /mobile/v1/fleet/summary
GET    /mobile/v1/devices
GET    /mobile/v1/devices/{id}
GET    /mobile/v1/devices/{id}/account-health
GET    /mobile/v1/routes
GET    /mobile/v1/automations
GET    /mobile/v1/audit
POST   /mobile/v1/devices/{id}/stream-ticket
POST   /mobile/v1/commands
POST   /mobile/v1/emergency-stop
POST   /mobile/v1/resume
```

Use typed request/response models, pagination, server timestamps, and an explicit `data_freshness` field. A command response should return an accepted operation ID; the app observes its status rather than holding a long HTTP request open. Never let the client choose an internal MCP URL or command name that has not been mapped by the gateway.

## Test and acceptance checklist

### Security and network

- [ ] With Tailscale/WireGuard disconnected, the APK cannot reach the gateway.
- [ ] From LAN and public WAN addresses, the gateway port, MCP port 8733, router port 6011, mirror endpoint, and ADB port 5555 are not reachable.
- [ ] The gateway listens only on the approved VPN interface/address and uses authenticated TLS/WSS.
- [ ] No desktop bearer token or other secret exists in the APK, repository, logs, screenshots, backups, or crash output.
- [ ] A stolen/revoked mobile session stops working immediately; refresh-token reuse is detected and revoked.
- [ ] Viewer, operator, and administrator permissions are enforced server-side, not only hidden in the UI.
- [ ] Responses and audit records contain no proxy passwords, tokens, TOTP seeds, cookies, or account credentials.
- [ ] Hermes remains disabled before, during, and after every test.

### Read-only dashboard

- [ ] Fleet counts and per-device states match the desktop for the approved canary.
- [ ] Route ID, verification state, observed IP, account health, task state, and timestamps are correctly labeled and stale data is obvious.
- [ ] Pagination and real-time refresh do not silently omit devices.
- [ ] Offline backend, expired session, and interrupted VPN produce a safe read-only/offline state without retry storms.

### Live view

- [ ] Only the requested allowlisted canary is streamed.
- [ ] Stream tickets are short-lived, single-device, single-purpose, and unusable after logout/revocation.
- [ ] Closing/backgrounding the APK tears down the stream promptly.
- [ ] Cross-device frame substitution and serial-parameter tampering are rejected.
- [ ] One live stream stays within agreed Lab VM CPU, memory, and bandwidth limits.
- [ ] Opening a stream does not start Hermes or alter proxy, account, timezone, app, or automation state.

### Commands and safety

- [ ] Every write shows the exact named target and requires the correct role and confirmation.
- [ ] Duplicate submissions with the same idempotency key execute at most once.
- [ ] Out-of-allowlist targets, route mismatches, ambiguous identity, halted state, stale sessions, and unsupported commands fail closed.
- [ ] Emergency stop blocks new work and requests cancellation while leaving existing proxy protection intact.
- [ ] Resume is administrator-only, audited, and does not automatically restart schedules.
- [ ] Disconnecting the phone mid-command does not cause repeated execution; final status is recoverable by operation ID.
- [ ] All writes and screen sessions appear in the sanitized audit timeline with the correct actor and device.

### Rollout

- [ ] Phase 1 passes on one owner-approved canary before live view is enabled.
- [ ] Live view passes on one canary before any control command is enabled.
- [ ] Each command type is tested individually with a documented expected result and rollback/cancel behavior.
- [ ] The owner reviews one-device evidence before three-device expansion and reviews three-device evidence before full-allowlist expansion.
- [ ] No VLAN scan, firewall relaxation, listener exposure, Hermes connection, or direct ADB-from-phone behavior was introduced.

## Deliverables for the separate task

1. Threat model and API contract for owner review before implementation.
2. Isolated `codex/mobile-fleet-console` worktree/branch from an owner-approved clean base.
3. VPN-only mobile gateway with pairing, session revocation, RBAC, rate limits, audit attribution, and read-only DTOs.
4. Android APK with read-only dashboard first.
5. Canary live-view implementation and evidence.
6. Separately approved scoped-command implementation and kill-switch validation.
7. Build/run documentation that contains placeholders only—never real addresses, tokens, credentials, or account data.

## Copy/paste prompt for the new Codex task

> Read `docs/mobile-fleet-console-handoff.md` completely and treat it as the project contract. First inspect the repository and Git state read-only. Prepare a threat model, architecture decision record, versioned `/mobile/v1` API proposal, and phased implementation plan for owner review. Use a separate isolated worktree and branch `codex/mobile-fleet-console` only after the owner confirms the clean base. Build the read-only Android dashboard first. Require Tailscale/WireGuard-only access through a dedicated authenticated gateway; keep the MCP API, router, mirror internals, ADB, fleet devices, and Proxy Orch off the public network. Never embed secrets, never connect the phone directly to ADB or fleet agents, preserve allowlist/route/kill-switch/audit/RBAC controls, and keep Hermes disabled. Do not implement writes or live device control until the owner separately approves each phase. Do not commit, push, open a PR, or merge without explicit owner approval.
