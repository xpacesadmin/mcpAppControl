// Inventario y verificación read-only de cuentas Android.
// Los identificadores permanecen en la base local; auditoría y alertas usan IDs,
// conteos y etiquetas de flota, nunca contraseñas, tokens ni correos completos.
const fs = require('fs');
const path = require('path');
const { now } = require('./db');
const accountsStore = require('./accounts');

let DB = null;
let DISPATCH = null;
let ALERTS = null;
let LAB = null;
let configFile = null;
let running = false;
let nextRunAt = 0;

const defaults = { enabled: false, interval_sec: 300, platform: 'com.google' };
let config = { ...defaults };

function init(db, opts = {}) {
  DB = db;
  DISPATCH = opts.dispatch;
  ALERTS = opts.alerts;
  LAB = opts.labControl;
  const dir = path.dirname(db.file && db.file !== ':memory:' ? db.file : __dirname);
  configFile = opts.configFile === false ? null : path.join(dir, 'account-inventory-config.json');
  config = { ...defaults };
  try {
    if (configFile && fs.existsSync(configFile)) config = normalizeConfig({ ...defaults, ...JSON.parse(fs.readFileSync(configFile, 'utf8')) });
  } catch (_) { config = { ...defaults }; }
  nextRunAt = config.enabled ? Date.now() + 60000 : 0;
}

function requireInit() {
  if (!DB || !DISPATCH) throw new Error('account_inventory no inicializado');
}

function normalizeConfig(input = {}) {
  const interval = Math.max(60, Math.min(86400, Number(input.interval_sec || defaults.interval_sec)));
  const platform = String(input.platform || defaults.platform).trim();
  if (!/^[A-Za-z0-9._-]{2,100}$/.test(platform)) throw new Error('platform inválida');
  return { enabled: input.enabled === true, interval_sec: interval, platform };
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
    'SELECT * FROM accounts WHERE device_id=? AND platform=? AND active=1 ORDER BY id',
    [Number(deviceId), platform]
  );
}

async function notifyTransition(device, account, previous, next) {
  if (!ALERTS || !ALERTS.notify || previous === next) return;
  if (previous === 'unknown' && !['missing', 'swapped', 'needs_reauth'].includes(next)) {
    return;
  }
  const label = labelFor(device, account);
  const common = {
    device_serial: device.adb_serial || device.serial_number,
    data: { account_id: account.id, device_id: device.id, platform: account.platform, state: next },
  };
  if (next === 'missing') {
    await ALERTS.notify({
      ...common, type: 'account_missing', severity: 'critical',
      message: `${label}: assigned Google account is no longer present`,
    });
  } else if (next === 'swapped') {
    await ALERTS.notify({
      ...common, type: 'account_swapped', severity: 'critical',
      message: `${label}: assigned Google account is absent and another Google account is present`,
    });
  } else if (next === 'needs_reauth') {
    await ALERTS.notify({
      ...common, type: 'account_needs_reauth', severity: 'warning',
      message: `${label}: operator marked the account as requiring sign-in`,
    });
  } else if (next === 'present' && ['missing', 'swapped', 'needs_reauth', 'unreachable', 'unknown'].includes(previous)) {
    await ALERTS.notify({
      ...common, type: 'account_recovered', severity: 'info',
      message: `${label}: assigned Google account is present again`,
    });
  } else if (next === 'unreachable' && ['present', 'needs_reauth'].includes(previous)) {
    await ALERTS.notify({
      ...common, type: 'account_check_unreachable', severity: 'warning',
      message: `${label}: account check could not reach the device`,
    });
  }
}

async function recordState(device, account, state, message) {
  const previous = account.verification_state || 'unknown';
  const timestamp = now();
  const missingCount = ['missing', 'swapped'].includes(state) ? Number(account.consecutive_missing || 0) + 1 : 0;
  DB.run(
    `UPDATE accounts SET verification_state=?,last_verified_at=?,
       last_seen_on_device_at=CASE WHEN ? IN ('present','needs_reauth') THEN ? ELSE last_seen_on_device_at END,
       last_verification_message=?,consecutive_missing=?,updated_at=? WHERE id=?`,
    [state, timestamp, state, timestamp, String(message || '').slice(0, 240), missingCount, timestamp, account.id]
  );
  await notifyTransition(device, account, previous, state);
}

