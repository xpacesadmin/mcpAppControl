# XSAlpha Fleet Health — local console

Start: `powershell -ExecutionPolicy Bypass -File .\Start-Fleet-Health.ps1`

Requires Node 22+, Pandora View Control's bundled tools/adb.exe (or FLEET_ADB), and local
Codex CLI sign-in for optional AI diagnosis. No npm install is required. Listener:
127.0.0.1:8790 only. The launcher opens a per-run authenticated browser session.

## Scope and ownership

Pandora Agent is the only fleet automation agent (owner decision, 2026-11-12).
XSAlpha Agent is retired unless the owner explicitly brings it back. The legacy
MCP must not issue fleet commands. Fleet Health is a separate monitoring and
maintenance console; it never loads the old MCP runtime or installs an agent.
The owner explicitly approved independent direct ADB for health/maintenance
on 2026-11-12. The console does not start the old MCP or restart the ADB server.

This directory is the complete feature boundary. It does not modify the legacy
MCP runtime, Pandora, Hermes, Proxy Orch, firewall, routing ACLs, or DNS rules.
Each box has exactly 20 inventory entries. Absent devices remain visible.
Route assignments are in inventory.js, based on commissioning history; live
observations never silently overwrite assigned routes. At startup, missing Box 1
expected exits and known city timezones are read from the existing MCP commissioning
registry, opened read-only (never migrated or written). Set FLEET_ROUTE_DB to its
path on another controller. Only unique, verified endpoint records with valid IPs
are accepted. Missing registry data remains unknown. Box 2's existing London route
is not overwritten. The registry is an expected baseline, not proof of live egress.

## Use

1. Sync all: read-only ADB checks, bounded to 3 devices at once, no retries.
   Missing/stale proxy evidence is refreshed once per connected phone through its
   configured, assigned proxy only. Fresh successful evidence is reused for 10 minutes.
2. Verify proxy paths: same checks, forcing one proxy-only HTTPS request per phone.
   A proxy assignment mismatch is reported without testing a different route.
3. Sidebar: Overview, Servers, Activity & Requests. Servers shows both VLAN boxes
   together, with brief alarm reasons next to each fleet. Select a device for
   Health & accounts or Google & apps. Manual app-update confirmations are an
   always-visible section, separate from Local AI options, not app-row expanders.
   Overview contains summary and monitor controls. Activity shows findings totals
   and requested/started/finished timestamps in the browser's displayed timezone.
   See results expands the saved per-fleet checks from that request. Reports are
   loaded on demand; expanding them does not run another scan. Older requests
   without retained findings are labeled, never reconstructed from live state.
4. Repairs: owner confirmation required. Clock/timezone sync; restore assigned
   Android proxy; open account settings; open Play Store. No automated sign-in,
   account removal, proxy removal, firewall change, or reboot. Play Store updates
   use the separately confirmed, single-device maintenance action below.
5. Ask local AI worker: separate Codex job, Sol/max, 5 minute cap. Shell tools,
   web search, inherited user config/MCP, and subagents disabled. Health snapshot
   only, email addresses omitted. Recommendations cannot execute repairs.

Queue is durable. Restarted jobs become interrupted, never replayed. Cancel
terminates the local subprocess; it cannot undo a command already applied.
Historical duration estimates are estimates, not guaranteed completion times.

## 60-second health monitor

The console has a server-side read-only health scheduler, separate from the
optional AI diagnostic worker and from Pandora's automation routines. The UI
toggle enables/disables it; the preference persists in ignored local state.
It starts OFF until explicitly enabled. While enabled and the server is running:

- Every 60 seconds it queues one normal scan of the commissioned inventory.
- If another job is running/queued, that interval is skipped, never backlogged.
- Each background scan has a 90-second ceiling and at most 3 concurrent devices.
- Proxy egress uses the existing 10-minute cache; it is not tested every minute.
- No app navigation, sign-in attempts, updates, repairs or AI requests occur.
- Google Sync Status is inspected for recent authentication errors/successes.
- On any commissioned English-language phone, a Play Store screen already left
  open by the operator is read using local OCR. Other apps are never interrupted.
- Closing the browser does not stop it; toggle OFF or stop Fleet Health to pause.

## Google / Play Store maintenance: all 40 commissioned devices

Select any device's Google & apps tab to use **Check Google sign-in**,
**Scan pending updates** or **Update Apps**. The two checks share a read-only
Store inspection; they do not update apps or attempt to sign in automatically.
Each requires confirmation. Pause Pandora routines on this phone first: no
Pandora API lock exists, so Fleet Health cannot coordinate a running routine.
Foreground changes and unexpected screens stop maintenance, not Pandora.

- The scan opens the installed Store's VIEW_MY_DOWNLOADS intent, reads English
  screen text with Windows' local OCR, and reopens the previous app. It does not
  install an APK, acquire UiAutomation, change accessibility, or log screenshots.
