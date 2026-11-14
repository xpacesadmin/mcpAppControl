# XSAlpha Fleet Console threat model

Status: implemented design baseline for local review. No live listener, route, DNS,
firewall, account, proxy, fleet, or Hermes change is authorized by this document.

## Security objectives

1. A phone can reach only a purpose-built mobile API while connected through an
   owner-approved Tailscale or WireGuard path.
2. Loss of the APK, an access token, or a refresh token does not expose the desktop
   API bearer token, provider credentials, account credentials, or arbitrary ADB.
3. A viewer cannot write. An operator can invoke only named, declarative actions on
   named devices. An administrator is still constrained by the same allowlist,
   confirmation, route-health, kill-switch, and audit checks.
4. Uncertain identity, stale authorization, route mismatch, replay, VPN loss, and
   upstream failure all fail closed.
5. Hermes remains disabled and outside this system.

## Assets

- Desktop API bearer token stored only on the Lab VM.
- Mobile device signing keys stored in Android Keystore.
- Rotating mobile refresh material stored with Keystore-backed encryption.
- Fleet device identities, route assignments and health, account-presence state,
  task state, and sanitized audit events.
- The lab emergency-stop state and the integrity of its existing safety controls.

The following are deliberately not mobile assets and never cross the gateway:
proxy usernames/passwords, provider rotation URLs, account email addresses,
passwords, cookies, TOTP seeds, Android enrollment material, SSH material, ADB
serials, raw screen contents in logs, and the desktop bearer token.

## Trust boundaries

```text
Android app + Keystore
  | authenticated HTTPS/WSS over approved VPN only
  v
Mobile gateway (VPN-interface listener and authorization boundary)
  | fixed, loopback-only HTTP client; desktop token added here
  v
Desktop API 127.0.0.1:8733
  | existing lab controls
  v
Router/mirror 127.0.0.1 and named devices
```

Tailscale/WireGuard provides the network gate. It does not replace application
authentication. The mobile gateway provides application authentication and policy.
It does not replace the desktop lab allowlist, route checks, or kill switch.

## Architecture validation findings

- `desktop/main.js` binds the desktop API to `127.0.0.1`; `desktop/router.js` binds
  port 6011 to `127.0.0.1`; and the scrcpy mirror selects a loopback listener. These
  bindings must remain unchanged.
- `start-all.ps1` sets `MCP_HERMES_ENABLED=0`. The mobile packages contain no Hermes
  import or endpoint mapping.
- The desktop bearer middleware protects `/api/v1`, but the desktop response shapes
  are not all appropriate for mobile. In particular, account inventory includes
  account identifiers and proxy-route responses include internal endpoints and
  provider data. The gateway must construct new DTOs field by field.
- The desktop batch-command endpoint accepts a command name. Even though lab control
  validates it, the gateway must never forward a phone-provided command name. It maps
  a closed mobile action enum to fixed desktop operations.
- Existing task-stop behavior and some legacy mutations are broader than the initial
  mobile release. They remain unavailable unless a dedicated mapping, role, step-up,
  confirmation, idempotency, and route/scope policy is present.
- The original tree has no `youtube_music_guard.js` at the approved base commit. The
  mobile contract reports that guard as unavailable rather than copying uncommitted
  work from another checkout.

## Threats and mitigations

| Threat | Primary mitigations |
| --- | --- |
| Public or LAN exposure | Production startup requires a literal bind address inside configured VPN CIDRs, rejects wildcard/loopback/public binds, uses TLS only, and checks each peer address. Host firewall and VPN ACL validation remain deployment acceptance steps. |
| Stolen access token | Five-minute opaque access token, request signature bound to method/path/body/timestamp/nonce, nonce replay cache, immediate session/device revocation. |
| Stolen refresh token | Keystore-encrypted client storage, server-side hash only, rotation on every use, family revocation when a spent token is reused. |
| Pairing interception | Single-use short-lived code, proof of possession of the generated device key, TLS certificate pin supplied by the desktop pairing flow, audited completion. |
| Request replay or mutation | ECDSA P-256 request signatures, body hash, bounded clock skew, unique nonce, idempotency key for writes. |
| Privilege escalation | Server-side `viewer`, `operator`, and `administrator` checks; UI visibility is not an authorization decision. |
| Arbitrary ADB or internal URL access | No generic proxy route; fixed upstream methods and fixed mobile action mappings; raw shell, coordinates, workflow JSON, URLs, serials, and command names are rejected. |
| Secret leakage in DTOs/logs | Field-by-field DTO construction, structured redaction, small request limits, authorization/signature headers never logged, account health is aggregated. |
| Cross-device command/stream confusion | Mobile requests use database device IDs and names; the gateway re-resolves the target, checks scope and route assignment, and never accepts an ADB serial. Stream tickets are designed to bind one session to one immutable device. |
| Duplicate command after retry | Client UUID idempotency key, unique server record, asynchronous operation status, no automatic write retry. |
| Compromised operator phone | VPN ACL, revocation, role limits, named-device scope, write feature gates, biometric-backed step-up for high-impact actions, and audit attribution. |
| Halt bypass | Gateway checks halt state before ordinary writes; the desktop remains authoritative. Read access continues while halted. Resume is administrator-only with step-up and never restarts schedules. |
| Engagement automation abuse | There is no mapping for like, comment, follow, probabilistic engagement, arbitrary tap, or workflow JSON. Future public engagement must use an operator-reviewed draft/approval flow under a separate review. |
| Hermes activation | No mobile mapping/import; production documentation requires `MCP_HERMES_ENABLED=0`; the gateway refuses a desktop status reporting Hermes enabled. |

## Safe failure behavior

- A missing/expired session, invalid signature, nonce reuse, public peer address,
  ambiguous target, route mismatch, unhealthy route, halted lab, or stale desktop
  response produces a bounded error and no write.
- Mobile reads use short timeouts and do not retry indefinitely. The APK keeps the
  last in-memory snapshot visibly marked stale/offline.
- Writes are never retried automatically. Their status is recovered by operation ID.
- Backgrounding the app stops polling. A future live-view implementation must also
  tear down its one-device stream immediately.

## Residual risks and deployment approvals

The source can be built and tested locally without touching the lab. Before a real
listener or APK is deployed, the owner must separately approve the exact VPN bind
address/port, TLS certificate and pin distribution, firewall/VPN ACLs, gateway data
path, desktop-token file path, initial phone/role, and canary device. Enabling
`MOBILE_GATEWAY_WRITES_ENABLED=1`, stream brokering, or any non-canary scope requires
another explicit review with live evidence.

