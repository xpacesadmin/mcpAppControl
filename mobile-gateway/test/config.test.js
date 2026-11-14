'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseCidr, ipInCidr, stripAddressDecorations } = require('../src/cidr');
const { loadConfig } = require('../src/config');

function environment(overrides = {}) {
  const placeholder = path.resolve('test-placeholder');
  return {
    MCP_HERMES_ENABLED: '0',
    MOBILE_GATEWAY_BIND_HOST: '100.100.10.20',
    MOBILE_GATEWAY_VPN_CIDRS: '100.64.0.0/10,fd7a:115c:a1e0::/48',
    MOBILE_GATEWAY_TLS_CERT_FILE: placeholder,
    MOBILE_GATEWAY_TLS_KEY_FILE: placeholder,
    MOBILE_GATEWAY_DB_FILE: placeholder,
    MOBILE_GATEWAY_DESKTOP_TOKEN_FILE: placeholder,
    MOBILE_GATEWAY_DESKTOP_BASE_URL: 'http://127.0.0.1:8733/api/v1',
    ...overrides,
  };
}

test('CIDR matching handles Tailscale IPv4, IPv6, and mapped peers', () => {
  assert.equal(ipInCidr('100.64.0.1', parseCidr('100.64.0.0/10')), true);
  assert.equal(ipInCidr('100.127.255.254', '100.64.0.0/10'), true);
  assert.equal(ipInCidr('100.128.0.1', '100.64.0.0/10'), false);
  assert.equal(ipInCidr('fd7a:115c:a1e0::1234', 'fd7a:115c:a1e0::/48'), true);
  assert.equal(stripAddressDecorations('::ffff:100.100.10.20'), '100.100.10.20');
});

test('production config defaults to read-only and accepts an approved VPN bind', () => {
  const config = loadConfig(environment(), { skipFileChecks: true });
  assert.equal(config.bindHost, '100.100.10.20');
  assert.equal(config.writesEnabled, false);
  assert.deepEqual([...config.allowedActions], []);
  assert.equal(config.desktopBaseUrl, 'http://127.0.0.1:8733/api/v1');
});

test('production config rejects wildcard, public, loopback desktop, and Hermes', () => {
  assert.throws(() => loadConfig(environment({ MOBILE_GATEWAY_BIND_HOST: '0.0.0.0' }), { skipFileChecks: true }), /non-loopback VPN/);
  assert.throws(() => loadConfig(environment({ MOBILE_GATEWAY_BIND_HOST: '203.0.113.10' }), { skipFileChecks: true }), /outside/);
  assert.throws(() => loadConfig(environment({ MOBILE_GATEWAY_DESKTOP_BASE_URL: 'http://100.100.10.1:8733/api/v1' }), { skipFileChecks: true }), /127\.0\.0\.1/);
  assert.throws(() => loadConfig(environment({ MCP_HERMES_ENABLED: '1' }), { skipFileChecks: true }), /must remain 0/);
});

test('unknown command actions and malformed package names are rejected', () => {
  assert.throws(() => loadConfig(environment({ MOBILE_GATEWAY_ALLOWED_ACTIONS: 'raw_adb' }), { skipFileChecks: true }), /Unknown mobile action/);
  assert.throws(() => loadConfig(environment({ MOBILE_GATEWAY_ALLOWED_PACKAGES: 'not a package' }), { skipFileChecks: true }), /Invalid allowed package/);
});

