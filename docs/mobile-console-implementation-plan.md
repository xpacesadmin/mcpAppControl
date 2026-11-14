# XSAlpha Fleet Console implementation and rollout plan

## Local implementation order

1. Validate loopback bindings, lab controls, existing DTOs, and Hermes-off defaults.
2. Define the threat model, ADR, and versioned `/mobile/v1` contract.
3. Implement and test gateway pairing, signed short-lived sessions, refresh rotation,
   revocation, RBAC, rate limits, mobile audits, and sanitized read DTOs.
4. Build the Compose APK with Keystore identity, certificate pinning, encrypted
   refresh storage, pairing, read-only dashboard, pull-to-refresh, and visible stale/
   offline behavior.
5. Add a closed command mapping and asynchronous operation records behind a default-
   off server feature gate. Keep command UI absent while the gateway reports read-only.
6. Design the single-device stream ticket contract, but do not attach the existing
   mirror to a VPN listener until a canary live-view review approves it.

## Owner approval gates

No approval is needed for local source, unit tests, or documentation in the isolated
worktree. The following are live changes and require explicit owner approval:

- install dependencies or build tooling from the network;
- select a real VPN address, port, TLS certificate, database path, or token-file path;
- change host firewall, Tailscale ACL, WireGuard config, DNS, routes, services, or
  startup configuration;
- pair a real phone, grant a role, install an APK, or enable the gateway listener;
- enable writes, stream brokering, or a scope larger than the approved canary;
- run any command against a fleet device, including emergency stop/resume tests.

## Canary evidence sequence

1. Confirm from the Lab VM that desktop API, router, mirror, and ADB remain loopback/
   private and Hermes reports disabled.
2. Confirm the gateway is reachable only from the enrolled VPN peer and presents the
   reviewed certificate pin.
3. Pair one owner phone as `viewer`, revoke it, and prove both access and refresh stop.
4. Re-pair as `viewer`; compare read DTOs with the desktop for one approved named
   canary, including freshness and offline behavior.
5. After separate approval, validate one immutable single-device stream ticket and
   teardown behavior.
6. After separate approval, enable one declarative command at a time, verify route/
   scope/halt/idempotency/audit behavior, then validate emergency stop and resume.
7. Review one-device evidence before three-device scope and three-device evidence
   before any broader allowlist.

## Definition of done for the read-only milestone

- The APK contains no endpoint, token, credential, serial, or certificate private key.
- The gateway cannot start on wildcard, loopback, or non-approved bind addresses.
- Viewer reads are signed, rate-limited, revocable, paginated, sanitized, and carry
  explicit freshness metadata.
- Account responses contain state/counts/times only; route responses contain no
  provider or internal endpoint; audit responses redact identifiers and secrets.
- VPN loss, expired auth, upstream failure, and stale data are obvious and cause no
  automatic write or retry storm.
- `MCP_HERMES_ENABLED=0` remains the required runtime posture.