- Sign-in/verification prompts are critical. Network/loading errors are unknown,
  not falsely labeled sign-outs. No credentials or authentication tokens are read.
- Update Apps presses the recognized **Update all** once, then observes for at
  most six five-second intervals (plus read time). A download request is not
  completion. If downloads outlast this observation, Store stays open so the
  60-second health monitor can detect completion. Returning to another app pauses
  screen-based completion detection; a later owner-triggered scan can verify it.
- A confirmed zero-updates Store result automatically refreshes installed versions
  and clears older pending-update flags on that phone. No manual per-app
  confirmation is needed. Evidence is bound to that phone's account/user, proxy
  and observed versions; it never promotes a version to a fleet-wide baseline.
  Play services and Play Store remain separately managed system components.
- No purchases, installs of missing apps, account switching, clearing app data,
  re-login, or retries on unknown layouts. Update all is Play Store's offered
  installed-app set, not just the dashboard's curated app list. Updates may use
  data and restart affected apps. Android/Store may continue after Cancel.
- Pandora process/accessibility binding and configured proxy are checked before,
  during, and after. Mismatches stop the job; no automatic settings override.
- Three-minute job limit; one selected device per request, one serialized queue.
  All 40 inventory devices have the same controls; no bulk app navigation or
  unrequested updates occur. Raw OCR/screenshots stay in memory, not audit/state.
- Store results expire after 24h and invalidate on Android account/user or proxy
  changes. They concern the selected Store account and may reflect Store cache.
  A zero total is device-local Store availability evidence, not a guarantee of
  globally latest releases or authentication in every installed app.
- The UI deliberately does not click Android authentication screens. Review and
  re-sign-in manually when needed; Pandora retains all automation ownership.

## Evidence limitations

- ADB reachable does not prove Pandora connected. No Pandora API is integrated.
- AccountManager presence is not authentication-token or app-login validation.
  Recent Google sync success is scoped evidence of authenticated sync, not proof
  of all app sessions. Old auth errors do not become current critical alerts.
  Recent per-service authentication failures (for example Calendar alone) are
  orange review warnings, not proof the whole Google account is signed out.
  An explicitly observed Store sign-in prompt is red. Active Android user only.
- App versions are NOT Play Store availability. Owner-confirmed pending-update
  evidence and model/Android/ABI-specific approved baselines expire after 7 days.
  Release channels, architecture and staged rollouts may differ. No downgrade.
- Google Play services / Play Store are checked for installation, enabled state,
  suspension and hiding for the active Android user. Missing/disabled core
  components are critical; disabled installed optional Google apps are warnings.
  This does not prove app sign-in, Google Admin service policy or playback works.
- Health snapshot freshness: 10 minutes. Egress failure may be probe-service
  failure. No direct route is attempted on any proxy failure.
- Proxy probe success does not prove DNS/WAN leak protection. No active leak
  test or firewall inspection is included in this first release.
- Green means *operational checks* have recent passing evidence, including core
  Google components and a matching commissioned proxy exit. Unknown update or
  login validity stays visible as separate gray verification coverage, not a pass.
  Known pending updates remain orange. Unknown operational evidence stays gray.
- Timezone matches the assigned proxy, not the controller location. Locale is
  inspected, not automatically changed. No GPS spoofing is performed.
- Clock repair disables Android auto_time/auto_time_zone; reads the resulting
  clock instead of treating Samsung exit 255 alone as failure.

## Private data / security

data/ is ignored by Git: session token, observed email addresses, snapshots,
job history, and audit log. Do not commit or share it. No provider password or
Google token is collected. Only account identifier lines are extracted from
Android account dumps. Loopback bind, Host and Origin checks, API session token,
CSP and no arbitrary command endpoint. Account addresses stay in the local UI;
they are stripped from AI payloads. A local authenticated operator can repair
any inventory device; this is not a multi-user remote service.

AI integration uses the documented Codex noninteractive execution surface;
the worker is not this existing chat. Model/account access is checked on actual
submission. No credentials are copied out of Codex's normal sign-in storage.

Tests: `node --test test/*.test.js`. If the owner-enabled health monitor preference
is saved, it resumes after startup with its first opportunity 60 seconds later.
Stop: terminate only the PID in data/launch.json after verifying it is this
server.js process. Do not kill all Node, ADB, or Pandora processes.

Official integration reference: https://developers.openai.com/codex/app-server

Android package inspection reference: https://developer.android.com/tools/adb
Google Play in-app updates are an app-owned integration, not a fleet-wide update
inventory API: https://developer.android.com/guide/playcore/in-app-updates

Play Store maintenance flow: https://support.google.com/googleplay/answer/113412
Local OCR: https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine
