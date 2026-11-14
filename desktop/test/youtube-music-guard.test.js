const assert = require('node:assert/strict');
const test = require('node:test');

const dbServer = require('../server/db');
const labControl = require('../server/lab_control');
const guard = require('../server/youtube_music_guard');

function addDeviceAndRoute(db, id, serial) {
  const ts = dbServer.now();
  db.run(
    'INSERT INTO devices(id,name,serial_number,adb_serial,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    [id, `Fleet ${id}`, serial, serial, 'online', ts, ts]
  );
  const routeId = `route-${id}`;
  const ip = `203.0.113.${id}`;
  db.run(
    `INSERT INTO proxy_routes(
      route_id,provider,internal_host,internal_port,protocol,classification,expected_public_ip,
      assigned_device_id,assigned_fleet_vlan,health_state,observed_public_ip,last_verification_time,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [routeId, 'test', '192.168.52.10', 8200 + id, 'HTTP', 'dedicated_static', ip, id, 60, 'verified', ip, ts, ts, ts]
  );
  db.run(
    `INSERT INTO proxy_route_assignments(route_id,device_id,state,active,idempotency_key,assigned_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [routeId, id, 'active', 1, `assignment-${id}`, ts, ts, ts]
  );
}

function allowlist(serials, t) {
  const oldScope = process.env.MCP_LAB_SCOPE;
  const oldList = process.env.MCP_ADB_ALLOWLIST;
  process.env.MCP_LAB_SCOPE = 'allowlist';
  process.env.MCP_ADB_ALLOWLIST = serials.join(',');
  t.after(() => {
    if (oldScope === undefined) delete process.env.MCP_LAB_SCOPE; else process.env.MCP_LAB_SCOPE = oldScope;
    if (oldList === undefined) delete process.env.MCP_ADB_ALLOWLIST; else process.env.MCP_ADB_ALLOWLIST = oldList;
  });
}

test('YT Music guard is explicit, route-gated, batched, debounced, and restart-off', async t => {
  const serials = ['192.168.60.199:5555', '192.168.60.200:5555'];
  allowlist(serials, t);
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDeviceAndRoute(db, 1, serials[0]);
  addDeviceAndRoute(db, 2, serials[1]);
  labControl.init(db);

  let clock = Date.UTC(2026, 8, 22, 12, 0, 0);
  const calls = [];
  let mode = 'handle';
  guard.init(db, {
    clock: () => clock,
    dispatch: async (serial, command, params) => {
      calls.push({ serial, command, params });
      if (mode === 'handle' && params.act) {
        return { success: true, data: { handled: true, detected: true, reason: 'resumed', ui_status: 'ui_unavailable', prompt_detected: false } };
      }
      if (mode === 'prompt') {
        return { success: true, data: { handled: false, detected: true, reason: 'detect_only', ui_status: 'prompt_detected', prompt_detected: true } };
      }
      return { success: true, data: { handled: false, reason: 'prompt_absent' } };
    },
  });
  const configured = guard.configure({
    confirm: true,
    device_ids: [1, 2],
    poll_interval_seconds: 30,
    cooldown_seconds: 90,
    batch_size: 1,
    idempotency_key: 'ytm-config-1',
  });
  assert.equal(configured.enabled, false);
  assert.deepEqual(configured.device_ids, [1, 2]);
  guard.start({ confirm: true, run_immediately: false, idempotency_key: 'ytm-start-1' });
  assert.equal((await guard.tick()).reason, 'not_due');

  clock += 30000;
  const first = await guard.tick();
  assert.equal(first.summary.targeted, 1);
  assert.equal(first.summary.handled, 1);
  assert.equal(calls[0].params.act, true);
  assert.equal(first.state.devices.find(row => row.device_id === 1).prompt_latched, false, 'generic media resume does not create a prompt latch');

  clock += 30000;
  mode = 'clear';
  await guard.tick();
  assert.equal(calls[1].serial, serials[1], 'batch cursor advances to the next device');

  clock += 30000;
  mode = 'prompt';
  const debounced = await guard.tick();
  assert.equal(calls[2].serial, serials[0]);
  assert.equal(calls[2].params.act, false, 'cooldown detects the prompt without another click');
  assert.equal(debounced.summary.handled, 0);
  assert.equal(debounced.summary.detected_debounced, 1);
  assert.equal(debounced.state.devices.find(row => row.device_id === 1).prompt_latched, true, 'only the strict prompt is latched');

  clock += 30000;
  mode = 'clear';
  await guard.tick();

  clock += 30000;
  mode = 'handle';
  const afterCooldown = await guard.tick();
  assert.equal(calls[4].serial, serials[0]);
  assert.equal(calls[4].params.act, true, 'prompt latch cannot suppress a paused-state resume after cooldown');
  assert.equal(afterCooldown.summary.handled, 1);

  const stopped = guard.stop({ confirm: true, reason: 'test stop', idempotency_key: 'ytm-stop-1' });
  assert.equal(stopped.enabled, false);
  guard.shutdown();
  const freshPath = require.resolve('../server/youtube_music_guard');
  delete require.cache[freshPath];
  const freshGuard = require('../server/youtube_music_guard');
  const restarted = freshGuard.init(db, { clock: () => clock, dispatch: async () => ({ success: true }) });
  assert.equal(restarted.enabled, false);
  assert.equal(restarted.running, false);
});

test('YT Music guard refuses unverified routes and requires confirmation', async t => {
  const serial = '192.168.60.199:5555';
  allowlist([serial], t);
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  const ts = dbServer.now();
  db.run(
    'INSERT INTO devices(id,name,serial_number,adb_serial,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    [1, 'Fleet 1', serial, serial, 'online', ts, ts]
  );
  labControl.init(db);
  guard.init(db, { dispatch: async () => ({ success: true }) });
  assert.throws(() => guard.configure({ device_ids: [1] }), /confirm=true/i);
  assert.throws(() => guard.configure({
    confirm: true, device_ids: [1], idempotency_key: 'ytm-unverified-1',
  }), /Rutas no verificadas/i);
});
