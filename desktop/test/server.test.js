const assert = require('node:assert/strict');
const test = require('node:test');

const appServer = require('../server/app');
const accounts = require('../server/accounts');
const dbServer = require('../server/db');
const logic = require('../server/logic');
const proxies = require('../server/proxies');
const views = require('../server/views');

test('embedded server migrates its schema and protects paginated API routes', async t => {
  const token = 'server-test-token';
  const db = await dbServer.open(':memory:');
  accounts.init(db);
  proxies.init(db, {
    encrypt: accounts._enc,
    decrypt: accounts._dec,
    dispatch: async () => ({ success: true, message: 'ok', data: {} }),
  });
  views.init(db);

  t.after(() => db.close());

  const requiredTables = ['devices', 'accounts', 'proxies', 'proxy_assignments', 'lab_control_state', 'audit_events', 'proxy_routes', 'proxy_route_assignments', 'view_campaigns', 'view_sessions'];
  for (const table of requiredTables) {
    assert.equal(
      db.get("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?", [table]).count,
      1,
      `missing table ${table}`,
    );
  }

  const app = appServer.createServer(db, 6011, token);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  const healthResponse = await fetch(`http://127.0.0.1:${server.address().port}/up`);
  const health = await healthResponse.json();
  assert.equal(healthResponse.status, 200);
  assert.equal(health.status, 'ok');

  const unauthorized = await fetch(`${baseUrl}/devices`);
  assert.equal(unauthorized.status, 401);

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const created = await fetch(`${baseUrl}/devices`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      serial_number: 'TEST-DEVICE-1',
      name: 'Test device',
      status: 'online',
      transport: 'adb',
    }),
  });
  assert.equal(created.status, 201);
  const disableLab = await fetch(`${baseUrl}/lab/config`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ confirm: true, lab_mode_enabled: false, hermes_enabled: false }),
  });
  assert.equal(disableLab.status, 200);


  const devicesResponse = await fetch(`${baseUrl}/devices?per_page=10`, { headers });
  const devices = await devicesResponse.json();
  assert.equal(devicesResponse.status, 200);
  assert.equal(devices.success, true);
  assert.equal(devices.data.total, 1);
  assert.equal(devices.data.data[0].serial_number, 'TEST-DEVICE-1');

  const invalidBatchResponse = await fetch(`${baseUrl}/devices/batch-command`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ device_ids: [1], command: 'invalid command', params: {} }),
  });
  assert.equal(invalidBatchResponse.status, 422);

  const originalExecuteStep = logic.executeStep;
  logic.executeStep = async (device, step) => ({
    success: true,
    message: `${step.type} verified`,
    data: { serial: device.serial_number, proxy: null },
  });
  t.after(() => { logic.executeStep = originalExecuteStep; });

  const batchResponse = await fetch(`${baseUrl}/devices/batch-command`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ device_ids: [1], command: 'DEVICE_NETWORK_STATUS', params: {} }),
  });
  const batch = await batchResponse.json();
  assert.equal(batchResponse.status, 200);
  assert.equal(batch.success, true);
  assert.equal(batch.data.ok, 1);
  assert.equal(batch.data.results[0].data.serial, 'TEST-DEVICE-1');

  const createdProxyResponse = await fetch(`${baseUrl}/proxies`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'API proxy',
      host: '127.0.0.2',
      port: 8080,
      password: 'must-not-leak',
    }),
  });
  const createdProxy = await createdProxyResponse.json();
  assert.equal(createdProxyResponse.status, 201);
  assert.equal(createdProxy.data.has_password, true);
  assert.equal(Object.hasOwn(createdProxy.data, 'password'), false);
  assert.equal(Object.hasOwn(createdProxy.data, 'password_enc'), false);

  const previewResponse = await fetch(`${baseUrl}/views/pattern-preview`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ platform: 'tiktok', config: { views_per_session: 1 } }),
  });
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200);
  assert.ok(preview.data.steps.length > 0);
});
