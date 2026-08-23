const assert = require('node:assert/strict');
const test = require('node:test');

const dbServer = require('../server/db');
const labControl = require('../server/lab_control');
const antiIdle = require('../server/anti_idle');

function addDevice(db, id, serial, adbSerial) {
  const ts = dbServer.now();
  db.run(
    'INSERT INTO devices(id,name,serial_number,adb_serial,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    [id, `Fleet ${id}`, serial, adbSerial, 'online', ts, ts]
  );
}

function addVerifiedRoute(db, id) {
  const ts = dbServer.now();
  const routeId = `fleet60-fleet${id}-test`;
  const ip = `203.0.113.${id}`;
  db.run(
    `INSERT INTO proxy_routes(
      route_id,provider,internal_host,internal_port,protocol,classification,
      expected_public_ip,assigned_device_id,assigned_fleet_vlan,health_state,
      observed_public_ip,last_verification_time,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [routeId, 'test-provider', '192.168.52.10', 8200 + id, 'HTTP', 'dedicated_static',
      ip, id, 60, 'verified', ip, ts, ts, ts]
  );
  db.run(
    `INSERT INTO proxy_route_assignments(
      route_id,device_id,state,active,idempotency_key,assigned_at,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?)`,
    [routeId, id, 'active', 1, `assignment-${id}`, ts, ts, ts]
  );
}

function withAllowlist(serials, t) {
  const oldScope = process.env.MCP_LAB_SCOPE;
  const oldList = process.env.MCP_ADB_ALLOWLIST;
  process.env.MCP_LAB_SCOPE = 'allowlist';
  process.env.MCP_ADB_ALLOWLIST = serials.join(',');
  t.after(() => {
    if (oldScope === undefined) delete process.env.MCP_LAB_SCOPE; else process.env.MCP_LAB_SCOPE = oldScope;
    if (oldList === undefined) delete process.env.MCP_ADB_ALLOWLIST; else process.env.MCP_ADB_ALLOWLIST = oldList;
  });
}

test('anti-idle requires exact allowlisted devices with verified active routes', async t => {
  const serial = '192.168.60.199:5555';
  withAllowlist([serial], t);
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db, 1, 'fleet-one', serial);
  labControl.init(db);
  antiIdle.init(db, { dispatch: async () => ({ success: true }) });

  assert.throws(() => antiIdle.configure({
    confirm: true,
    device_ids: [1],
    package_names: ['com.android.settings', 'com.android.vending'],
  }), /Rutas no verificadas/i);

  addVerifiedRoute(db, 1);
  const configured = antiIdle.configure({
    confirm: true,
    device_ids: [1],
    package_names: ['com.android.settings', 'com.android.vending'],
    idempotency_key: 'anti-config-1',
  });
  assert.equal(configured.interval_seconds, 480);
  assert.equal(configured.action_duration_seconds, 45);
  assert.equal(configured.gesture_interval_seconds, 4);
  assert.deepEqual(configured.device_ids, [1]);
});

test('anti-idle runs a bounded neutral cycle and waits the configured interval', async t => {
  const serials = ['192.168.60.199:5555', '192.168.60.167:5555'];
  withAllowlist(serials, t);
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db, 1, 'fleet-one', serials[0]);
  addDevice(db, 2, 'fleet-two', serials[1]);
  addVerifiedRoute(db, 1);
  addVerifiedRoute(db, 2);
  labControl.init(db);

  let clock = Date.UTC(2026, 7, 23, 12, 0, 0);
  const commands = [];
  antiIdle.init(db, {
    clock: () => clock,
    sleep: async ms => { clock += ms; },
    dispatch: async (serial, command, params) => {
      commands.push({ serial, command, params });
      return { success: true, message: 'ok' };
    },
  });
  antiIdle.configure({
    confirm: true,
    device_ids: [1, 2],
    package_names: ['com.android.settings', 'com.android.vending', 'com.google.android.gm'],
    interval_seconds: 60,
    action_duration_seconds: 10,
    gesture_interval_seconds: 2,
    idempotency_key: 'anti-config-2',
  });
  antiIdle.start({ confirm: true, run_immediately: false, idempotency_key: 'anti-start-2' });

  const early = await antiIdle.tick();
  assert.equal(early.reason, 'not_due');
  clock += 60000;
  const run = await antiIdle.tick();
  assert.equal(run.accepted, true);
  assert.equal(run.summary.targeted, 2);
  assert.equal(run.summary.executed, 2);
  assert.equal(run.summary.failures, 0);
  assert.ok(run.summary.app_switches > 0);
  assert.ok(run.summary.gestures > 0);
  assert.deepEqual([...new Set(commands.map(item => item.command))].sort(), ['OPEN_APP', 'SCROLL']);

  const waiting = await antiIdle.tick();
  assert.equal(waiting.reason, 'not_due');
  const stopped = antiIdle.stop({ confirm: true, reason: 'test complete', idempotency_key: 'anti-stop-2' });
  assert.equal(stopped.enabled, false);
  const replay = antiIdle.stop({ confirm: true, reason: 'test complete', idempotency_key: 'anti-stop-2' });
  assert.equal(replay.enabled, false);
});
