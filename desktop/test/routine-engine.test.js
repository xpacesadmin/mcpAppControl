const assert = require('node:assert/strict');
const test = require('node:test');

const dbServer = require('../server/db');
const labControl = require('../server/lab_control');
const logic = require('../server/logic');

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
