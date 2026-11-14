const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dbServer = require('../server/db');
const labControl = require('../server/lab_control');
const proxyRoutes = require('../server/proxy_routes');

test('sql.js file snapshots cannot interrupt a route-swap transaction', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xpace-swap-transaction-'));
  const dbFile = path.join(tempDir, 'test.sqlite');
  const db = await dbServer.open(dbFile);
  t.after(() => {
    db.close();
    const resolved = path.resolve(tempDir);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  if (typeof db.native.export !== 'function') {
    t.skip('Native SQLite does not use sql.js export snapshots');
    return;
  }
  const stamp = dbServer.now();
  db.run('INSERT INTO devices(id,name,serial_number,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    [101, 'Before', 'TX-101', 'online', stamp, stamp]);
  db._firstDirty = Date.now() - 6000; // Previously triggered export() inside the transaction.
  db.exec('BEGIN IMMEDIATE');
  db.run('INSERT INTO devices(id,name,serial_number,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    [102, 'During', 'TX-102', 'online', stamp, stamp]);
  assert.equal(db._transactionActive, true);
  db.exec('COMMIT');
  db.flush();
  assert.equal(db._transactionActive, false);
  const reopened = await dbServer.open(dbFile);
  try { assert.equal(reopened.get('SELECT COUNT(id) AS n FROM devices WHERE id IN (101,102)').n, 2); }
  finally { reopened.close(); }
});

async function setupAssignedSwap(t, count = 2, wrongEgressDevice = null) {
  const previous = Object.fromEntries(['MCP_LAB_SCOPE', 'MCP_ADB_ALLOWLIST', 'MCP_ADB_ALLOWLIST_FILE']
    .map(name => [name, process.env[name]]));
  process.env.MCP_LAB_SCOPE = 'allowlist';
  process.env.MCP_ADB_ALLOWLIST = Array.from({ length: count }, (_, i) => `SWAP-${i + 1}`).join(',');
  process.env.MCP_ADB_ALLOWLIST_FILE = '';
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  const deviceProxy = new Map();
  const routeIp = new Map();
  const timestamp = dbServer.now();
  for (let i = 1; i <= count; i++) {
    const routeId = `swap-route-${i}`;
    const proxy = `192.168.52.10:${8200 + i}`;
    const ip = `203.0.113.${i}`;
    db.run('INSERT INTO devices(id,name,serial_number,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      [i, `Swap ${i}`, `SWAP-${i}`, 'online', timestamp, timestamp]);
    db.run('INSERT INTO proxy_routes(route_id,provider,internal_host,internal_port,protocol,country,region,city,classification,expected_public_ip,assigned_device_id,assigned_fleet_vlan,health_state,observed_public_ip,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [routeId, 'decodo', '192.168.52.10', 8200 + i, 'HTTP', 'US', 'Utah', 'Orem', 'dedicated_static', ip, i, 60, 'verified', ip, timestamp, timestamp]);
    db.run('INSERT INTO proxy_route_assignments(route_id,device_id,state,active,assigned_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      [routeId, i, 'active', 1, timestamp, timestamp, timestamp]);
    deviceProxy.set(i, proxy);
    routeIp.set(proxy, ip);
  }
  labControl.init(db);
  labControl.configure({ confirm: true, canary_device_id: 1 });
  proxyRoutes.init(db, {
    getDeviceProxy: async device => ({ success: true, data: { proxy: deviceProxy.get(device.id) } }),
    applyDeviceProxy: async (device, route) => {
      const proxy = `${route.internal_host}:${route.internal_port}`;
      deviceProxy.set(device.id, proxy);
      return { success: true, data: { actual: proxy } };
    },
    restoreDeviceProxy: async (device, state) => {
      deviceProxy.set(device.id, state.observed_proxy);
      return { success: true };
    },
    probeDeviceRoute: async (_device, route) => ({ success: true, data: { external_ip: route.expected_public_ip } }),
    verifyDeviceEgress: async device => ({ success: true, data: {
      external_ip: device.id === wrongEgressDevice && deviceProxy.get(device.id) !== `192.168.52.10:${8200 + device.id}`
        ? '198.51.100.99' : routeIp.get(deviceProxy.get(device.id)),
    } }),
  });
  return { db, deviceProxy };
}

test('occupied dedicated routes swap atomically between named same-city devices', async t => {
  const { db, deviceProxy } = await setupAssignedSwap(t, 3);
  const input = { confirm: true, device_ids: [1, 2, 3],
    expected_route_ids: ['swap-route-1', 'swap-route-2', 'swap-route-3'], idempotency_key: 'swap-three-1' };
  const result = await proxyRoutes.swapAssignedRoutes(input);
  assert.equal(result.swapped, true);
  assert.deepEqual([1, 2, 3].map(id => proxyRoutes.resolveDeviceRouteContext(id).route.route_id),
    ['swap-route-3', 'swap-route-1', 'swap-route-2']);
  assert.deepEqual([1, 2, 3].map(id => deviceProxy.get(id)),
    ['192.168.52.10:8203', '192.168.52.10:8201', '192.168.52.10:8202']);
  assert.equal((await proxyRoutes.swapAssignedRoutes(input)).idempotent_replay, true);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM proxy_route_assignments WHERE active=1').n, 3);
});

test('egress mismatch restores every phone and halts without changing assignments', async t => {
  const { db, deviceProxy } = await setupAssignedSwap(t, 2, 2);
  await assert.rejects(proxyRoutes.swapAssignedRoutes({ confirm: true, device_ids: [1, 2],
    expected_route_ids: ['swap-route-1', 'swap-route-2'], idempotency_key: 'swap-fail-1' }), /rollback=restored/i);
  assert.deepEqual([deviceProxy.get(1), deviceProxy.get(2)], ['192.168.52.10:8201', '192.168.52.10:8202']);
  assert.deepEqual([1, 2].map(id => proxyRoutes.resolveDeviceRouteContext(id).route.route_id),
    ['swap-route-1', 'swap-route-2']);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM audit_events WHERE operation='proxy_route.swap'").n, 0);
  assert.equal(labControl.state().halted, true);
});

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
test('provider rotation delegates only route metadata to Proxy Orch and is idempotent', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db);
  labControl.init(db);
  labControl.configure({ confirm: true, canary_device_id: 1 });
  const adapter = createAdapter();
  const calls = [];
  proxyRoutes.init(db, {
    ...adapter.options,
    requestProviderRotation: async input => {
      calls.push(input);
      return { accepted: true, status: 202, request_id: input.idempotency_key };
    },
  });

  enrollRoute();
  await proxyRoutes.assign('fleet-canary-01', {
    confirm: true,
    device_id: 1,
    expected_previous_route_id: null,
    idempotency_key: 'provider-assign-1',
  });
  const input = {
    confirm: true,
    device_id: 1,
    idempotency_key: 'provider-rotate-1',
  };
  const result = await proxyRoutes.requestProviderRotation('fleet-canary-01', input);
  const replay = await proxyRoutes.requestProviderRotation('fleet-canary-01', input);

  assert.equal(result.requested, true);
  assert.equal(result.proxy_orch.status, 202);
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['device_id', 'idempotency_key', 'route_id', 'timeout_ms']);
  assert.equal(replay.idempotent_replay, true);
});

test('route geography is strict, audited, idempotent, and resolves a verified device timezone', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db);
  labControl.init(db);
  labControl.configure({ confirm: true, canary_device_id: 1 });
  const adapter = createAdapter();
  proxyRoutes.init(db, adapter.options);

  enrollRoute();
  db.run(
    `UPDATE proxy_routes
     SET assigned_device_id=1,health_state='verified',observed_public_ip=expected_public_ip
     WHERE route_id='fleet-canary-01'`,
  );
  const stamp = dbServer.now();
  db.run(
    `INSERT INTO proxy_route_assignments
      (route_id,device_id,state,active,assigned_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    ['fleet-canary-01', 1, 'active', 1, stamp, stamp, stamp],
  );

  assert.equal(proxyRoutes.resolveRouteTimezone({ city: 'Orem', region: 'UT' }), 'America/Denver');
  assert.equal(proxyRoutes.resolveRouteTimezone({ city: 'San Jose', region: 'California' }), 'America/Los_Angeles');
  assert.equal(proxyRoutes.resolveRouteTimezone({ city: 'Santa Clara', region: 'CA' }), 'America/Los_Angeles');
  assert.equal(proxyRoutes.resolveRouteTimezone({ city: 'Chicago', region: 'Illinois', country: 'US' }), 'America/Chicago');
  assert.equal(proxyRoutes.resolveRouteTimezone({ city: 'Miami', region: 'FL', country: 'US' }), 'America/New_York');
  assert.equal(proxyRoutes.resolveRouteLocale({ city: 'Dallas', region: 'TX', country: 'US' }), 'en-US');
  assert.throws(() => proxyRoutes.resolveRouteTimezone({ city: 'Unknown', region: 'Illinois' }), /no compatible/i);
  assert.throws(
    () => proxyRoutes.updateGeography('fleet-canary-01', {
      confirm: true,
      idempotency_key: 'geo-wrong-ip',
      expected_public_ip: '203.0.113.99',
      city: 'Orem',
      region: 'Utah',
    }),
    /expected_public_ip no coincide/i,
  );

  const input = {
    confirm: true,
    idempotency_key: 'geo-canary-1',
    expected_public_ip: '203.0.113.25',
    city: 'Orem',
    region: 'Utah',
  };
  const updated = proxyRoutes.updateGeography('fleet-canary-01', input);
  const replay = proxyRoutes.updateGeography('fleet-canary-01', input);
  const context = proxyRoutes.resolveDeviceRouteContext(1);

  assert.equal(updated.timezone, 'America/Denver');
  assert.equal(updated.route.city, 'Orem');
  assert.equal(updated.route.region, 'Utah');
  assert.equal(updated.route.timezone, 'America/Denver');
  assert.equal(replay.idempotent_replay, true);
  assert.equal(context.route.route_id, 'fleet-canary-01');
  assert.equal(context.timezone, 'America/Denver');
  assert.equal(context.locale, 'en-US');
  assert.equal(
    db.get("SELECT COUNT(*) AS c FROM audit_events WHERE operation='proxy_route.geography.update'").c,
    1,
  );
});
