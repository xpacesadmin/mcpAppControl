# ADR 0001: Dedicated VPN-only mobile authorization boundary

- Status: Accepted for local implementation; live deployment pending owner approval
- Date: 2026-09-22

## Context

The desktop API contains useful fleet reads and guarded writes, but it is a broad
loopback API intended for the desktop application. Publishing it, its WebSocket
router, ADB, or the scrcpy mirror would enlarge the attack surface and expose DTOs
that contain fields a phone does not need.

## Decision

Create two separate packages:

- `mobile-gateway/`: a TLS server that binds only to an approved VPN interface,
  authenticates a paired Keystore key, enforces RBAC/rate limits/confirmation/
  idempotency, shapes sanitized `/mobile/v1` DTOs, and invokes only fixed loopback
  desktop methods.
- `mobile-console/`: an Android/Kotlin Jetpack Compose app. It holds no desktop or
  provider credential. Its generated signing and encryption keys remain in Android
  Keystore. It starts in read-only mode and treats offline data as stale.

The gateway uses opaque access/refresh tokens rather than self-contained bearer
claims. That permits immediate revocation and refresh-token reuse detection without
waiting for token expiry. Every authenticated request also carries an ECDSA signature
over the method, exact path, timestamp, nonce, and body hash.

The gateway persists only hashes of pairing codes, access tokens, refresh tokens,
and step-up tokens. The desktop bearer token is read locally at runtime and is never
stored in the gateway database or returned to a client.

Read DTOs are constructed field by field. The gateway does not expose an arbitrary
path, URL, command name, ADB serial, shell, coordinate, proxy editor, account editor,
or workflow body. Writes are disabled by default and each enabled mobile action maps
to one fixed desktop operation.

## Consequences

Positive:

- Compromise of the mobile API does not directly publish the desktop control plane.
- Mobile roles, sessions, replay protection, rate limits, and audits are independent
  and immediately revocable.
- Existing desktop lab controls remain authoritative and provide defense in depth.
- The API is small enough to test for accidental secret disclosure.

Costs:

- The gateway must be deployed and patched as a separate process.
- Pairing and TLS-pin distribution require an owner-mediated desktop flow.
- Live view needs a purpose-built one-device stream broker; the existing mirror
  WebSocket cannot be exposed or handed directly to the APK.

## Rejected alternatives

- Bind the desktop API/router/mirror to `0.0.0.0`: rejected because it exposes a
  broad control plane and makes the desktop bearer token a mobile credential.
- Put the desktop token in the APK: rejected because APKs, backups, logs, and stolen
  phones are not an acceptable secret boundary.
- Use VPN identity alone: rejected because peer compromise would have no application
  role, revocation, request attribution, or replay protection.
- Build the phone as an ADB/scrcpy client: rejected because device access must remain
  brokered by the existing lab controls and tied to named devices.

