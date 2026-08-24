// Inventario y verificación read-only de cuentas Android.
// Los identificadores permanecen en la base local; auditoría y alertas usan IDs,
// conteos y etiquetas de flota, nunca contraseñas, tokens ni correos completos.
const fs = require('fs');
const path = require('path');
const { now } = require('./db');

let DB = null;
let DISPATCH = null;
let ALERTS = null;
let LAB = null;
let configFile = null;
let running = false;
let nextRunAt = 0;

const defaults = { enabled: true, interval_sec: 300, platform: 'com.google' };
let config = { ...defaults };

function init(db, opts = {}) {
  DB = db;
  DISPATCH = opts.dispatch;
  ALERTS = opts.alerts;
  LAB = opts.labControl;
  const dir = path.dirname(db.file && db.file !== ':memory:' ? db.file : __dirname);
  configFile = path.join(dir, 'account-inventory-config.json');
  try {
    if (fs.existsSync(configFile)) config = normalizeConfig({ ...config, ...JSON.parse(fs.readFileSync(configFile, 'utf8')) });
  } catch (_) { config = { ...defaults }; }
  nextRunAt = Date.now() + 60000;
}

function requireInit() {
  if (!DB || !DISPATCH) throw new Error('account_inventory no inicializado');
}

function normalizeConfig(input = {}) {
  const interval = Math.max(60, Math.min(86400, Number(input.interval_sec || defaults.interval_sec)));
  const platform = String(input.platform || defaults.platform).trim();
  if (!/^[A-Za-z0-9._-]{2,100}$/.test(platform)) throw new Error('platform inválida');
  return { enabled: input.enabled !== false, interval_sec: interval, platform };
}

function getConfig() {
  return { ...config, running, next_run_at: config.enabled && nextRunAt ? new Date(nextRunAt).toISOString() : null };
}

function setConfig(patch = {}) {
  config = normalizeConfig({ ...config, ...patch });
  nextRunAt = config.enabled ? Date.now() + config.interval_sec * 1000 : 0;
  if (configFile) {
    try { fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 }); } catch (_) {}
  }
  return getConfig();
}

function norm(value) { return String(value || '').trim().toLowerCase(); }

function labelFor(device, account) {
  const note = String(account && account.notes || '').trim();
  const match = note.match(/FLEET[_ -]?\d+/i);
  return match ? match[0].toUpperCase().replace(/[ -]/g, '_') : (device.name || device.adb_serial || device.serial_number || `Device ${device.id}`);
}

function assignedFor(deviceId, platform) {
  return DB.all(
    "SELECT * FROM accounts WHERE device_id=? AND platform=? AND active=1 ORDER BY id",
    [Number(deviceId), platform]
  );
}

async function notifyTransition(device, account, previous, next) {
  if (!ALERTS || !ALERTS.notify || previous === next || previous === 'unknown') return;
  const label = labelFor(device, account);
  if (next === 'missing') {
    await ALERTS.notify({
      type: 'account_missing', severity: 'critical', device_serial: device.adb_serial || device.serial_number,
      message: `${label}: assigned Google account is no longer present`,
      data: { account_id: account.id, device_id: device.id, platform: account.platform, state: next },
    });
  } else if (next === 'present' && ['missing', 'unreachable'].includes(previous)) {
    await ALERTS.notify({
      type: 'account_recovered', severity: 'info', device_serial: device.adb_serial || device.serial_number,
      message: `${label}: assigned Google account is present again`,
      data: { account_id: account.id, device_id: device.id, platform: account.platform, state: next },
    });
  } else if (next === 'unreachable' && previous === 'present') {
    await ALERTS.notify({
      type: 'account_check_unreachable', severity: 'warning', device_serial: device.adb_serial || device.serial_number,
      message: `${label}: account check could not reach the device`,
      data: { account_id: account.id, device_id: device.id, platform: account.platform, state: next },
    });
  }
}

async function recordState(device, account, state, message) {
  const previous = account.verification_state || 'unknown';
  const timestamp = now();
  const missingCount = state === 'missing' ? Number(account.consecutive_missing || 0) + 1 : 0;
  DB.run(
    `UPDATE accounts SET verification_state=?,last_verified_at=?,
       last_seen_on_device_at=CASE WHEN ?='present' THEN ? ELSE last_seen_on_device_at END,
       last_verification_message=?,consecutive_missing=?,updated_at=? WHERE id=?`,
    [state, timestamp, state, timestamp, String(message || '').slice(0, 240), missingCount, timestamp, account.id]
  );
  await notifyTransition(device, account, previous, state);
}

function scoped(device) {
  if (!LAB || !LAB.assertDeviceInScope) return true;
  try { LAB.assertDeviceInScope(device.id); return true; } catch (_) { return false; }
}

