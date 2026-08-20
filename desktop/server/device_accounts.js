const { now } = require('./db');
const labControl = require('./lab_control');

let DB = null;
let DISPATCH = null;

function init(db, { dispatchDevice } = {}) {
  DB = db;
  DISPATCH = dispatchDevice;
  DB.run(`CREATE TABLE IF NOT EXISTS device_account_controls (
    device_id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'google',
    rotation_allowed INTEGER NOT NULL DEFAULT 0,
    enrollment_state TEXT NOT NULL DEFAULT 'idle',
    enrollment_baseline_count INTEGER,
    observed_account_count INTEGER,
    last_action_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(device_id) REFERENCES devices(id)
  )`);
}

function requireReady() {
  if (!DB || !DISPATCH) throw new Error('device_accounts no inicializado');
}

function deviceFor(deviceId) {
  requireReady();
  const device = DB.get('SELECT * FROM devices WHERE id=?', [Number(deviceId)]);
  if (!device) throw new Error('Dispositivo no encontrado');
  return device;
}

function controlFor(deviceId) {
  const row = DB.get('SELECT * FROM device_account_controls WHERE device_id=?', [Number(deviceId)]);
  return row || {
    device_id: Number(deviceId),
    provider: 'google',
    rotation_allowed: 0,
    enrollment_state: 'idle',
    enrollment_baseline_count: null,
    observed_account_count: null,
    last_action_at: null,
  };
}

function publicControl(row) {
  return {
    device_id: Number(row.device_id),
    provider: row.provider || 'google',
    rotation_allowed: !!row.rotation_allowed,
    enrollment_state: row.enrollment_state || 'idle',
    enrollment_baseline_count: row.enrollment_baseline_count == null ? null : Number(row.enrollment_baseline_count),
    observed_account_count: row.observed_account_count == null ? null : Number(row.observed_account_count),
    last_action_at: row.last_action_at || null,
    updated_at: row.updated_at || null,
  };
}

function upsertControl(deviceId, fields = {}) {
  const existing = controlFor(deviceId);
  const timestamp = now();
  const next = {
    provider: 'google',
    rotation_allowed: fields.rotation_allowed == null ? Number(existing.rotation_allowed || 0) : (fields.rotation_allowed ? 1 : 0),
    enrollment_state: fields.enrollment_state == null ? existing.enrollment_state : fields.enrollment_state,
    enrollment_baseline_count: fields.enrollment_baseline_count === undefined ? existing.enrollment_baseline_count : fields.enrollment_baseline_count,
    observed_account_count: fields.observed_account_count === undefined ? existing.observed_account_count : fields.observed_account_count,
    last_action_at: fields.last_action_at === undefined ? existing.last_action_at : fields.last_action_at,
  };
  DB.run(`INSERT INTO device_account_controls(
      device_id,provider,rotation_allowed,enrollment_state,enrollment_baseline_count,
      observed_account_count,last_action_at,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(device_id) DO UPDATE SET
      provider=excluded.provider,
      rotation_allowed=excluded.rotation_allowed,
      enrollment_state=excluded.enrollment_state,
      enrollment_baseline_count=excluded.enrollment_baseline_count,
      observed_account_count=excluded.observed_account_count,
      last_action_at=excluded.last_action_at,
      updated_at=excluded.updated_at`, [
    Number(deviceId), next.provider, next.rotation_allowed, next.enrollment_state,
    next.enrollment_baseline_count, next.observed_account_count, next.last_action_at,
    timestamp, timestamp,
  ]);
  return publicControl(DB.get('SELECT * FROM device_account_controls WHERE device_id=?', [Number(deviceId)]));
}

async function readGoogleAccountCount(device) {
  const result = await DISPATCH(device.serial_number, 'GET_GOOGLE_ACCOUNTS', {});
  if (!result || !result.success) throw new Error((result && result.message) || 'No se pudieron leer las cuentas Google');
  return Number(result.data && result.data.account_count) || 0;
}

async function inspect(deviceId) {
  const device = deviceFor(deviceId);
  labControl.assertDeviceInScope(device.id);
  const count = await readGoogleAccountCount(device);
  const control = upsertControl(device.id, { observed_account_count: count });
  return { ...control, google_account_count: count, identifiers_exposed: false };
}

