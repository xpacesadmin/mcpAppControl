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