async function verifyDevice(deviceOrId, options = {}) {
  requireInit();
  const platform = String(options.platform || config.platform).trim();
  const device = typeof deviceOrId === 'object'
    ? deviceOrId
    : DB.get('SELECT * FROM devices WHERE id=? OR serial_number=? OR adb_serial=?', [deviceOrId, deviceOrId, deviceOrId]);
  if (!device) throw new Error('Dispositivo no encontrado');
  if (!scoped(device)) throw new Error('Operation is outside the exact lab device allowlist');
  const assigned = assignedFor(device.id, platform);
  const base = {
    device_id: device.id,
    device_name: device.name || device.serial_number,
    serial: device.adb_serial || device.serial_number,
    platform,
    assigned_count: assigned.length,
  };
  if (!assigned.length) return { ...base, success: true, state: 'unassigned', real_count: 0, present_count: 0, missing_from_device: [], unexpected_on_device: [] };

  let response;
  try { response = await DISPATCH(device.adb_serial || device.serial_number, 'CHECK_ACCOUNTS', {}); }
  catch (error) { response = { success: false, message: error.message }; }

  if (!response || !response.success) {
    for (const account of assigned) await recordState(device, account, 'unreachable', response && response.message || 'ADB account check failed');
    if (LAB && LAB.audit) LAB.audit('account_inventory.verify_device', 'unreachable', {
      platform, assigned_count: assigned.length, present_count: 0, missing_count: 0,
    }, { device_id: device.id });
    return { ...base, success: false, state: 'unreachable', message: response && response.message || 'ADB account check failed', real_count: 0, present_count: 0, missing_from_device: [], unexpected_on_device: [] };
  }

  const observed = Array.isArray(response.data && response.data.by_type && response.data.by_type[platform])
    ? response.data.by_type[platform].map(item => norm(item.email)).filter(Boolean)
    : [];
  const observedSet = new Set(observed);
  const assignedSet = new Set(assigned.map(account => norm(account.email)));
  const missing = [];
  let presentCount = 0;
  for (const account of assigned) {
    const present = observedSet.has(norm(account.email));
    if (present) presentCount += 1; else missing.push(account.email);
    await recordState(device, account, present ? 'present' : 'missing', present ? 'Expected account present' : 'Expected account missing');
  }
  const unexpected = observed.filter(email => !assignedSet.has(email));
  const state = missing.length ? 'missing' : 'present';
  const realAccounts = observed.map(email => ({ email, type: platform, assigned: assignedSet.has(email) }));
  if (LAB && LAB.audit) LAB.audit('account_inventory.verify_device', state, {
    platform, assigned_count: assigned.length, present_count: presentCount,
    missing_count: missing.length, observed_count: observed.length, unexpected_count: unexpected.length,
  }, { device_id: device.id });
  return {
    ...base, success: true, state, real_count: observed.length, present_count: presentCount,
    missing_from_device: missing, unexpected_on_device: unexpected,
    total_real: observed.length,
    total_assigned: assigned.length,
    real_accounts: realAccounts,
    assigned_accounts: assigned.map(account => ({ email: account.email, platform: account.platform })),
    mismatched: [],
  };
}

async function verifyAll(options = {}) {
  requireInit();
  const platform = String(options.platform || config.platform).trim();
  const devices = DB.all(
    `SELECT DISTINCT d.* FROM devices d JOIN accounts a ON a.device_id=d.id
     WHERE a.platform=? AND a.active=1 AND d.adb_serial IS NOT NULL ORDER BY d.id`,
    [platform]
  ).filter(scoped);
  const results = [];
  for (const device of devices) {
    try { results.push(await verifyDevice(device, { platform, source: options.source || 'manual' })); }
    catch (error) { results.push({ device_id: device.id, device_name: device.name, serial: device.adb_serial, success: false, state: 'error', message: error.message, assigned_count: 0, real_count: 0, present_count: 0, missing_from_device: [], unexpected_on_device: [] }); }
  }
  const summary = {
    devices_checked: results.length,
    devices_present: results.filter(row => row.state === 'present').length,
    devices_missing: results.filter(row => row.state === 'missing').length,
    devices_unreachable: results.filter(row => row.state === 'unreachable' || row.state === 'error').length,
    total_real: results.reduce((sum, row) => sum + Number(row.real_count || 0), 0),
    total_assigned: results.reduce((sum, row) => sum + Number(row.assigned_count || 0), 0),
    total_missing: results.reduce((sum, row) => sum + row.missing_from_device.length, 0),
  };
  return { results, summary };
}

function inventory(platform = config.platform) {
  requireInit();
  return DB.all(
    `SELECT a.id,a.platform,a.username,a.email,a.notes,a.status,a.device_id,a.active,
            a.verification_state,a.last_verified_at,a.last_seen_on_device_at,
            a.last_verification_message,a.consecutive_missing,
            d.name AS device_name,d.serial_number,d.adb_serial,d.status AS device_status
       FROM accounts a LEFT JOIN devices d ON d.id=a.device_id
      WHERE (?='' OR a.platform=?) ORDER BY a.device_id,a.id`,
    [platform || '', platform || '']
  );
}

async function tick() {
  if (!config.enabled || running || Date.now() < nextRunAt) return null;
  running = true;
  nextRunAt = Date.now() + config.interval_sec * 1000;
  try { return await verifyAll({ platform: config.platform, source: 'monitor' }); }
  finally { running = false; }
}

function shutdown() { running = false; nextRunAt = 0; }

module.exports = { init, getConfig, setConfig, verifyDevice, verifyAll, inventory, tick, shutdown };
