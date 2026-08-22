const fs = require('fs');
const path = require('path');
const { now } = require('./db');

let DB = null;

const SAFE_LAB_STEPS = new Set([
  'USE_ACCOUNT',
  'OPEN_APP',
  'CLICK_BY_TEXT',
  'CLICK_BY_ID',
  'SET_TEXT',
  'SCROLL',
  'PRESS_BACK',
  'PRESS_HOME',
  'WAIT_FOR_ELEMENT',
  'WAIT_FOR_TEXT',
  'ASSERT_TEXT',
  'CHECK_BAN',
  'DEVICE_HEALTH',
  'DEVICE_NETWORK_STATUS',
  'CHECK_IP',
  'WAIT',
  'TYPING_DELAY',
  'REPORT_RESULT',
]);

const CANARY_FULL_ENABLED = /^(1|true|yes)$/i.test(String(process.env.MCP_CANARY_FULL || ''));
const CANARY_FULL_STEPS = new Set([
  ...SAFE_LAB_STEPS,
  'SWIPE', 'TAP_XY', 'INPUT_KEYEVENT', 'TYPE_TEXT',
  'START_ACTIVITY', 'FORCE_STOP', 'GRANT_PERMISSION',
  'SETTINGS_GET', 'SCREEN_ON', 'SCREEN_OFF', 'UNLOCK',
  'KEEP_AWAKE', 'SET_TIME_AUTO', 'SET_TIMEZONE', 'GET_TIME',
  'DEVICE_STABILIZE', 'READ_SCREEN_TEXT', 'CAPTURE_SCREEN',
  'PLAY_MEDIA', 'PAUSE_MEDIA', 'GOTO_URL', 'SCREEN_RECORD',
  'PULL_FILE',
  'CLEAR_APP', 'UNINSTALL_APP', 'INSTALL_APK', 'SETTINGS_PUT',
  'REBOOT', 'MONKEY', 'PUSH_FILE',
]);
const CONFIRMATION_REQUIRED_STEPS = new Set([
  'CLEAR_APP', 'UNINSTALL_APP', 'INSTALL_APK', 'SETTINGS_PUT',
  'REBOOT', 'MONKEY', 'PUSH_FILE',
]);

const SECRET_KEY_RE = /(pass(word)?|token|secret|credential|totp|authorization|cookie|session)/i;
const URI_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

function init(db) {
  DB = db;
  DB.run(
    'INSERT OR IGNORE INTO lab_control_state(id,lab_mode_enabled,halted,hermes_enabled,updated_at) VALUES (1,1,0,0,?)',
    [now()]
  );
  if (!/^(1|true|yes)$/i.test(String(process.env.MCP_HERMES_ENABLED || ''))) {
    DB.run('UPDATE lab_control_state SET hermes_enabled=0,updated_at=? WHERE id=1', [now()]);
  }
}

function requireDb() {
  if (!DB) throw new Error('lab_control no inicializado');
}