function resultSkeleton(base, state, success, message = null) {
  return {
    ...base,
    success,
    state,
    message,
    real_count: 0,
    present_count: 0,
    missing_count: 0,
    swapped_count: 0,
    needs_reauth_count: 0,
    missing_from_device: [],
    unexpected_on_device: [],
    real_accounts: [],
    assigned_accounts: [],
    mismatched: [],
  };
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
  if (!assigned.length) return resultSkeleton(base, 'unassigned', true);

  let response;
  try { response = await DISPATCH(device.adb_serial || device.serial_number, 'CHECK_ACCOUNTS', {}); }
  catch (error) { response = { success: false, message: error.message }; }

  if (!response || !response.success) {
    for (const account of assigned) await recordState(device, account, 'unreachable', response && response.message || 'ADB account check failed');
    if (LAB && LAB.audit) LAB.audit('account_inventory.verify_device', 'unreachable', {
      platform, assigned_count: assigned.length, present_count: 0, missing_count: 0,
      identifiers_exposed: false,
    }, { device_id: device.id });
    return resultSkeleton(base, 'unreachable', false, response && response.message || 'ADB account check failed');
  }

  if (!response.data || !response.data.by_type || typeof response.data.by_type !== 'object') {
    for (const account of assigned) await recordState(device, account, 'unknown', 'Account response did not contain structured account data');
    if (LAB && LAB.audit) LAB.audit('account_inventory.verify_device', 'unknown', {
      platform, assigned_count: assigned.length, identifiers_exposed: false,
    }, { device_id: device.id });
    return resultSkeleton(base, 'unknown', false, 'The device returned no structured account information');
  }

  const observed = Array.isArray(response.data.by_type[platform])
    ? response.data.by_type[platform].map(item => norm(item.email)).filter(Boolean)
    : [];
  const observedSet = new Set(observed);
  const assignedSet = new Set(assigned.map(account => norm(account.email)));
  const unexpected = observed.filter(email => !assignedSet.has(email));
  const missing = [];
  let presentCount = 0;
  let swappedCount = 0;
  let needsReauthCount = 0;

  for (const account of assigned) {
    const present = observedSet.has(norm(account.email));
    let accountState;
    if (present) {
      presentCount += 1;
      // ADB proves local registration only. It cannot prove that Google's token
      // is still accepted, so a manual reauth flag remains until explicitly cleared.
      accountState = account.verification_state === 'needs_reauth' && !options.clear_reauth
        ? 'needs_reauth'
        : 'present';
      if (accountState === 'needs_reauth') needsReauthCount += 1;
    } else {
      missing.push(account.email);
      accountState = unexpected.length ? 'swapped' : 'missing';
      if (accountState === 'swapped') swappedCount += 1;
    }
    const message = accountState === 'present'
      ? 'Expected account present locally'
      : accountState === 'needs_reauth'
        ? 'Account present locally; operator sign-in review remains open'
        : accountState === 'swapped'
          ? `Expected account absent; ${unexpected.length} other account(s) observed for this platform`
          : 'Expected account absent; no other account observed for this platform';
    await recordState(device, account, accountState, message);
  }

  const state = swappedCount ? 'swapped' : missing.length ? 'missing' : needsReauthCount ? 'needs_reauth' : 'present';
  const realAccounts = observed.map(email => ({ email, type: platform, assigned: assignedSet.has(email) }));
  if (LAB && LAB.audit) LAB.audit('account_inventory.verify_device', state, {
    platform, assigned_count: assigned.length, present_count: presentCount,
    missing_count: missing.length, swapped_count: swappedCount, needs_reauth_count: needsReauthCount,
    observed_count: observed.length, unexpected_count: unexpected.length, identifiers_exposed: false,
  }, { device_id: device.id });
  return {
    ...base,
    success: true,
    state,
    real_count: observed.length,
    present_count: presentCount,
    missing_count: missing.length,
    swapped_count: swappedCount,
    needs_reauth_count: needsReauthCount,
    missing_from_device: missing,
    unexpected_on_device: unexpected,
    total_real: observed.length,
    total_assigned: assigned.length,
    real_accounts: realAccounts,
    assigned_accounts: assigned.map(account => ({
      id: account.id,
      email: account.email,
      platform: account.platform,
      verification_state: account.verification_state === 'needs_reauth' && !options.clear_reauth
        ? 'needs_reauth'
        : observedSet.has(norm(account.email))
          ? 'present'
          : unexpected.length ? 'swapped' : 'missing',
    })),
    mismatched: [],
  };
}

// needs_reauth is an operator observation. Android's account registry cannot
// reliably distinguish a valid Google session from one that needs a password.
async function setReviewState(accountId, requestedState) {
  requireInit();
  const account = DB.get('SELECT * FROM accounts WHERE id=?', [Number(accountId)]);
  if (!account || !account.active || account.device_id == null) throw new Error('Active assigned account not found');
  const device = DB.get('SELECT * FROM devices WHERE id=?', [Number(account.device_id)]);
  if (!device) throw new Error('Assigned device not found');
  if (!scoped(device)) throw new Error('Operation is outside the exact lab device allowlist');

  const state = String(requestedState || '').trim();
  if (state === 'needs_reauth') {
    if (!['present', 'needs_reauth'].includes(account.verification_state || 'unknown')) {
      throw new Error('Re-login review can only be marked when the expected account is present locally');
    }
    const already = account.verification_state === 'needs_reauth';
    if (!already) await recordState(device, account, 'needs_reauth', 'Operator marked sign-in review as required');
    if (LAB && LAB.audit) LAB.audit('account_inventory.set_review_state', already ? 'idempotent' : 'ok', {
      account_id: account.id, device_id: device.id, state, identifiers_exposed: false,
    });
    return { account_id: account.id, device_id: device.id, state, idempotent: already };
  }
  if (state === 'present') {
    const result = await verifyDevice(device, { platform: account.platform, source: 'operator_confirmation', clear_reauth: true });
    const local = result.real_accounts.some(row => norm(row.email) === norm(account.email));
    if (!local) throw new Error('Cannot clear review: the expected account is not present on the device');
    if (LAB && LAB.audit) LAB.audit('account_inventory.set_review_state', 'ok', {
      account_id: account.id, device_id: device.id, state, identifiers_exposed: false,
    });
    return { account_id: account.id, device_id: device.id, state, idempotent: account.verification_state === 'present' };
  }
  throw new Error('state must be needs_reauth or present');
}

