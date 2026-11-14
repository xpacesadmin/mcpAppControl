'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { devicesDto, routeDto, auditDto } = require('../src/dto');
const { safeMetadata } = require('../src/store');

test('mobile device DTOs aggregate account health without account identifiers', () => {
  const result = devicesDto([
    {
      id: 7,
      name: 'FLEET_01',
      serial_number: 'SERIAL-SECRET',
      adb_serial: '192.0.2.10:5555',
      status: 'online',
      proxy_user: 'secret-user',
      proxy_pass: 'secret-pass',
      screen_control_allowed: true,
      battery_level: 80,
      last_seen: '2026-09-22T20:00:00.000Z',
    },
  ], [
    {
      route_id: 'fleet-01-route',
      provider: 'provider-secret',
      internal_endpoint: { host: '10.0.0.3', port: 3128 },
      internal_host: '10.0.0.3',
      expected_public_ip: '198.51.100.10',
      observed_public_ip: '198.51.100.10',
      assigned_device_id: 7,
      assigned_fleet_vlan: 60,
      health_state: 'verified',
    },
  ], [
    {
      id: 99,
      device_id: 7,
      email: 'owner@example.com',
      username: 'owner',
      verification_state: 'needs_reauth',
      last_verified_at: '2026-09-22T19:00:00.000Z',
    },
  ]);

  assert.equal(result[0].name, 'FLEET_01');
  assert.equal(result[0].route.route_id, 'fleet-01-route');
  assert.equal(result[0].account_health.state, 'needs_reauth');
  const serialized = JSON.stringify(result);
  for (const forbidden of ['SERIAL-SECRET', '192.0.2.10:5555', 'secret-user', 'secret-pass', 'provider-secret', '10.0.0.3', 'owner@example.com', 'username']) {
    assert.equal(serialized.includes(forbidden), false, `DTO leaked ${forbidden}`);
  }
});

test('route DTO omits provider, internal endpoint, and expected IP', () => {
  const result = routeDto({
    route_id: 'route-a', provider: 'provider', internal_host: '10.0.0.4', internal_port: 8080,
    expected_public_ip: '198.51.100.1', observed_public_ip: '198.51.100.1', health_state: 'verified',
  });
  assert.deepEqual(Object.keys(result).sort(), [
    'assigned_device_id', 'fleet_vlan', 'health_state', 'last_verified_at',
    'observed_public_ip', 'route_id', 'updated_at',
  ]);
});

test('audit and operation metadata suppress secrets and screen contents', () => {
  const metadata = safeMetadata({
    reason: 'operator test; contact owner@example.com',
    authorization: 'Bearer abc',
    email: 'owner@example.com',
    screenshot: 'base64-image-data',
    nested: { token: 'abc' },
  });
  assert.equal(metadata.reason, 'operator test; contact [REDACTED_EMAIL]');
  assert.equal(metadata.authorization, '[REDACTED]');
  assert.equal(metadata.email, '[REDACTED]');
  assert.equal(metadata.screenshot, '[REDACTED]');
  assert.equal(metadata.nested.token, '[REDACTED]');

  const audit = auditDto({
    id: 1,
    operation: 'example',
    actor: 'operator',
    role: 'operator',
    result: 'ok',
    details: JSON.stringify({ reason: 'contact owner@example.com', password: 'nope' }),
    created_at: '2026-09-22T20:00:00.000Z',
  });
  assert.equal(audit.details.reason.includes('owner@example.com'), false);
  assert.equal('password' in audit.details, false);
  assert.equal(audit.role, 'operator');
});
