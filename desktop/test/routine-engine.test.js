const assert = require('node:assert/strict');
const test = require('node:test');

const dbServer = require('../server/db');
const labControl = require('../server/lab_control');
const logic = require('../server/logic');
const proxyRoutes = require('../server/proxy_routes');

test('routine parameters resolve recursively and preserve numeric values', () => {
  const resolved = logic.resolveRoutineVars({
    query: '{{search_topic}}',
    count: '{{params.scroll_count}}',
    nested: ['prefix-{{search_topic}}'],
  }, { search_topic: 'network testing', scroll_count: 4 });

  assert.deepEqual(resolved, {
    query: 'network testing',
    count: 4,
    nested: ['prefix-network testing'],
  });
});

test('routine parameter schema applies defaults and bounds', () => {
  const schema = [
    { name: 'topic', type: 'string', required: true },
    { name: 'scrolls', type: 'number', default: 3, min: 1, max: 20 },
  ];
  const good = logic.validateRoutineParams(schema, { topic: 'dns' });
  assert.equal(good.valid, true);
  assert.deepEqual(good.params, { topic: 'dns', scrolls: 3 });

  const bad = logic.validateRoutineParams(schema, { topic: '', scrolls: 21 });
  assert.equal(bad.valid, false);
  assert.match(bad.errors.join(' '), /required|at most/i);
});

test('automation execution options use deterministic presets and safe timing bounds', () => {
  assert.deepEqual(logic.normalizeExecutionOptions(), {
    pace: 'standard',
    step_delay_ms: 1200,
    action_settle_ms: 700,
    lock_portrait: true,
  });
  assert.deepEqual(logic.normalizeExecutionOptions({
    pace: 'careful',
    step_delay_ms: 10,
    action_settle_ms: 99999,
    lock_portrait: false,
  }), {
    pace: 'careful',
    step_delay_ms: 600,
    action_settle_ms: 5000,
    lock_portrait: false,
  });
  assert.throws(() => logic.normalizeExecutionOptions({ pace: 'randomized' }), /Unknown automation pace/);
});

test('routine cancellation remains responsive and restores the prior orientation', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  const stamp = dbServer.now();
  db.run(
    'INSERT INTO devices(id,name,serial_number,adb_serial,status,current_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    [1, 'Fleet 1', 'TEST-DEVICE', 'TEST-DEVICE', 'busy', 1, stamp, stamp],
  );
  const task = db.run(
    'INSERT INTO tasks(id,external_id,status,created_at,updated_at) VALUES (?,?,?,?,?)',
    [1, 'portrait-cancel-test', 'running', stamp, stamp],
  );
  assert.equal(task.changes, 1);
  db.run(
    'INSERT INTO task_assignments(task_id,device_id,device_serial,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    [1, 1, 'TEST-DEVICE', 'assigned', stamp, stamp],
  );

  const commands = [];
  let sleepCalls = 0;
  logic.init(db, 6011, {
    dispatch: async (serial, command, params) => {
      commands.push({ serial, command, params });
      if (command === 'SETTINGS_GET') {
        const value = params.key === 'accelerometer_rotation' ? '1' : '3';
        return { success: true, data: { value }, message: 'setting read' };
      }
      return { success: true, data: {}, message: 'ok' };
    },
    sleep: async () => {
      sleepCalls++;
      if (sleepCalls === 1) db.run("UPDATE tasks SET status='cancel_requested' WHERE id=1");
    },
  });
  labControl.configure({ confirm: true, lab_mode_enabled: false, hermes_enabled: false });

  const result = await logic.runDeviceSteps(
    1,
    [{ type: 'PRESS_HOME' }, { type: 'PRESS_BACK' }],
    { id: 1, serial_number: 'TEST-DEVICE' },
    { pace: 'careful', lock_portrait: true },
  );

  assert.equal(result.failed, false);
  assert.equal(result.cancelled, true);
  assert.equal(sleepCalls, 1);
  assert.equal(commands.some(item => item.command === 'PRESS_HOME'), true);
  assert.equal(commands.some(item => item.command === 'PRESS_BACK'), false);
  assert.deepEqual(
    commands.filter(item => item.command === 'SETTINGS_PUT').map(item => [item.params.key, item.params.value]),
    [
      ['accelerometer_rotation', 0],
      ['user_rotation', 0],
      ['user_rotation', 3],
      ['accelerometer_rotation', 1],
    ],
  );
  assert.equal(db.get('SELECT status FROM task_assignments WHERE task_id=1').status, 'cancelled');
  assert.deepEqual(
    db.all("SELECT command_type,success FROM execution_logs WHERE command_type LIKE 'ORIENTATION_GUARD_%' ORDER BY id"),
    [
      { command_type: 'ORIENTATION_GUARD_BEGIN', success: 1 },
      { command_type: 'ORIENTATION_GUARD_END', success: 1 },
    ],
  );
});

