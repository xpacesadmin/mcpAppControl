const assert = require('node:assert/strict');
const test = require('node:test');

const dbServer = require('../server/db');
const labControl = require('../server/lab_control');
const proxyRoutes = require('../server/proxy_routes');

function addDevice(db) {
  const timestamp = dbServer.now();
  db.run(
    'INSERT INTO devices(id,name,serial_number,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    [1, 'Canary', 'CANARY-1', 'online', timestamp, timestamp]
  );
}

function createAdapter(initialProxy = '192.168.40.10:3129') {
  let proxy = initialProxy;
  let externalIp = null;
  let forcedExternalIp = null;
  return {
    get proxy() { return proxy; },
    set externalIp(value) { forcedExternalIp = value; },
    options: {
      getDeviceProxy: async () => ({ success: true, data: { proxy } }),
      applyDeviceProxy: async (_device, route) => {
        proxy = `${route.internal_host}:${route.internal_port}`;
        externalIp = route.expected_public_ip;
        return { success: true, data: { actual: proxy } };
      },
      restoreDeviceProxy: async (_device, previousState) => {
        proxy = previousState.proxy_enabled ? `${previousState.proxy_host}:${previousState.proxy_port}` : null;
        return { success: true, data: { actual: proxy } };
      },
      probeDeviceRoute: async (_device, route) => ({
        success: true,
        data: { external_ip: route.expected_public_ip },
      }),
      verifyDeviceEgress: async () => ({
        success: true,
        data: { external_ip: forcedExternalIp || externalIp },
      }),
    },
  };
}

function enrollRoute(overrides = {}) {
  const routeId = overrides.route_id || 'fleet-canary-01';
  return proxyRoutes.enroll({
    confirm: true,
    idempotency_key: overrides.idempotency_key || 'enroll-' + routeId,
    route_id: routeId,
    provider: 'decodo',
    internal_host: '192.168.52.10',
    internal_port: overrides.internal_port || 8201,
    protocol: 'HTTP',
    classification: 'dedicated_static',
    expected_public_ip: overrides.expected_public_ip || '203.0.113.25',
    assigned_fleet_vlan: 60,
    country: 'US',
    region: 'Utah',
    city: 'Orem',
  });
}

test('route enrollment is credential-free; assign applies and release restores the Android proxy', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db);
  labControl.init(db);
  labControl.configure({ confirm: true, canary_device_id: 1 });
  const adapter = createAdapter();
  proxyRoutes.init(db, adapter.options);

  assert.throws(() => proxyRoutes.enroll({
    confirm: true,
    route_id: 'fleet-canary-01',
    provider: 'example',
    internal_host: '192.168.52.10',
    internal_port: 8201,
    protocol: 'HTTP',
    password: 'forbidden',
  }), /prohibido|prohibited/i);

  const route = enrollRoute();
  assert.equal(route.route_id, 'fleet-canary-01');
  assert.equal(JSON.stringify(route).includes('password'), false);

  const routeProbe = await proxyRoutes.testRoute('fleet-canary-01', {
    confirm: true,
    device_id: 1,
    idempotency_key: 'route-test-1',
  });
  assert.equal(routeProbe.probe.reachable, true);
  assert.equal(routeProbe.probe.source, 'named_device');

  const first = await proxyRoutes.assign('fleet-canary-01', {
    confirm: true,
    device_id: 1,
    expected_previous_route_id: null,
    idempotency_key: 'route-assign-1',
  });
  const replay = await proxyRoutes.assign('fleet-canary-01', {
    confirm: true,
    device_id: 1,
    expected_previous_route_id: null,
    idempotency_key: 'route-assign-1',
  });

  assert.equal(first.assignment.state, 'applied');
  assert.equal(adapter.proxy, '192.168.52.10:8201');
  assert.equal(replay.idempotent_replay, true);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM proxy_route_assignments').c, 1);

  const released = await proxyRoutes.release('fleet-canary-01', {
    confirm: true,
    device_id: 1,
    idempotency_key: 'route-release-1',
  });
  assert.equal(released.released, true);
  assert.equal(adapter.proxy, '192.168.40.10:3129');
  assert.equal(proxyRoutes.inspect('fleet-canary-01').assignment, null);
});

