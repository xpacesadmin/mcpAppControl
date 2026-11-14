# XSAlpha Fleet Console Android client

This package is a separate Kotlin/Jetpack Compose Android application. It talks only
to the dedicated `/mobile/v1` gateway over pinned HTTPS. It contains no desktop API
token, ADB client, device serial, provider credential, account credential, gateway
address, certificate private key, or Hermes integration.

## Security posture

- Only `INTERNET` and `ACCESS_NETWORK_STATE` permissions are declared.
- Cleartext traffic and Android backup/device transfer are disabled.
- The gateway URL must be a `.ts.net` name, Tailscale CGNAT address, or literal
  private/ULA address used by an owner-approved WireGuard deployment.
- Every request also requires Android's active network to advertise VPN transport;
  the client fails closed when Tailscale/WireGuard is disconnected.
- A reviewed `sha256/<base64>` certificate pin is required before pairing.
- The phone creates a P-256 request-signing key and a user-authenticated P-256
  step-up key in Android Keystore.
- Access tokens live only in process memory. Rotating refresh material is encrypted
  with a non-exportable AES-GCM Android Keystore key.
- Authenticated requests are signed over method, exact encoded path/query, timestamp,
  nonce, and body hash. The gateway rejects replayed nonces.
- The default gateway capability response is read-only, so no controls are rendered.
  Later controls appear only for server-approved actions and roles.
- `FLAG_SECURE` prevents pairing/session UI from appearing in screenshots, screen
  recordings, or the system recents preview.

## Build

The project requires JDK 17 and Android SDK platform/build tools 34. It reuses the
repository's checked-in Gradle 8.9 wrapper JAR from `../android-agent`; no duplicate
binary is committed.

```text
gradlew.bat testDebugUnitTest assembleDebug
```

Release signing reads these environment variables at build time; never put their
values in Gradle files or source control:

```text
XSALPHA_CONSOLE_KEYSTORE=<ABSOLUTE_KEYSTORE_PATH>
XSALPHA_CONSOLE_KEYSTORE_PASSWORD=<SECRET>
XSALPHA_CONSOLE_KEY_ALIAS=<ALIAS>
XSALPHA_CONSOLE_KEY_PASSWORD=<SECRET>
```

Without all four variables, `assembleRelease` intentionally produces an unsigned
release artifact. Use a debug APK only for the owner-approved canary.

## Pairing

The owner initiates pairing locally on the Lab VM. Enter or scan only:

- the approved private HTTPS gateway URL;
- the reviewed public certificate pin;
- the single-use short-lived pairing code; and
- a non-sensitive phone label.

The first dashboard is read-only. It shows fleet counts, named devices, route health,
observed public IP, account-presence health, automations, alerts, freshness, and audit
events. Pull-to-refresh and bounded foreground polling stop when the activity stops;
failures retain the last snapshot with a visible offline/stale warning.

## Scoped controls

The APK includes a later-phase control surface, but it is invisible while
`writes_enabled` is false. It accepts only action names and approved package names
advertised by the gateway. Every write displays the exact device, route state,
expected effect, and audit reason, then sends a fresh UUID idempotency key. Stop-task,
automation start/stop, emergency stop, and resume require a new biometric/PIN step-up.
Emergency stop also requires a long press before its confirmation dialog.

There is no raw ADB, shell, terminal, coordinate input, arbitrary keycode, arbitrary
workflow, proxy/account mutation, like, comment, follow, or unattended public
engagement control.

Live screen view is intentionally not enabled in this canary. The app never connects
to the desktop mirror, router, agent, or a device. A later owner-approved phase must
add a single-device gateway stream ticket and teardown validation before any player
is enabled.
