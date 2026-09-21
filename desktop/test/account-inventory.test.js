const test = require('node:test');
const assert = require('node:assert/strict');
const dbServer = require('../server/db');
const appServer = require('../server/app');
const accounts = require('../server/accounts');
const inventory = require('../server/account_inventory');

test('periodic account monitoring is opt-in and disabled by default', async () => {
  const db = await dbServer.open(':memory:');
  accounts.init(db);
  inventory.init(db, {
    configFile: false,
    dispatch: async () => ({ success: true, data: { by_type: {} } }),
    labControl: { assertDeviceInScope: () => true, audit: () => {} },
  });

  assert.equal(inventory.getConfig().enabled, false);
  assert.equal(inventory.getConfig().next_run_at, null);
  assert.equal(await inventory.tick(), null, 'default monitor must not scan');

  inventory.setConfig({ enabled: true, interval_sec: 60, platform: 'com.google' });
  assert.equal(inventory.getConfig().enabled, true);
  assert.ok(inventory.getConfig().next_run_at);

  inventory.setConfig({ enabled: false });
  assert.equal(inventory.getConfig().enabled, false);
  assert.equal(inventory.getConfig().next_run_at, null);
  inventory.shutdown();
  db.close();
});

test('manual inventory scan is an explicit lab-safe POST without reopening account writes', async t => {
  const token = 'account-inventory-test-token';
  const db = await dbServer.open(':memory:');
  accounts.init(db);
  inventory.init(db, {
    dispatch: async () => ({ success: true, data: { by_type: {} } }),
    labControl: { assertDeviceInScope: () => true, audit: () => {} },
  });
  const app = appServer.createServer(db, 6012, token);
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    listener.on('error', reject);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  t.after(() => db.close());

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
  const scan = await fetch(`${baseUrl}/accounts/inventory/scan`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ platform: 'com.google' }),
  });
  const scanBody = await scan.json();
  assert.equal(scan.status, 200);
  assert.equal(scanBody.success, true);
  assert.equal(scanBody.data.summary.devices_checked, 0);

  const legacyGet = await fetch(`${baseUrl}/accounts/inventory/scan?platform=com.google`, { headers });
  assert.equal(legacyGet.status, 404, 'GET must not trigger a state-recording scan');

  const blockedAccountWrite = await fetch(`${baseUrl}/accounts/inventory/monitor`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(blockedAccountWrite.status, 423, 'other account writes stay blocked in lab mode');
});

test('account inventory persists health and only alerts on transitions', async () => {
  const db = await dbServer.open(':memory:');
  accounts.init(db);
  db.run(
    'INSERT INTO devices(name,serial_number,adb_serial,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ['Fleet 1', '192.168.60.199:5555', '192.168.60.199:5555', 'online', dbServer.now(), dbServer.now()]
  );
  const device = db.get('SELECT * FROM devices WHERE adb_serial=?', ['192.168.60.199:5555']);
  accounts.upsertAssignment({
    email: 'fleet1@example.com',
    platform: 'com.google',
    notes: 'FLEET_01 VLAN60',
  }, device.id);

  let present = true;
  const alertEvents = [];
  const audits = [];
  inventory.init(db, {
    dispatch: async () => ({
      success: true,
      data: { by_type: { 'com.google': present ? [{ email: 'FLEET1@example.com' }] : [] } },
    }),
    alerts: { notify: async event => alertEvents.push(event) },
    labControl: {
      assertDeviceInScope: () => true,
      audit: (operation, result, details) => audits.push({ operation, result, details }),
    },
  });

  let result = await inventory.verifyDevice(device.id);
  assert.equal(result.state, 'present');
  assert.equal(result.present_count, 1);
  assert.equal(alertEvents.length, 0);
  assert.equal(inventory.inventory()[0].verification_state, 'present');

  present = false;
  result = await inventory.verifyDevice(device.id);
  assert.equal(result.state, 'missing');
  assert.deepEqual(result.missing_from_device, ['fleet1@example.com']);
  assert.equal(alertEvents.length, 1);
  assert.equal(alertEvents[0].type, 'account_missing');
  assert.equal(JSON.stringify(alertEvents[0]).includes('fleet1@example.com'), false);

  await inventory.verifyDevice(device.id);
  assert.equal(alertEvents.length, 1, 'same missing state must not create alert spam');
  assert.equal(inventory.inventory()[0].consecutive_missing, 2);

  present = true;
  result = await inventory.verifyDevice(device.id);
  assert.equal(result.state, 'present');
  assert.equal(alertEvents.length, 2);
  assert.equal(alertEvents[1].type, 'account_recovered');
  assert.equal(inventory.inventory()[0].consecutive_missing, 0);
  assert.equal(audits.every(row => !JSON.stringify(row.details).includes('fleet1@example.com')), true);

  const all = await inventory.verifyAll();
  assert.deepEqual(all.summary, {
    devices_checked: 1,
    devices_present: 1,
    devices_missing: 0,
    devices_swapped: 0,
    devices_needs_reauth: 0,
    devices_unreachable: 0,
    devices_unknown: 0,
    total_real: 1,
    total_assigned: 1,
    total_missing: 0,
    total_swapped: 0,
    total_needs_reauth: 0,
  });
  db.close();
});