test('long workflow waits react to task cancellation without waiting for timeout', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  logic.init(db, 6011);
  labControl.configure({ confirm: true, lab_mode_enabled: false, hermes_enabled: false });
  const stamp = dbServer.now();
  const inserted = db.run(
    'INSERT INTO tasks(external_id,status,created_at,updated_at) VALUES (?,?,?,?)',
    ['cancelled-wait-test', 'cancel_requested', stamp, stamp],
  );

  const started = Date.now();
  const result = await logic.executeStep(
    { id: 1, serial_number: 'TEST-DEVICE' },
    { type: 'WAIT', duration: 300000 },
    { taskId: inserted.lastInsertRowid },
  );

  assert.equal(result.success, false);
  assert.equal(result.cancelled, true);
  assert.ok(Date.now() - started < 1000);
});

test('route-aware stabilization uses the verified Orem route timezone and persists it', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  const stamp = dbServer.now();
  db.run(
    `INSERT INTO devices(id,name,serial_number,adb_serial,status,proxy_host,proxy_port,proxy_enabled,timezone,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [1, 'Fleet 1', 'TEST-DEVICE', 'TEST-DEVICE', 'online', '192.168.52.10', 8201, 1, 'America/Chicago', stamp, stamp],
  );
  db.run(
    `INSERT INTO proxy_routes(
       route_id,provider,internal_host,internal_port,protocol,country,region,city,classification,
       expected_public_ip,assigned_device_id,assigned_fleet_vlan,health_state,observed_public_ip,
       last_verification_time,created_at,updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      'fleet60-fleet1-dc01', 'test-provider', '192.168.52.10', 8201, 'HTTP', 'US', 'Utah', 'Orem',
      'dedicated_static', '203.0.113.10', 1, 60, 'verified', '203.0.113.10', stamp, stamp, stamp,
    ],
  );
  db.run(
    `INSERT INTO proxy_route_assignments(
       route_id,device_id,state,active,idempotency_key,assigned_at,created_at,updated_at
     ) VALUES (?,?,?,?,?,?,?,?)`,
    ['fleet60-fleet1-dc01', 1, 'active', 1, 'test-orem-assignment', stamp, stamp, stamp],
  );

  const calls = [];
  logic.init(db, 6011, {
    dispatch: async (serial, command, params) => {
      calls.push({ serial, command, params });
      if (command === 'GET_PROXY') {
        return { success: true, data: { proxy: '192.168.52.10:8201' }, message: 'proxy read' };
      }
      return { success: true, data: { applied: true }, message: 'stabilized' };
    },
  });
  proxyRoutes.init(db);
  labControl.configure({ confirm: true, lab_mode_enabled: false, hermes_enabled: false });

  const device = db.get('SELECT * FROM devices WHERE id=1');
  const result = await logic.executeStep(device, { type: 'DEVICE_STABILIZE', sync_time: true });

  assert.equal(result.success, true);
  assert.deepEqual(calls.map(call => call.command), ['GET_PROXY', 'DEVICE_STABILIZE']);
  assert.equal(calls[1].params.timezone, 'America/Denver');
  assert.equal(calls[1].params.timezone_source, 'proxy_route');
  assert.equal(result.data.timezone_resolution.route_id, 'fleet60-fleet1-dc01');
  assert.equal(result.data.timezone_resolution.city, 'Orem');
  assert.equal(result.data.timezone_resolution.timezone, 'America/Denver');
  assert.equal(result.data.timezone_resolution.binding, 'verified_android_global_proxy');
  const persisted = db.get('SELECT timezone,time_synced_at FROM devices WHERE id=1');
  assert.equal(persisted.timezone, 'America/Denver');
  assert.ok(persisted.time_synced_at);
});

test('route-aware stabilization rejects a conflicting explicit timezone without dispatch', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  const stamp = dbServer.now();
  db.run(
    `INSERT INTO devices(id,name,serial_number,adb_serial,status,proxy_enabled,timezone,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [1, 'Fleet 1', 'TEST-DEVICE', 'TEST-DEVICE', 'online', 0, 'America/Chicago', stamp, stamp],
  );
  db.run(
    `INSERT INTO proxy_routes(
       route_id,provider,internal_host,internal_port,protocol,country,region,city,classification,
       expected_public_ip,assigned_device_id,assigned_fleet_vlan,health_state,observed_public_ip,
       last_verification_time,created_at,updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      'fleet60-fleet1-dc01', 'test-provider', '192.168.52.10', 8201, 'HTTP', 'US', 'Utah', 'Orem',
      'dedicated_static', '203.0.113.10', 1, 60, 'verified', '203.0.113.10', stamp, stamp, stamp,
    ],
  );
  db.run(
    `INSERT INTO proxy_route_assignments(
       route_id,device_id,state,active,idempotency_key,assigned_at,created_at,updated_at
     ) VALUES (?,?,?,?,?,?,?,?)`,
    ['fleet60-fleet1-dc01', 1, 'active', 1, 'test-conflict-assignment', stamp, stamp, stamp],
  );

  const calls = [];
  logic.init(db, 6011, { dispatch: async (...args) => { calls.push(args); return { success: true }; } });
  proxyRoutes.init(db);
  labControl.configure({ confirm: true, lab_mode_enabled: false, hermes_enabled: false });

  const result = await logic.executeStep(
    db.get('SELECT * FROM devices WHERE id=1'),
    { type: 'DEVICE_STABILIZE', timezone: 'America/Los_Angeles' },
  );

  assert.equal(result.success, false);
  assert.match(result.message, /no coincide.*America\/Denver/i);
  assert.deepEqual(calls, []);
  assert.equal(db.get('SELECT timezone FROM devices WHERE id=1').timezone, 'America/Chicago');
});