async function startEnrollment(deviceId, input = {}) {
  const device = deviceFor(deviceId);
  labControl.assertDeviceAllowed(device.id);
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  if (input.idempotency_key) {
    const prior = DB.get('SELECT * FROM audit_events WHERE idempotency_key=?', [input.idempotency_key]);
    if (prior) return { ...await inspect(device.id), idempotent_replay: true };
  }
  const baseline = await readGoogleAccountCount(device);
  const opened = await DISPATCH(device.serial_number, 'OPEN_GOOGLE_ACCOUNT_ENROLLMENT', {});
  if (!opened || !opened.success) throw new Error((opened && opened.message) || 'No se pudo abrir el alta de cuenta Google');
  const control = upsertControl(device.id, {
    enrollment_state: 'awaiting_owner',
    enrollment_baseline_count: baseline,
    observed_account_count: baseline,
    last_action_at: now(),
  });
  labControl.audit('device_account.google_enrollment_start', 'awaiting_owner', {
    provider: 'google', baseline_account_count: baseline, credentials_captured: false,
  }, { ...input, device_id: device.id });
  return {
    ...control,
    google_account_count: baseline,
    native_ui_opened: true,
    owner_action_required: true,
    credentials_captured: false,
  };
}

async function verifyEnrollment(deviceId, input = {}) {
  const device = deviceFor(deviceId);
  labControl.assertDeviceAllowed(device.id);
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  if (input.idempotency_key) {
    const prior = DB.get('SELECT * FROM audit_events WHERE idempotency_key=?', [input.idempotency_key]);
    if (prior) return { ...await inspect(device.id), idempotent_replay: true };
  }
  const before = controlFor(device.id);
  const baseline = before.enrollment_baseline_count == null ? 0 : Number(before.enrollment_baseline_count);
  const count = await readGoogleAccountCount(device);
  const enrolled = count > baseline;
  const state = enrolled ? 'verified' : 'awaiting_owner';
  const control = upsertControl(device.id, {
    enrollment_state: state,
    observed_account_count: count,
    last_action_at: now(),
  });
  labControl.audit('device_account.google_enrollment_verify', enrolled ? 'verified' : 'not_changed', {
    provider: 'google', baseline_account_count: baseline, observed_account_count: count,
    enrolled, identifiers_exposed: false,
  }, { ...input, device_id: device.id });
  return {
    ...control,
    google_account_count: count,
    enrollment_verified: enrolled,
    identifiers_exposed: false,
  };
}

function setRotationAllowed(deviceId, input = {}) {
  const device = deviceFor(deviceId);
  labControl.assertDeviceAllowed(device.id);
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  if (typeof input.enabled !== 'boolean') throw new Error('enabled boolean requerido');
  if (input.idempotency_key) {
    const prior = DB.get('SELECT * FROM audit_events WHERE idempotency_key=?', [input.idempotency_key]);
    if (prior) return { ...publicControl(controlFor(device.id)), idempotent_replay: true };
  }
  const control = upsertControl(device.id, { rotation_allowed: input.enabled, last_action_at: now() });
  labControl.audit('device_account.google_rotation_policy', 'ok', {
    provider: 'google', rotation_allowed: input.enabled,
  }, { ...input, device_id: device.id });
  return control;
}

async function openRotation(deviceId, input = {}) {
  const device = deviceFor(deviceId);
  labControl.assertDeviceAllowed(device.id);
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  const control = publicControl(controlFor(device.id));
  if (!control.rotation_allowed) throw new Error('La rotaciÃ³n Google no estÃ¡ permitida para este dispositivo');
  const count = await readGoogleAccountCount(device);
  if (count < 2) throw new Error('Se requieren al menos dos cuentas Google instaladas para rotar');
  const opened = await DISPATCH(device.serial_number, 'OPEN_GOOGLE_ACCOUNT_SETTINGS', {});
  if (!opened || !opened.success) throw new Error((opened && opened.message) || 'No se pudieron abrir las cuentas Google');
  labControl.audit('device_account.google_rotation_open', 'awaiting_owner', {
    provider: 'google', google_account_count: count, credentials_captured: false,
  }, { ...input, device_id: device.id });
  return {
    ...control,
    google_account_count: count,
    native_ui_opened: true,
    owner_action_required: true,
    automatic_os_account_switch: false,
  };
}

module.exports = { init, inspect, startEnrollment, verifyEnrollment, setRotationAllowed, openRotation, publicControl };
