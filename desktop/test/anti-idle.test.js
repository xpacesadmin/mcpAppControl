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

function orientationAwareDispatch(commands) {
  return async (serial, command, params) => {
    commands.push({ serial, command, params });
    if (command === 'SETTINGS_GET') {
      const value = params.key === 'accelerometer_rotation' ? '1' : '2';
      return { success: true, message: 'setting read', data: { value } };
    }
    return { success: true, message: 'ok', data: {} };
  };
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
    pace: 'careful',
    lock_portrait: false,
    idempotency_key: 'anti-config-1',
  });
  assert.equal(configured.interval_seconds, 480);
  assert.equal(configured.action_duration_seconds, 45);
  assert.equal(configured.gesture_interval_seconds, 4);
  assert.equal(configured.scrolls_before_dwell, 3);
  assert.equal(configured.video_dwell_seconds, 180);
  assert.equal(configured.natural_scrolls_enabled, true);
  assert.equal(configured.package_cursor, 0);
  assert.equal(configured.selected_package, 'com.android.settings');
  assert.equal(configured.pace, 'careful');
  assert.equal(configured.action_settle_ms, 1200);
  assert.equal(configured.lock_portrait, false);
  assert.deepEqual(configured.device_ids, [1]);
});

test('anti-idle runs a bounded neutral cycle, restores orientation, and waits the configured interval', async t => {
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
    dispatch: orientationAwareDispatch(commands),
  });
  const configured = antiIdle.configure({
    confirm: true,
    device_ids: [1, 2],
    package_names: ['com.android.settings', 'com.android.vending', 'com.google.android.gm'],
    interval_seconds: 60,
    action_duration_seconds: 10,
    gesture_interval_seconds: 2,
    idempotency_key: 'anti-config-2',
  });
  assert.equal(configured.pace, 'standard');
  assert.equal(configured.action_settle_ms, 700);
  assert.equal(configured.lock_portrait, true);
  antiIdle.start({ confirm: true, run_immediately: false, idempotency_key: 'anti-start-2' });

  const early = await antiIdle.tick();
  assert.equal(early.reason, 'not_due');
  clock += 60000;
  const run = await antiIdle.tick();
  assert.equal(run.accepted, true);
  assert.equal(run.summary.targeted, 2);
  assert.equal(run.summary.executed, 2);
  assert.equal(run.summary.failures, 0);
  assert.equal(run.summary.orientation_restore_failures, 0);
  assert.ok(run.summary.app_switches > 0);
  assert.ok(run.summary.gestures > 0);
  assert.equal(run.summary.dwell_count, 0);
  assert.equal(run.summary.selected_package, 'com.android.settings');
  assert.equal(run.summary.package_cursor_before, 0);
  assert.equal(run.summary.package_cursor_after, 1);
  assert.equal(run.state.package_cursor, 1);
  assert.equal(run.state.selected_package, 'com.android.vending');
  const actions = commands.filter(item => !item.command.startsWith('SETTINGS_'));
  assert.deepEqual([...new Set(actions.map(item => item.command))].sort(), ['OPEN_APP', 'SCROLL']);
  assert.ok(actions.filter(item => item.command === 'OPEN_APP').every(item => item.params.package_name === 'com.android.settings'));
  assert.ok(actions.filter(item => item.command === 'SCROLL').every(item => item.params.direction === 'down'));
  for (const serial of ['fleet-one', 'fleet-two']) {
    assert.deepEqual(
      commands
        .filter(item => item.serial === serial && item.command === 'SETTINGS_PUT')
        .map(item => [item.params.key, item.params.value]),
      [
        ['accelerometer_rotation', 0],
        ['user_rotation', 0],
        ['user_rotation', 2],
        ['accelerometer_rotation', 1],
      ],
    );
  }

  const waiting = await antiIdle.tick();
  assert.equal(waiting.reason, 'not_due');
  const stopped = antiIdle.stop({ confirm: true, reason: 'test complete', idempotency_key: 'anti-stop-2' });
  assert.equal(stopped.enabled, false);
  const replay = antiIdle.stop({ confirm: true, reason: 'test complete', idempotency_key: 'anti-stop-2' });
  assert.equal(replay.enabled, false);

  commands.length = 0;
  antiIdle.configure({
    confirm: true,
    device_ids: [1, 2],
    package_names: ['com.android.settings', 'com.android.vending'],
    interval_seconds: 60,
    action_duration_seconds: 10,
    gesture_interval_seconds: 2,
    natural_scrolls_enabled: false,
    idempotency_key: 'anti-config-3',
  });
  const noScrollState = antiIdle.state();
  assert.equal(noScrollState.natural_scrolls_enabled, false);
  antiIdle.start({ confirm: true, run_immediately: false, idempotency_key: 'anti-start-3' });
  clock += 60000;
  const noScrollRun = await antiIdle.tick();
  assert.equal(noScrollRun.accepted, true);
  assert.equal(noScrollRun.summary.gestures, 0);
  assert.equal(noScrollRun.summary.orientation_restore_failures, 0);
  assert.ok(noScrollRun.summary.app_switches > 0);
  const noScrollActions = commands.filter(item => !item.command.startsWith('SETTINGS_'));
  assert.deepEqual([...new Set(noScrollActions.map(item => item.command))], ['OPEN_APP']);
  antiIdle.stop({ confirm: true, reason: 'no-scroll test complete', idempotency_key: 'anti-stop-3' });
});