test('route-aware stabilization fails closed when route geography is missing or unsupported', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  const stamp = dbServer.now();
  db.run(
    `INSERT INTO devices(id,name,serial_number,adb_serial,status,proxy_enabled,timezone,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [1, 'Fleet 1', 'TEST-DEVICE', 'TEST-DEVICE', 'online', 0, 'America/Chicago', stamp, stamp],
  );
  db.run(
    `INSERT INTO proxy_routes(
       route_id,provider,internal_host,internal_port,protocol,country,region,city,classification,
       expected_public_ip,assigned_device_id,assigned_fleet_vlan,health_state,observed_public_ip,
       last_verification_time,created_at,updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      'fleet60-fleet1-dc01', 'test-provider', '192.168.52.10', 8201, 'HTTP', 'US', null, null,
      'dedicated_static', '203.0.113.10', 1, 60, 'verified', '203.0.113.10', stamp, stamp, stamp,
    ],
  );
  db.run(
    `INSERT INTO proxy_route_assignments(
       route_id,device_id,state,active,idempotency_key,assigned_at,created_at,updated_at
     ) VALUES (?,?,?,?,?,?,?,?)`,
    ['fleet60-fleet1-dc01', 1, 'active', 1, 'test-missing-geo-assignment', stamp, stamp, stamp],
  );

  const calls = [];
  logic.init(db, 6011, { dispatch: async (...args) => { calls.push(args); return { success: true }; } });
  proxyRoutes.init(db);
  labControl.configure({ confirm: true, lab_mode_enabled: false, hermes_enabled: false });

  const device = db.get('SELECT * FROM devices WHERE id=1');
  const missing = await logic.executeStep(device, { type: 'DEVICE_STABILIZE' });
  assert.equal(missing.success, false);
  assert.match(missing.message, /Zona horaria bloqueada.*Geografía de ruta no compatible/i);
  assert.deepEqual(calls, []);

  db.run("UPDATE proxy_routes SET region='Nevada',city='Las Vegas' WHERE route_id='fleet60-fleet1-dc01'");
  const unsupported = await logic.executeStep(device, { type: 'DEVICE_STABILIZE' });
  assert.equal(unsupported.success, false);
  assert.match(unsupported.message, /Zona horaria bloqueada.*Geografía de ruta no compatible/i);
  assert.deepEqual(calls, []);
  assert.equal(db.get('SELECT timezone FROM devices WHERE id=1').timezone, 'America/Chicago');
});

test('routine-safe cross-app steps validate with bounded values', async t => {
  const previousFull = process.env.MCP_LAB_FULL;
  const previousScope = process.env.MCP_LAB_SCOPE;
  process.env.MCP_LAB_FULL = 'true';
  process.env.MCP_LAB_SCOPE = 'allowlist';
  t.after(() => {
    if (previousFull === undefined) delete process.env.MCP_LAB_FULL; else process.env.MCP_LAB_FULL = previousFull;
    if (previousScope === undefined) delete process.env.MCP_LAB_SCOPE; else process.env.MCP_LAB_SCOPE = previousScope;
  });
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  labControl.init(db);

  const validation = labControl.validateWorkflowSteps([
    { type: 'CAPTURE_FOREGROUND_APP' },
    { type: 'OPEN_WEB_SEARCH', query: '{{search_topic}}' },
    { type: 'CLICK_FIRST_ACTIONABLE', min_y: 300, max_y: 1800 },
    { type: 'REPEAT_SCROLL', direction: 'down', count: '{{scroll_count}}', pause_ms: 800 },
    { type: 'PLAY_MEDIA', duration_seconds: '{{watch_seconds}}' },
    { type: 'RESTORE_FOREGROUND_APP' },
  ]);

  assert.equal(validation.valid, true, validation.errors.join('; '));
});
test('routine execution uses the in-app dialog instead of unsupported window.prompt', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'dashboard', 'js', 'routines.js'), 'utf8');
  assert.doesNotMatch(source, /\bprompt\s*\(/);
  assert.match(source, /await customPrompt\s*\(/);
});
