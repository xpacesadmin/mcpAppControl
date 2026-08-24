const test = require('node:test');
const assert = require('node:assert/strict');
const dbServer = require('../server/db');
const accounts = require('../server/accounts');
const inventory = require('../server/account_inventory');

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
    devices_unreachable: 0,
    total_real: 1,
    total_assigned: 1,
    total_missing: 0,
  });
  db.close();
});