test('egress mismatch restores the prior proxy and halts the lab', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db);
  labControl.init(db);
  labControl.configure({ confirm: true, canary_device_id: 1 });
  const adapter = createAdapter();
  proxyRoutes.init(db, {
    ...adapter.options,
    verifyDeviceEgress: async () => ({ success: true, data: { external_ip: '203.0.113.99' } }),
  });

  enrollRoute();
  await proxyRoutes.assign('fleet-canary-01', {
    confirm: true,
    device_id: 1,
    expected_previous_route_id: null,
    idempotency_key: 'route-assign-2',
  });

  const result = await proxyRoutes.verifyDeviceEgress('fleet-canary-01', {
    confirm: true,
    device_id: 1,
    idempotency_key: 'verify-2',
  });

  assert.equal(result.matches, false);
  assert.equal(result.observed_public_ip, '203.0.113.99');
  assert.equal(result.rollback.restored, true);
  assert.equal(adapter.proxy, '192.168.40.10:3129');
  assert.equal(labControl.state().halted, true);
  assert.equal(proxyRoutes.inspect('fleet-canary-01').health_state, 'mismatch');
  assert.equal(proxyRoutes.inspect('fleet-canary-01').assignment, null);
});

test('failed device apply restores prior proxy and leaves no active assignment', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db);
  labControl.init(db);
  labControl.configure({ confirm: true, canary_device_id: 1 });
  const adapter = createAdapter();
  proxyRoutes.init(db, {
    ...adapter.options,
    applyDeviceProxy: async () => ({ success: false, message: 'simulated apply failure' }),
  });
  enrollRoute();

  await assert.rejects(() => proxyRoutes.assign('fleet-canary-01', {
    confirm: true,
    device_id: 1,
    expected_previous_route_id: null,
    idempotency_key: 'route-assign-failed',
  }), /simulated apply failure/);

  assert.equal(adapter.proxy, '192.168.40.10:3129');
  assert.equal(proxyRoutes.inspect('fleet-canary-01').assignment, null);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM proxy_route_assignments WHERE active=1').c, 0);
});

test('rotation selects a verified free route, verifies egress, and releases the prior route', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db);
  labControl.init(db);
  labControl.configure({ confirm: true, canary_device_id: 1 });
  const adapter = createAdapter();
  proxyRoutes.init(db, adapter.options);

  enrollRoute();
  enrollRoute({
    route_id: 'fleet-canary-02',
    internal_port: 8202,
    expected_public_ip: '203.0.113.26',
  });
  await proxyRoutes.testRoute('fleet-canary-02', {
    confirm: true,
    device_id: 1,
    idempotency_key: 'route-test-rotate-2',
  });
  await proxyRoutes.assign('fleet-canary-01', {
    confirm: true,
    device_id: 1,
    expected_previous_route_id: null,
    idempotency_key: 'route-assign-rotate-1',
  });

  const result = await proxyRoutes.rotate({
    confirm: true,
    device_id: 1,
    expected_previous_route_id: 'fleet-canary-01',
    idempotency_key: 'route-rotate-1',
  });

  assert.equal(result.rotated, true);
  assert.equal(result.route.route_id, 'fleet-canary-02');
  assert.equal(result.verification.matches, true);
  assert.equal(adapter.proxy, '192.168.52.10:8202');
  assert.equal(proxyRoutes.inspect('fleet-canary-01').assignment, null);
  assert.equal(proxyRoutes.inspect('fleet-canary-02').assignment.device_id, 1);
});

test('rotation mismatch restores and reactivates the previous route', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db);
  labControl.init(db);
  labControl.configure({ confirm: true, canary_device_id: 1 });
  const adapter = createAdapter();
  proxyRoutes.init(db, adapter.options);

  enrollRoute();
  enrollRoute({
    route_id: 'fleet-canary-02',
    internal_port: 8202,
    expected_public_ip: '203.0.113.26',
  });
  await proxyRoutes.testRoute('fleet-canary-02', {
    confirm: true,
    device_id: 1,
    idempotency_key: 'route-test-mismatch-2',
  });
  await proxyRoutes.assign('fleet-canary-01', {
    confirm: true,
    device_id: 1,
    expected_previous_route_id: null,
    idempotency_key: 'route-assign-mismatch-1',
  });
  adapter.externalIp = '203.0.113.99';

  await assert.rejects(() => proxyRoutes.rotate({
    confirm: true,
    device_id: 1,
    expected_previous_route_id: 'fleet-canary-01',
    idempotency_key: 'route-rotate-mismatch',
  }), /IP de salida inesperada/);

  assert.equal(adapter.proxy, '192.168.52.10:8201');
  assert.equal(proxyRoutes.inspect('fleet-canary-01').assignment.device_id, 1);
  assert.equal(proxyRoutes.inspect('fleet-canary-02').assignment, null);
  assert.equal(labControl.state().halted, true);
});