test('scanner distinguishes swap and operator-confirmed reauth without silently reassigning', async () => {
  const db = await dbServer.open(':memory:');
  accounts.init(db);
  db.run(
    'INSERT INTO devices(name,serial_number,adb_serial,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ['Fleet 19', '192.168.60.197:5555', '192.168.60.197:5555', 'online', dbServer.now(), dbServer.now()]
  );
  const device = db.get('SELECT * FROM devices WHERE adb_serial=?', ['192.168.60.197:5555']);
  const expected = accounts.upsertAssignment({
    email: 'expected@example.com',
    platform: 'com.google',
    notes: 'FLEET_19 VLAN60',
  }, device.id);

  let observed = ['expected@example.com'];
  const alertEvents = [];
  const audits = [];
  inventory.init(db, {
    dispatch: async () => ({
      success: true,
      data: { by_type: { 'com.google': observed.map(email => ({ email })) } },
    }),
    alerts: { notify: async event => alertEvents.push(event) },
    labControl: {
      assertDeviceInScope: () => true,
      audit: (operation, result, details) => audits.push({ operation, result, details }),
    },
  });

  await inventory.verifyDevice(device.id);
  observed = ['replacement@example.com'];
  const swapped = await inventory.verifyDevice(device.id);
  assert.equal(swapped.state, 'swapped');
  assert.equal(swapped.swapped_count, 1);
  assert.deepEqual(swapped.unexpected_on_device, ['replacement@example.com']);
  assert.equal(inventory.inventory()[0].verification_state, 'swapped');
  assert.equal(accounts.activeFor(device.id, 'com.google').id, expected.id, 'scan must not reassign inventory');
  assert.equal(alertEvents.some(event => event.type === 'account_swapped'), true);
  assert.equal(JSON.stringify(alertEvents).includes('replacement@example.com'), false);

  observed = ['expected@example.com'];
  await inventory.verifyDevice(device.id);
  let review = await inventory.setReviewState(expected.id, 'needs_reauth');
  assert.equal(review.state, 'needs_reauth');
  assert.equal(review.idempotent, false);
  assert.equal(inventory.inventory().find(row => row.id === expected.id).verification_state, 'needs_reauth');

  const stillNeedsReview = await inventory.verifyDevice(device.id);
  assert.equal(stillNeedsReview.state, 'needs_reauth', 'automated local-presence scan must preserve manual review');
  review = await inventory.setReviewState(expected.id, 'needs_reauth');
  assert.equal(review.idempotent, true);
  review = await inventory.setReviewState(expected.id, 'present');
  assert.equal(review.state, 'present');
  assert.equal(inventory.inventory().find(row => row.id === expected.id).verification_state, 'present');

  observed = ['replacement@example.com'];
  await inventory.verifyDevice(device.id);
  const confirmed = await inventory.confirmSwap({
    expected_account_id: expected.id,
    observed_email: 'replacement@example.com',
  });
  assert.equal(confirmed.idempotent, false);
  assert.equal(confirmed.previous_account_id, expected.id);
  assert.equal(confirmed.account.email, 'replacement@example.com');
  assert.equal(accounts.activeFor(device.id, 'com.google').email, 'replacement@example.com');
  assert.equal(db.get('SELECT active FROM accounts WHERE id=?', [expected.id]).active, 0);

  const replay = await inventory.confirmSwap({
    expected_account_id: expected.id,
    observed_email: 'replacement@example.com',
  });
  assert.equal(replay.idempotent, true);
  assert.equal(audits.every(row => !JSON.stringify(row.details).includes('@example.com')), true);
  db.close();
});

