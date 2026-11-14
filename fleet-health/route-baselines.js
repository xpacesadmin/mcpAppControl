'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {isIPv4} = require('node:net');

// Read only the existing commissioning registry. Never learn an expected exit
// from a probe, and never open the desktop app (which could migrate its DB).
function loadRouteBaselines(devices, file = process.env.FLEET_ROUTE_DB ||
  (process.env.APPDATA && path.join(process.env.APPDATA, 'MCP Control Bsolutions V2', 'appcontrol.sqlite'))) {
  const overrides = {};
  if (!file || !fs.existsSync(file)) return {overrides, message:'Local commissioning registry unavailable; unconfigured exits remain unverified'};
  let db;
  try {
    const {DatabaseSync} = require('node:sqlite');
    db = new DatabaseSync(file, {readOnly:true});
    const rows = db.prepare('SELECT internal_host, internal_port, expected_public_ip, country, city, health_state FROM proxy_routes').all();
    for (const d of devices.filter(d => !d.expectedExit)) {
      const matches = rows.filter(r => `${r.internal_host}:${r.internal_port}` === d.proxy);
      if (matches.length !== 1) continue;
      const r = matches[0];
      if (r.health_state !== 'verified' || !isIPv4(r.expected_public_ip || '')) continue;
      const timezone = r.country === 'US' ? ({Orem:'America/Denver', 'San Jose':'America/Los_Angeles', 'Santa Clara':'America/Los_Angeles'})[r.city] : null;
      overrides[d.id] = {expectedExit:r.expected_public_ip, ...(timezone ? {timezone} : {}), routeBaselineSource:'Existing MCP commissioning registry (read-only)'};
    }
    return {overrides, message:`${Object.keys(overrides).length} missing exit baselines loaded from the local commissioning registry`};
  } catch {
    return {overrides:{}, message:'Commissioning registry could not be read; no observed exit was promoted to an expected exit'};
  } finally { db?.close(); }
}
module.exports = {loadRouteBaselines};
