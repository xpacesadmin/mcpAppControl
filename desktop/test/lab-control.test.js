const assert = require('node:assert/strict');
const test = require('node:test');

const dbServer = require('../server/db');
const labControl = require('../server/lab_control');

function addDevice(db, id = 1) {
  const timestamp = dbServer.now();
  db.run(
    'INSERT INTO devices(id,name,serial_number,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    [id, 'Canary', 'CANARY-1', 'online', timestamp, timestamp]
  );
}

test('lab mode is safe by default and validates bounded canary workflows', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db);
  labControl.init(db);

  assert.equal(labControl.state().lab_mode_enabled, true);
  assert.equal(labControl.state().halted, false);
  assert.throws(() => labControl.assertDeviceAllowed(1), /configure/i);

  labControl.configure({ confirm: true, canary_device_id: 1, idempotency_key: 'lab-config-1' });
  assert.doesNotThrow(() => labControl.assertDeviceAllowed(1));
  assert.throws(() => labControl.assertDeviceAllowed(2), /canario|canary/i);

  const safe = labControl.validateWorkflowSteps([
    { type: 'OPEN_APP', package_name: 'com.example.test' },
    { type: 'WAIT', duration: 250 },
    { type: 'REPORT_RESULT' },
  ]);
  assert.equal(safe.valid, true);

  const unsafe = labControl.validateWorkflowSteps([{ type: 'INSTALL_APK', path: 'unknown.apk' }]);
  assert.equal(unsafe.valid, false);
  assert.match(unsafe.errors.join(' '), /not permitted|no permitido/i);
});

test('audit redaction removes credential values and URI userinfo', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  labControl.init(db);

  const row = labControl.audit('test.redaction', 'ok', {
    password: 'do-not-store',
    nested: { token: 'do-not-store-either' },
    url: 'http://user:pass@example.test/path',
  });
  const details = JSON.parse(row.details);
  assert.equal(details.password, '[REDACTED]');
  assert.equal(details.nested.token, '[REDACTED]');
  assert.equal(details.url, 'http://[REDACTED]@example.test/path');
  assert.equal(row.details.includes('do-not-store'), false);
});

test('emergency stop is idempotent and requests cancellation without clearing proxy state', async t => {
  const db = await dbServer.open(':memory:');
  t.after(() => db.close());
  addDevice(db);
  labControl.init(db);
  labControl.configure({ confirm: true, canary_device_id: 1 });

  const timestamp = dbServer.now();
  const workflow = db.run(
    'INSERT INTO workflows(name,steps,status,created_at,updated_at) VALUES (?,?,?,?,?)',
    ['Test', '[]', 'active', timestamp, timestamp]
  );
  db.run(
    'INSERT INTO tasks(external_id,workflow_id,status,created_at,updated_at) VALUES (?,?,?,?,?)',
    ['task-running', workflow.lastInsertRowid, 'running', timestamp, timestamp]
  );
  db.run('UPDATE devices SET proxy_host=?,proxy_port=?,proxy_enabled=1 WHERE id=1', ['192.168.52.10', 8100]);

  labControl.emergencyStop({ confirm: true, reason: 'test mismatch', idempotency_key: 'stop-1' });
  labControl.emergencyStop({ confirm: true, reason: 'test mismatch', idempotency_key: 'stop-1' });

  assert.equal(labControl.state().halted, true);
  assert.equal(db.get('SELECT status FROM tasks WHERE external_id=?', ['task-running']).status, 'cancel_requested');
  const device = db.get('SELECT proxy_host,proxy_port,proxy_enabled FROM devices WHERE id=1');
  assert.deepEqual(device, { proxy_host: '192.168.52.10', proxy_port: 8100, proxy_enabled: 1 });
  assert.equal(db.get('SELECT COUNT(*) AS c FROM audit_events WHERE idempotency_key=?', ['stop-1']).c, 1);
});