test('scanner uses unknown for malformed data and unreachable for failed ADB', async () => {
  const db = await dbServer.open(':memory:');
  accounts.init(db);
  db.run(
    'INSERT INTO devices(name,serial_number,adb_serial,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ['Fleet 1', '192.168.60.199:5555', '192.168.60.199:5555', 'online', dbServer.now(), dbServer.now()]
  );
  const device = db.get('SELECT * FROM devices WHERE adb_serial=?', ['192.168.60.199:5555']);
  accounts.upsertAssignment({ email: 'fleet1@example.com', platform: 'com.google' }, device.id);
  let response = { success: true, data: {} };
  inventory.init(db, {
    dispatch: async () => response,
    labControl: { assertDeviceInScope: () => true, audit: () => {} },
  });

  let result = await inventory.verifyDevice(device.id);
  assert.equal(result.state, 'unknown');
  assert.equal(inventory.inventory()[0].verification_state, 'unknown');

  response = { success: false, message: 'ADB offline' };
  result = await inventory.verifyDevice(device.id);
  assert.equal(result.state, 'unreachable');
  assert.equal(inventory.inventory()[0].verification_state, 'unreachable');
  db.close();
});

test('alerts once for missing, swapped, and evidence-based needs_reauth states', async () => {
  const db = await dbServer.open(':memory:');
  accounts.init(db);
  const timestamp = dbServer.now();
  db.run(
    'INSERT INTO devices(name,serial_number,adb_serial,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ['Fleet 1', '192.168.60.199:5555', '192.168.60.199:5555', 'online', timestamp, timestamp]
  );
  db.run(
    'INSERT INTO devices(name,serial_number,adb_serial,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ['Fleet 2', '192.168.60.200:5555', '192.168.60.200:5555', 'online', timestamp, timestamp]
  );
  db.run(
    'INSERT INTO devices(name,serial_number,adb_serial,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ['Fleet 3', '192.168.60.201:5555', '192.168.60.201:5555', 'online', timestamp, timestamp]
  );
  const missingDevice = db.get('SELECT * FROM devices WHERE adb_serial=?', ['192.168.60.199:5555']);
  const swappedDevice = db.get('SELECT * FROM devices WHERE adb_serial=?', ['192.168.60.200:5555']);
  const reviewDevice = db.get('SELECT * FROM devices WHERE adb_serial=?', ['192.168.60.201:5555']);
  accounts.upsertAssignment({ email: 'missing@example.com', platform: 'com.google', notes: 'FLEET_01 VLAN60' }, missingDevice.id);
  accounts.upsertAssignment({ email: 'expected@example.com', platform: 'com.google', notes: 'FLEET_02 VLAN60' }, swappedDevice.id);
  const reviewAccount = accounts.upsertAssignment({ email: 'review@example.com', platform: 'com.google', notes: 'FLEET_03 VLAN60' }, reviewDevice.id);

  const observedBySerial = new Map([
    [missingDevice.adb_serial, []],
    [swappedDevice.adb_serial, ['replacement@example.com']],
    [reviewDevice.adb_serial, ['review@example.com']],
  ]);
  const alertEvents = [];
  inventory.init(db, {
    dispatch: async serial => ({
      success: true,
      data: { by_type: { 'com.google': (observedBySerial.get(serial) || []).map(email => ({ email })) } },
    }),
    alerts: { notify: async event => alertEvents.push(event) },
    labControl: { assertDeviceInScope: () => true, audit: () => {} },
  });

  assert.equal((await inventory.verifyDevice(missingDevice.id)).state, 'missing');
  await inventory.verifyDevice(missingDevice.id);
  assert.equal((await inventory.verifyDevice(swappedDevice.id)).state, 'swapped');
  await inventory.verifyDevice(swappedDevice.id);
  assert.equal((await inventory.verifyDevice(reviewDevice.id)).state, 'present');
  await inventory.setReviewState(reviewAccount.id, 'needs_reauth');
  await inventory.setReviewState(reviewAccount.id, 'needs_reauth');

  assert.deepEqual(alertEvents.map(event => event.type), ['account_missing', 'account_swapped', 'account_needs_reauth']);
  assert.equal(JSON.stringify(alertEvents).includes('@example.com'), false);
  db.close();
});