// A detected swap only changes verification_state. Updating the expected account
// requires this explicit operator-confirmed action and a fresh device scan.
async function confirmSwap(input = {}) {
  requireInit();
  const expected = DB.get('SELECT * FROM accounts WHERE id=?', [Number(input.expected_account_id)]);
  if (!expected || expected.device_id == null) throw new Error('Expected account assignment not found');
  const device = DB.get('SELECT * FROM devices WHERE id=?', [Number(expected.device_id)]);
  if (!device) throw new Error('Assigned device not found');
  if (!scoped(device)) throw new Error('Operation is outside the exact lab device allowlist');
  const observedEmail = norm(input.observed_email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(observedEmail)) throw new Error('observed_email is invalid');

  const current = assignedFor(device.id, expected.platform)[0];
  if (current && norm(current.email) === observedEmail) {
    if (LAB && LAB.audit) LAB.audit('account_inventory.confirm_swap', 'idempotent', {
      previous_account_id: expected.id, replacement_account_id: current.id,
      device_id: device.id, platform: expected.platform, identifiers_exposed: false,
    });
    return { account: accountsStore.publicView(current), previous_account_id: expected.id, idempotent: true };
  }
  if (!expected.active || !current || Number(current.id) !== Number(expected.id)) {
    throw new Error('Active assignment changed; scan again before confirming the swap');
  }

  const existing = DB.get(
    "SELECT * FROM accounts WHERE lower(email)=? AND COALESCE(platform,'')=? LIMIT 1",
    [observedEmail, expected.platform]
  );
  if (existing && existing.device_id != null && Number(existing.device_id) !== Number(device.id)) {
    throw new Error('Observed account is already assigned to another device');
  }

  const scan = await verifyDevice(device, { platform: expected.platform, source: 'swap_confirmation' });
  if (!scan.unexpected_on_device.some(email => norm(email) === observedEmail)) {
    throw new Error('Observed replacement is no longer present; scan again');
  }
  const replacement = accountsStore.upsertAssignment({
    email: observedEmail,
    username: observedEmail,
    platform: expected.platform,
    notes: `${labelFor(device, expected)} confirmed observed replacement`,
    status: 'active',
  }, device.id);
  const timestamp = now();
  DB.run(
    `UPDATE accounts SET verification_state='present',last_verified_at=?,last_seen_on_device_at=?,
       last_verification_message='Observed replacement confirmed by operator',consecutive_missing=0,updated_at=? WHERE id=?`,
    [timestamp, timestamp, timestamp, replacement.id]
  );
  if (LAB && LAB.audit) LAB.audit('account_inventory.confirm_swap', 'ok', {
    previous_account_id: expected.id, replacement_account_id: replacement.id,
    device_id: device.id, platform: expected.platform, identifiers_exposed: false,
  });
  return {
    account: accountsStore.publicView(DB.get('SELECT * FROM accounts WHERE id=?', [replacement.id])),
    previous_account_id: expected.id,
    idempotent: false,
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
    catch (error) {
      results.push(resultSkeleton({
        device_id: device.id, device_name: device.name, serial: device.adb_serial,
        platform, assigned_count: 0,
      }, 'unknown', false, error.message));
    }
  }
  const summary = {
    devices_checked: results.length,
    devices_present: results.filter(row => row.state === 'present').length,
    devices_missing: results.filter(row => row.state === 'missing').length,
    devices_swapped: results.filter(row => row.state === 'swapped').length,
    devices_needs_reauth: results.filter(row => row.state === 'needs_reauth').length,
    devices_unreachable: results.filter(row => row.state === 'unreachable').length,
    devices_unknown: results.filter(row => row.state === 'unknown').length,
    total_real: results.reduce((sum, row) => sum + Number(row.real_count || 0), 0),
    total_assigned: results.reduce((sum, row) => sum + Number(row.assigned_count || 0), 0),
    total_missing: results.reduce((sum, row) => sum + row.missing_from_device.length, 0),
    total_swapped: results.reduce((sum, row) => sum + Number(row.swapped_count || 0), 0),
    total_needs_reauth: results.reduce((sum, row) => sum + Number(row.needs_reauth_count || 0), 0),
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

module.exports = {
  init, getConfig, setConfig, verifyDevice, verifyAll, inventory,
  setReviewState, confirmSwap, tick, shutdown,
};
