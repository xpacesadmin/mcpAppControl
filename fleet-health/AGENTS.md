# Fleet Health control boundary

Owner instruction, 2026-11-12:

- Pandora Agent alone performs fleet automations.
- XSAlpha Agent is outside this project unless explicitly reintroduced by the
  owner. Never reinstall, enable, start, call or use it as a fallback.
- Never start or invoke the legacy MCP to operate phones. Its source is
  historical work to preserve, not an approved control plane.
- Fleet Health is a separate monitoring/maintenance console, not an automation
  runner. The owner explicitly approved its own direct ADB connection for health
  and maintenance on 2026-11-12. Pandora retains all fleet automations.
- Preserve Pandora: no force-stop, accessibility changes, UiAutomation session
  takeover, or private API guessing. Do not use `uiautomator dump` if it would
  suppress the installed accessibility service.
- No Google token/password collection, account removal, automatic re-login,
  purchases, proxy removal, firewall changes or direct-WAN enabling.
- Background health checks may not navigate apps or install updates. Interactive
  Store maintenance must be separate, bounded, cancellable and owner-triggered.
- An inconclusive authentication/update/DNS test stays inconclusive, not green.