test('anti-idle uses one app, forward-only scrolls, full TikTok dwell, and advances the persisted cursor', async t => {
  const serial = '192.168.60.199:5555';
  withAllowlist([serial], t);
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db, 1, 'fleet-one', serial);
  addVerifiedRoute(db, 1);
  labControl.init(db);

  let clock = Date.UTC(2026, 8, 10, 12, 0, 0);
  const commands = [];
  antiIdle.init(db, {
    clock: () => clock,
    sleep: async ms => { clock += ms; },
    dispatch: async (deviceSerial, command, params) => {
      commands.push({ at: clock, serial: deviceSerial, command, params });
      return { success: true, message: 'ok', data: {} };
    },
  });
  antiIdle.configure({
    confirm: true,
    device_ids: [1],
    package_names: ['com.zhiliaoapp.musically', 'com.google.android.gm'],
    interval_seconds: 60,
    action_duration_seconds: 20,
    gesture_interval_seconds: 4,
    scrolls_before_dwell: 3,
    video_dwell_seconds: 180,
    lock_portrait: false,
    idempotency_key: 'anti-video-config-1',
  });
  antiIdle.start({ confirm: true, run_immediately: false, idempotency_key: 'anti-video-start-1' });
  clock += 60000;
  const cycleStartedAt = clock;
  const run = await antiIdle.tick();

  const actions = commands.filter(item => ['OPEN_APP', 'SCROLL'].includes(item.command));
  const opens = actions.filter(item => item.command === 'OPEN_APP');
  const scrolls = actions.filter(item => item.command === 'SCROLL');
  assert.equal(opens.length, 1);
  assert.equal(opens[0].params.package_name, 'com.zhiliaoapp.musically');
  assert.equal(scrolls.length, 3);
  assert.ok(scrolls.every(item => item.params.direction === 'down'));
  assert.deepEqual(scrolls.slice(1).map((item, index) => item.at - scrolls[index].at), [4000, 4000]);
  assert.ok(clock - cycleStartedAt >= 188700, 'the 180-second dwell must extend beyond the 20-second active window');
  assert.equal(run.summary.selected_package, 'com.zhiliaoapp.musically');
  assert.equal(run.summary.gestures, 3);
  assert.equal(run.summary.dwell_count, 1);
  assert.equal(run.summary.package_cursor_after, 1);
  assert.equal(run.state.package_cursor, 1);
  assert.equal(run.state.selected_package, 'com.google.android.gm');
  antiIdle.stop({ confirm: true, reason: 'video dwell test complete', idempotency_key: 'anti-video-stop-1' });
});
