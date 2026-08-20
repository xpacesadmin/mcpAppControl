const assert = require('node:assert/strict');
const test = require('node:test');

const dbServer = require('../server/db');
const labControl = require('../server/lab_control');
const deviceAccounts = require('../server/device_accounts');
const proxyRoutes = require('../server/proxy_routes');

function addDevice(db) {
  const timestamp = dbServer.now();
  db.run(
    'INSERT INTO devices(id,name,serial_number,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    [1, 'Fleet 1', 'CANARY-1', 'online', timestamp, timestamp]
  );
}

test('Google enrollment uses native UI, exposes only counts, and gates supervised rotation', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db);
  labControl.init(db);
  labControl.configure({ confirm: true, canary_device_id: 1 });

  let accountCount = 0;
  const commands = [];
  deviceAccounts.init(db, {
    dispatchDevice: async (_serial, command) => {
      commands.push(command);
      if (command === 'GET_GOOGLE_ACCOUNTS') {
        return { success: true, data: { account_count: accountCount, identifiers_exposed: false } };
      }
      return { success: true, data: { credentials_captured: false } };
    },
  });

  const started = await deviceAccounts.startEnrollment(1, {
    confirm: true,
    idempotency_key: 'google-enroll-test-1',
  });
  assert.equal(started.enrollment_state, 'awaiting_owner');
  assert.equal(started.credentials_captured, false);
  assert.ok(commands.includes('OPEN_GOOGLE_ACCOUNT_ENROLLMENT'));

  accountCount = 1;
  const verified = await deviceAccounts.verifyEnrollment(1, {
    confirm: true,
    idempotency_key: 'google-verify-test-1',
  });
  assert.equal(verified.enrollment_verified, true);
  assert.equal(verified.google_account_count, 1);
  assert.equal(verified.identifiers_exposed, false);

  const policy = deviceAccounts.setRotationAllowed(1, {
    enabled: true,
    confirm: true,
    idempotency_key: 'google-rotation-policy-test-1',
  });
  assert.equal(policy.rotation_allowed, true);
  await assert.rejects(
    () => deviceAccounts.openRotation(1, { confirm: true, idempotency_key: 'google-rotation-open-test-1' }),
    /at least two|al menos dos/i
  );

  accountCount = 2;
  const opened = await deviceAccounts.openRotation(1, {
    confirm: true,
    idempotency_key: 'google-rotation-open-test-2',
  });
  assert.equal(opened.native_ui_opened, true);
  assert.equal(opened.automatic_os_account_switch, false);
  assert.ok(commands.includes('OPEN_GOOGLE_ACCOUNT_SETTINGS'));
});

test('direct release clears Android proxy and preserves the recorded prior state', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db);
  labControl.init(db);
  labControl.configure({ confirm: true, canary_device_id: 1 });

  let proxy = '192.168.40.10:3129';
  proxyRoutes.init(db, {
    getDeviceProxy: async () => ({ success: true, data: { proxy } }),
    applyDeviceProxy: async (_device, route) => {
      proxy = `${route.internal_host}:${route.internal_port}`;
      return { success: true, data: { actual: proxy } };
    },
    restoreDeviceProxy: async (_device, state) => {
      proxy = state.proxy_enabled ? `${state.proxy_host}:${state.proxy_port}` : null;
      return { success: true, data: { actual: proxy } };
    },
  });
  proxyRoutes.enroll({
    confirm: true,
    route_id: 'fleet-canary-01',
    provider: 'decodo',
    internal_host: '192.168.52.10',
    internal_port: 8201,
    protocol: 'HTTP',
    classification: 'dedicated_static',
    expected_public_ip: '203.0.113.25',
  });
  await proxyRoutes.assign('fleet-canary-01', {
    confirm: true,
    device_id: 1,
    expected_previous_route_id: null,
    idempotency_key: 'direct-assign-test-1',
  });
  const released = await proxyRoutes.release('fleet-canary-01', {
    confirm: true,
    device_id: 1,
    restore_mode: 'direct',
    idempotency_key: 'direct-release-test-1',
  });

  assert.equal(proxy, null);
  assert.equal(released.restore_mode, 'direct');
  assert.equal(released.previous_proxy_state.observed_proxy, '192.168.40.10:3129');
  assert.equal(released.rollback_proxy_state.proxy_enabled, false);
  assert.equal(proxyRoutes.inspect('fleet-canary-01').assignment, null);
});
