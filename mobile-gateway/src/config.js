'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseIp, parseCidr, ipInAnyCidr } = require('./cidr');

const KNOWN_ACTIONS = new Set([
  'refresh_status',
  'capture_screenshot',
  'screen_on',
  'screen_off',
  'home',
  'back',
  'open_package',
  'media_play',
  'media_pause',
  'media_next',
  'stop_task',
  'start_anti_idle',
  'stop_anti_idle',
]);

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function integer(value, fallback, minimum, maximum, label) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function commaSet(value) {
  return new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean));
}

function requireAbsoluteFile(filePath, label, skipFileChecks) {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error(`${label} must be an absolute path`);
  if (!skipFileChecks && !fs.statSync(filePath).isFile()) throw new Error(`${label} must reference a file`);
  return filePath;
}

function normalizeDesktopBaseUrl(raw) {
  const url = new URL(String(raw || 'http://127.0.0.1:8733/api/v1'));
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
    throw new Error('MOBILE_GATEWAY_DESKTOP_BASE_URL must use http://127.0.0.1');
  }
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  if (normalizedPath !== '/api/v1' || url.search || url.hash) {
    throw new Error('MOBILE_GATEWAY_DESKTOP_BASE_URL must end exactly in /api/v1');
  }
  return `http://127.0.0.1:${url.port || '80'}/api/v1`;
}

function loadConfig(env = process.env, options = {}) {
  const skipFileChecks = options.skipFileChecks === true;
  if (bool(env.MCP_HERMES_ENABLED, false)) {
    throw new Error('MCP_HERMES_ENABLED must remain 0 for the mobile gateway');
  }

  const bindHost = String(env.MOBILE_GATEWAY_BIND_HOST || '').trim();
  const parsedBind = parseIp(bindHost);
  if (parsedBind.address === '0.0.0.0' || parsedBind.address === '::' || parsedBind.address === '127.0.0.1' || parsedBind.address === '::1') {
    throw new Error('MOBILE_GATEWAY_BIND_HOST must be a non-loopback VPN interface address');
  }
  const vpnCidrs = String(env.MOBILE_GATEWAY_VPN_CIDRS || '100.64.0.0/10,fd7a:115c:a1e0::/48')
    .split(',').map(item => item.trim()).filter(Boolean).map(parseCidr);
  if (!vpnCidrs.length || !ipInAnyCidr(bindHost, vpnCidrs)) {
    throw new Error('MOBILE_GATEWAY_BIND_HOST is outside MOBILE_GATEWAY_VPN_CIDRS');
  }

  const actions = commaSet(env.MOBILE_GATEWAY_ALLOWED_ACTIONS);
  for (const action of actions) {
    if (!KNOWN_ACTIONS.has(action)) throw new Error(`Unknown mobile action: ${action}`);
  }
  const packages = commaSet(env.MOBILE_GATEWAY_ALLOWED_PACKAGES);
  for (const packageName of packages) {
    if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(packageName)) {
      throw new Error(`Invalid allowed package: ${packageName}`);
    }
  }

  const config = {
    bindHost,
    port: integer(env.MOBILE_GATEWAY_PORT, 8743, 1, 65535, 'MOBILE_GATEWAY_PORT'),
    vpnCidrs,
    tlsCertFile: requireAbsoluteFile(env.MOBILE_GATEWAY_TLS_CERT_FILE, 'MOBILE_GATEWAY_TLS_CERT_FILE', skipFileChecks),
    tlsKeyFile: requireAbsoluteFile(env.MOBILE_GATEWAY_TLS_KEY_FILE, 'MOBILE_GATEWAY_TLS_KEY_FILE', skipFileChecks),
    databaseFile: requireAbsoluteFile(env.MOBILE_GATEWAY_DB_FILE, 'MOBILE_GATEWAY_DB_FILE', skipFileChecks),
    desktopTokenFile: requireAbsoluteFile(env.MOBILE_GATEWAY_DESKTOP_TOKEN_FILE, 'MOBILE_GATEWAY_DESKTOP_TOKEN_FILE', skipFileChecks),
    desktopBaseUrl: normalizeDesktopBaseUrl(env.MOBILE_GATEWAY_DESKTOP_BASE_URL),
    writesEnabled: bool(env.MOBILE_GATEWAY_WRITES_ENABLED, false),
    allowedActions: actions,
    allowedPackages: packages,
    accessTtlSeconds: integer(env.MOBILE_GATEWAY_ACCESS_TTL_SECONDS, 300, 60, 900, 'MOBILE_GATEWAY_ACCESS_TTL_SECONDS'),
    refreshTtlSeconds: integer(env.MOBILE_GATEWAY_REFRESH_TTL_SECONDS, 2592000, 3600, 7776000, 'MOBILE_GATEWAY_REFRESH_TTL_SECONDS'),
    maxClockSkewSeconds: integer(env.MOBILE_GATEWAY_MAX_CLOCK_SKEW_SECONDS, 120, 30, 300, 'MOBILE_GATEWAY_MAX_CLOCK_SKEW_SECONDS'),
    upstreamTimeoutMs: integer(env.MOBILE_GATEWAY_UPSTREAM_TIMEOUT_MS, 5000, 500, 15000, 'MOBILE_GATEWAY_UPSTREAM_TIMEOUT_MS'),
    maxBodyBytes: 64 * 1024,
  };
  return Object.freeze(config);
}

module.exports = { KNOWN_ACTIONS, loadConfig, normalizeDesktopBaseUrl };

