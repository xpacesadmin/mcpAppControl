# Mobile Fleet Console local verification

- Date: 2026-09-22
- Branch: `codex/mobile-fleet-console`
- Base/HEAD: `a2a95d2c0b55be6931beab0836b8cb9d9aac0bb6` (`origin/main` at verification time)
- Scope: isolated source, documentation, tests, and a debug APK only

## Results

| Check | Result |
| --- | --- |
| Gateway and Android policy tests | 21 passed, 0 failed |
| Android JVM unit tests | 6 passed, 0 failed, 0 skipped |
| Clean Android build | `testDebugUnitTest`, `assembleDebug`, and `lintDebug` succeeded offline |
| Android lint | 0 fatal, 0 error, 0 warning |
| OpenAPI YAML | Parsed with duplicate keys disabled; OpenAPI 3.1 document contains 20 paths |
| Secret/source policy scan | No private-key marker, bearer literal, runtime secret file, or forbidden Android endpoint found |
| APK signature verification | Valid APK Signature Scheme v2; one standard Android debug signer |

The clean build used JDK 17, Android platform/build tools 34, Gradle 8.9, and only
already-cached dependencies. Gradle emitted its general Gradle-9 deprecation notice,
and the installed Android command-line tools emitted an SDK-XML version compatibility
warning; neither produced a compile, test, packaging, or lint failure.

## Debug APK attestation

- Artifact: `mobile-console/app/build/outputs/apk/debug/app-debug.apk`
- Package: `com.xsalpha.fleetconsole.debug`
- Size: 25,844,966 bytes
- SHA-256: `07A392B9F2056FAE3E2A0521C2D3D7D6E2FF6EEC4558E708E3250718A033A33B`
- Debug certificate SHA-256: `6ddac2f8335137c86860111aa180530b6a5bb813270a5dca0905eae588d86f53`

The packaged permission set is limited to:

- `android.permission.INTERNET`
- `android.permission.ACCESS_NETWORK_STATE`
- `android.permission.USE_BIOMETRIC`
- `android.permission.USE_FINGERPRINT` (biometric compatibility library)
- the app-scoped AndroidX `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`

There is no camera, microphone, location, storage, contacts, SMS, accessibility,
device-administrator, USB, or broad local-discovery permission. The source manifest
declares only the two network permissions; biometric/AndroidX dependencies merge the
remaining normal/app-scoped permissions.

This is a debug-signed canary artifact, not a production release. It is stored in an
ignored build directory and must be rebuilt and owner-signed for a release. Any
rebuild changes the artifact hash and requires a new attestation.

## Security behavior covered locally

- Exact VPN-interface binding and peer-CIDR checks; wildcard, loopback, public, and
  out-of-policy binds are rejected.
- Android refuses network requests unless the active network advertises VPN
  transport, requires pinned TLS 1.3, disables cleartext/redirects/network retries,
  and blocks screenshots/recents capture.
- P-256 proof-of-possession pairing, short-lived access tokens, rotating refresh
  tokens, spent-token reuse revocation, signed method/path/body/timestamp/nonces,
  and replay rejection.
- Viewer/operator/administrator enforcement, default-off writes, fixed action and
  package allowlists, closed request schemas, explicit confirmation/reason, full-
  request idempotency, rate limits, route/scope/halt checks, per-device locks,
  biometric/PIN step-up, sanitized result records, audited rejections, and
  fail-closed interrupted-operation recovery.
- Field-by-field read DTOs exclude desktop tokens, account identifiers, ADB serials,
  internal endpoints, provider details, and screen content.
- Hermes-enabled upstream state fails closed; the Android client contains no Hermes,
  ADB, router, mirror, agent, or desktop-token integration.

## Deliberately not performed

No gateway process was started. No listener, service, firewall, VPN ACL, certificate,
token file, database path, desktop setting, router, mirror, ADB port, device, or
Hermes state was changed. No phone was paired, no APK was installed, and no live
fleet request or command was sent.

The canary remains read-only by default. The dormant scoped-command code cannot be
used unless both the gateway write gate and individual action allowlist are changed
in an owner-approved deployment. Live view is not implemented; its reserved endpoint
returns `phase_not_enabled` and never exposes the existing mirror.

## Required owner approvals and field evidence

1. Approve the exact VPN bind address/port, TLS certificate and pin, service account,
   firewall/VPN ACL, database path, and desktop-token file before starting a listener.
2. Approve the owner phone, viewer role, debug-canary install, and one named canary
   before pairing or testing read-only access.
3. Verify VPN-disconnected, LAN, and WAN negative reachability plus revocation,
   offline/stale behavior, DTO redaction, and full device pagination on that canary.
4. Review a separate single-device live-view implementation and teardown evidence
   before enabling any screen stream.
5. Separately approve each write action and its rollback/cancel evidence before
   changing `MOBILE_GATEWAY_WRITES_ENABLED=0`; then expand one device to three and
   broader scope only through additional reviews.