function sanitize(value, key = '') {
  if (SECRET_KEY_RE.test(String(key))) return '[REDACTED]';
  if (typeof value === 'string') {
    return value
      .replace(URI_USERINFO_RE, '$1[REDACTED]@')
      .replace(/\b(password|passwd|token|secret|authorization|totp)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') {
    const clean = {};
    for (const [childKey, childValue] of Object.entries(value)) clean[childKey] = sanitize(childValue, childKey);
    return clean;
  }
  return value;
}

function state() {
  requireDb();
  const row = DB.get('SELECT * FROM lab_control_state WHERE id=1');
  const canary = row && row.canary_device_id
    ? DB.get('SELECT id,name,serial_number,status,assigned_group_id FROM devices WHERE id=?', [row.canary_device_id])
    : null;
  return {
    lab_mode_enabled: !!(row && row.lab_mode_enabled),
    halted: !!(row && row.halted),
    lab_scope: configuredLabScope(),
    allowlisted_device_count: configuredDeviceAllowlist().size,
    canary_device_id: row ? row.canary_device_id : null,
    canary_device: canary || null,
    hermes_enabled: !!(row && row.hermes_enabled),
    canary_full_enabled: CANARY_FULL_ENABLED,
    halt_reason: row ? row.halt_reason : null,
    updated_at: row ? row.updated_at : null,
  };
}

function audit(operation, result, details = {}, options = {}) {
  requireDb();
  const idempotencyKey = options.idempotency_key || null;
  if (idempotencyKey) {
    const existing = DB.get('SELECT * FROM audit_events WHERE idempotency_key=?', [idempotencyKey]);
    if (existing) return existing;
  }
  const clean = sanitize(details);
  const inserted = DB.run(
    'INSERT INTO audit_events(operation,actor,device_id,route_id,idempotency_key,result,details,created_at) VALUES (?,?,?,?,?,?,?,?)',
    [
      operation,
      options.actor || 'local-operator',
      options.device_id || null,
      options.route_id || null,
      idempotencyKey,
      result,
      JSON.stringify(clean),
      now(),
    ]
  );
  return DB.get('SELECT * FROM audit_events WHERE id=?', [inserted.lastInsertRowid]);
}

function configure(input = {}) {
  requireDb();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  const current = state();
  const canaryId = input.canary_device_id === undefined ? current.canary_device_id : Number(input.canary_device_id);
  if (canaryId) {
    const device = DB.get('SELECT id FROM devices WHERE id=?', [canaryId]);
    if (!device) throw new Error('Dispositivo canario no encontrado');
  }
  const labEnabled = input.lab_mode_enabled === undefined ? current.lab_mode_enabled : !!input.lab_mode_enabled;
  const hermesEnabled = input.hermes_enabled === undefined ? current.hermes_enabled : !!input.hermes_enabled;
  const runtimeHermesAllowed = /^(1|true|yes)$/i.test(String(process.env.MCP_HERMES_ENABLED || ''));
  if (hermesEnabled && !runtimeHermesAllowed) throw new Error('Hermes está deshabilitado por la configuración de arranque');
  if (labEnabled && hermesEnabled) throw new Error('Hermes debe permanecer deshabilitado durante el laboratorio');
  DB.run(
    'UPDATE lab_control_state SET lab_mode_enabled=?,canary_device_id=?,hermes_enabled=?,updated_at=? WHERE id=1',
    [labEnabled ? 1 : 0, canaryId || null, hermesEnabled ? 1 : 0, now()]
  );
  audit('lab.configure', 'ok', { lab_mode_enabled: labEnabled, canary_device_id: canaryId || null, hermes_enabled: hermesEnabled }, input);
  return state();
}

function assertOperational() {
  const current = state();
  if (current.halted) throw new Error(`Laboratorio detenido: ${current.halt_reason || 'emergency stop'}`);
  return current;
}

function configuredLabScope() {
  return String(process.env.MCP_LAB_SCOPE || 'canary').trim().toLowerCase() === 'allowlist'
    ? 'allowlist'
    : 'canary';
}

function configuredDeviceAllowlist() {
  const values = String(process.env.MCP_ADB_ALLOWLIST || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
  const allowlistFile = String(process.env.MCP_ADB_ALLOWLIST_FILE || '').trim();
  if (allowlistFile) {
    if (!path.isAbsolute(allowlistFile)) throw new Error('MCP_ADB_ALLOWLIST_FILE must be absolute');
    const lines = fs.readFileSync(allowlistFile, 'utf8')
      .split(/\r?\n/)
      .map(value => value.trim())
      .filter(value => value && !value.startsWith('#'));
    values.push(...lines);
  }
  return new Set(values);
}

function deviceMatchesAllowlist(device, allowlist) {
  if (!device || allowlist.size === 0) return false;
  return [device.adb_serial, device.serial_number]
    .filter(Boolean)
    .some(value => allowlist.has(String(value).trim()));
}

function assertDeviceInScope(deviceId) {
  const current = state();
  if (!current.lab_mode_enabled) return current;
  if (configuredLabScope() === 'allowlist') {
    const device = DB.get('SELECT id,serial_number,adb_serial FROM devices WHERE id=?', [Number(deviceId)]);
    if (!device) throw new Error('Dispositivo no encontrado');
    if (!deviceMatchesAllowlist(device, configuredDeviceAllowlist())) {
      throw new Error('Operation is outside the exact lab device allowlist');
    }
    return current;
  }
  if (!current.canary_device_id) throw new Error('Configure a canary device first');
  if (Number(deviceId) !== Number(current.canary_device_id)) throw new Error('Operation is outside the canary device');
  return current;
}
function assertDeviceAllowed(deviceId) {
  assertOperational();
  return assertDeviceInScope(deviceId);
}

function validateStep(step, index = 0) {
  const errors = [];
  if (!step || typeof step !== 'object' || Array.isArray(step)) return [`Paso ${index + 1}: objeto requerido`];
  const type = String(step.type || '');
  if (!type) return [`Paso ${index + 1}: type requerido`];
  const allowed = SAFE_LAB_STEPS.has(type) || (CANARY_FULL_ENABLED && CANARY_FULL_STEPS.has(type));
  if (!allowed) errors.push(`Paso ${index + 1}: ${type} no permitido en modo laboratorio`);
  if (CANARY_FULL_ENABLED && CONFIRMATION_REQUIRED_STEPS.has(type) && step.confirm !== true) {
    errors.push(`Paso ${index + 1}: ${type} requiere confirm=true en modo canario completo`);
  }
  if (type === 'USE_ACCOUNT' && !Number.isInteger(Number(step.account_id))) errors.push(`Paso ${index + 1}: USE_ACCOUNT requiere account_id explícito`);
  if (type === 'OPEN_APP' && !(step.package_name || step.packageName)) errors.push(`Paso ${index + 1}: OPEN_APP requiere package_name`);
  if (['CLICK_BY_TEXT', 'WAIT_FOR_TEXT', 'ASSERT_TEXT'].includes(type) && !String(step.text || '').trim()) errors.push(`Paso ${index + 1}: text requerido`);
  if (type === 'SET_TEXT' && !(step.resource_id || step.resourceId)) errors.push(`Paso ${index + 1}: SET_TEXT requiere resource_id`);
  if (type === 'WAIT' || type === 'TYPING_DELAY') {
    const duration = Number(step.duration ?? 1000);
    if (!Number.isFinite(duration) || duration < 0 || duration > 30000) errors.push(`Paso ${index + 1}: duration debe estar entre 0 y 30000 ms`);
  }
  if (step.timeout_ms != null && Number(step.timeout_ms) > 30000) errors.push(`Paso ${index + 1}: timeout_ms máximo 30000`);
  for (const [key, value] of Object.entries(step)) {
    if (typeof value === 'string' && value.length > 1000) errors.push(`Paso ${index + 1}: ${key} excede 1000 caracteres`);
  }
  return errors;
}

function validateWorkflowSteps(steps) {
  const errors = [];
  if (!Array.isArray(steps) || steps.length === 0) errors.push('El workflow requiere al menos un paso');
  if (Array.isArray(steps) && steps.length > 30) errors.push('Máximo 30 pasos por workflow de laboratorio');
  if (Array.isArray(steps)) steps.forEach((step, index) => errors.push(...validateStep(step, index)));
  return { valid: errors.length === 0, steps_count: Array.isArray(steps) ? steps.length : 0, errors };
}

function emergencyStop(input = {}) {
  requireDb();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  const reason = String(input.reason || '').trim();
  if (!reason) throw new Error('reason requerido');
  if (input.idempotency_key) {
    const prior = DB.get('SELECT * FROM audit_events WHERE idempotency_key=?', [input.idempotency_key]);
    if (prior) return state();
  }
  DB.run('UPDATE lab_control_state SET halted=1,halt_reason=?,updated_at=? WHERE id=1', [reason, now()]);
  DB.run("UPDATE tasks SET status='cancel_requested',error_message=?,updated_at=? WHERE status='running'", [`Emergency stop: ${reason}`, now()]);
  DB.run("UPDATE tasks SET status='cancelled',error_message=?,completed_at=?,updated_at=? WHERE status='scheduled'", [`Emergency stop: ${reason}`, now(), now()]);
  DB.run('UPDATE schedules SET is_active=0,updated_at=? WHERE is_active=1', [now()]);
  audit('lab.emergency_stop', 'halted', { reason }, input);
  return state();
}

function resume(input = {}) {
  requireDb();
  if (input.confirm_resume !== true) throw new Error('confirm_resume=true requerido');
  if (!String(input.reason || '').trim()) throw new Error('reason requerido');
  DB.run('UPDATE lab_control_state SET halted=0,halt_reason=NULL,updated_at=? WHERE id=1', [now()]);
  audit('lab.resume', 'ok', { reason: input.reason }, input);
  return state();
}

function hermesAllowed() {
  const current = state();
  return !current.lab_mode_enabled && current.hermes_enabled && !current.halted;
}

module.exports = {
  SAFE_LAB_STEPS,
  CANARY_FULL_STEPS,
  CONFIRMATION_REQUIRED_STEPS,
  init,
  state,
  configure,
  audit,
  sanitize,
  configuredDeviceAllowlist,
  assertOperational,
  assertDeviceInScope,
  assertDeviceAllowed,
  validateStep,
  validateWorkflowSteps,
  emergencyStop,
  resume,
  hermesAllowed,
};
