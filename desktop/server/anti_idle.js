const crypto = require('crypto');
const { now } = require('./db');
const labControl = require('./lab_control');

const DEFAULT_PACKAGES = ['com.android.settings', 'com.android.vending', 'com.google.android.gm'];
const PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
let DB = null;
let DISPATCH = null;
let CLOCK = () => Date.now();
let SLEEP = ms => new Promise(resolve => setTimeout(resolve, ms));
let RUN_PROMISE = null;

function ready() {
  if (!DB || !DISPATCH) throw new Error('Anti-idle no inicializado');
}
function isoAt(ms = CLOCK()) {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}
function safeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}
function init(db, options = {}) {
  if (DB === db && DISPATCH) return state();
  DB = db;
  DISPATCH = options.dispatch;
  CLOCK = options.clock || (() => Date.now());
  SLEEP = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  RUN_PROMISE = null;
  ready();
  DB.run(
    `INSERT OR IGNORE INTO anti_idle_state(
      id,enabled,running,device_ids,package_names,interval_seconds,
      action_duration_seconds,gesture_interval_seconds,updated_at
    ) VALUES (1,0,0,'[]',?,480,45,4,?)`,
    [JSON.stringify(DEFAULT_PACKAGES), now()]
  );
  const previous = DB.get('SELECT enabled,running FROM anti_idle_state WHERE id=1');
  const restartMessage = previous && (previous.enabled || previous.running)
    ? 'Paused after application restart; explicit start required'
    : null;
  DB.run(
    `UPDATE anti_idle_state
     SET enabled=0,running=0,active_run_id=NULL,next_run_at=NULL,last_error=?,updated_at=? WHERE id=1`,
    [restartMessage, now()]
  );
  return state();
}
function publicState(row) {
  return row && {
    enabled: !!row.enabled,
    running: !!row.running,
    device_ids: safeJson(row.device_ids, []),
    package_names: safeJson(row.package_names, DEFAULT_PACKAGES),
    interval_seconds: Number(row.interval_seconds),
    action_duration_seconds: Number(row.action_duration_seconds),
    gesture_interval_seconds: Number(row.gesture_interval_seconds),
    natural_scrolls_enabled: row.natural_scrolls_enabled !== 0,
    last_run_at: row.last_run_at || null,
    next_run_at: row.next_run_at || null,
    last_result: safeJson(row.last_result, null),
    last_error: row.last_error || null,
    updated_at: row.updated_at || null,
  };
}
function state() {
  if (!DB) throw new Error('Anti-idle no inicializado');
  return publicState(DB.get('SELECT * FROM anti_idle_state WHERE id=1'));
}
function replay(input = {}) {
  return input.idempotency_key
    ? DB.get('SELECT id FROM audit_events WHERE idempotency_key=?', [String(input.idempotency_key)])
    : null;
}
function packagesOf(values) {
  const packages = [...new Set((Array.isArray(values) ? values : []).map(String).map(value => value.trim()).filter(Boolean))];
  if (packages.length < 2 || packages.length > 5) throw new Error('Seleccione entre 2 y 5 paquetes');
  for (const packageName of packages) {
    if (!PACKAGE_RE.test(packageName) || packageName.length > 160) throw new Error(`Paquete inválido: ${packageName}`);
  }
  return packages;
}
function timingOf(input = {}) {
  const interval = Number(input.interval_seconds ?? 480);
  const duration = Number(input.action_duration_seconds ?? 45);
  const gesture = Number(input.gesture_interval_seconds ?? 4);
  if (!Number.isInteger(interval) || interval < 60 || interval > 3600) throw new Error('interval_seconds fuera de rango');
  if (!Number.isInteger(duration) || duration < 10 || duration > 300) throw new Error('action_duration_seconds fuera de rango');
  if (!Number.isInteger(gesture) || gesture < 2 || gesture > 15) throw new Error('gesture_interval_seconds fuera de rango');
  return { interval, duration, gesture, naturalScrolls: input.natural_scrolls_enabled !== false };
}
function targets(deviceIds, requireOnline = true) {
  const ids = [...new Set((Array.isArray(deviceIds) ? deviceIds : []).map(Number))];
  const control = labControl.state();
  const maximum = control.lab_mode_enabled ? Math.max(1, control.allowlisted_device_count) : 200;
  if (!ids.length || ids.length > maximum || ids.some(id => !Number.isInteger(id) || id <= 0)) {
    throw new Error(`Se requieren entre 1 y ${maximum} device_ids explícitos`);
  }
  labControl.assertOperational();
  ids.forEach(id => labControl.assertDeviceAllowed(id));
  const marks = ids.map(() => '?').join(',');
  const devices = DB.all(`SELECT * FROM devices WHERE id IN (${marks}) ORDER BY id`, ids);
  if (devices.length !== ids.length) throw new Error('Uno o más dispositivos no existen');
  if (requireOnline) {
    const blocked = devices.filter(device => device.status !== 'online' || device.current_task_id != null);
    if (blocked.length) throw new Error(`Dispositivos no disponibles: ${blocked.map(device => device.id).join(', ')}`);
  }
  const routes = DB.all(
    `SELECT pra.device_id,pr.health_state,pr.expected_public_ip,pr.observed_public_ip
     FROM proxy_route_assignments pra JOIN proxy_routes pr ON pr.route_id=pra.route_id
     WHERE pra.active=1 AND pra.device_id IN (${marks})`, ids
  );
  const byDevice = new Map(routes.map(route => [Number(route.device_id), route]));
  const unsafe = ids.filter(id => {
    const route = byDevice.get(id);
    return !route || route.health_state !== 'verified' || !route.expected_public_ip || route.observed_public_ip !== route.expected_public_ip;
  });
  if (unsafe.length) throw new Error(`Rutas no verificadas: ${unsafe.join(', ')}`);
  return devices;
}
function configure(input = {}) {
  ready();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  if (replay(input)) return state();
  const current = state();
  if (current.enabled || current.running) throw new Error('Detenga anti-idle antes de configurarlo');
  const deviceIds = targets(input.device_ids).map(device => Number(device.id));
  const packages = packagesOf(input.package_names || DEFAULT_PACKAGES);
  const timing = timingOf(input);
  DB.run(
    `UPDATE anti_idle_state SET device_ids=?,package_names=?,interval_seconds=?,action_duration_seconds=?,
     gesture_interval_seconds=?,natural_scrolls_enabled=?,last_error=NULL,updated_at=? WHERE id=1`,
    [JSON.stringify(deviceIds), JSON.stringify(packages), timing.interval, timing.duration,
      timing.gesture, timing.naturalScrolls ? 1 : 0, now()]
  );
  labControl.audit('anti_idle.configure', 'ok', {
    device_ids: deviceIds, package_names: packages, interval_seconds: timing.interval,
    action_duration_seconds: timing.duration, gesture_interval_seconds: timing.gesture,
    natural_scrolls_enabled: timing.naturalScrolls,
  }, input);
  return state();
}
function start(input = {}) {
  ready();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  if (replay(input)) return state();
  const current = state();
  targets(current.device_ids);
  const first = input.run_immediately === false ? CLOCK() + current.interval_seconds * 1000 : CLOCK();
  DB.run('UPDATE anti_idle_state SET enabled=1,running=0,next_run_at=?,last_error=NULL,updated_at=? WHERE id=1', [isoAt(first), now()]);
  labControl.audit('anti_idle.start', 'ok', { device_ids: current.device_ids, run_immediately: input.run_immediately !== false }, input);
  setImmediate(() => tick().catch(error => console.error('[anti-idle]', error.message)));
  return state();
}
function stop(input = {}) {
  ready();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  if (replay(input)) return state();
  const reason = String(input.reason || 'operator stop').trim().slice(0, 240);
  DB.run('UPDATE anti_idle_state SET enabled=0,next_run_at=NULL,last_error=?,updated_at=? WHERE id=1', [reason, now()]);
  labControl.audit('anti_idle.stop', 'ok', { reason }, input);
  return state();
}
function active(runId) {
  const row = DB.get('SELECT enabled,active_run_id FROM anti_idle_state WHERE id=1');
  return !!(row && row.enabled && row.active_run_id === runId && !labControl.state().halted);
}
async function wait(ms, runId) {
  const end = CLOCK() + Math.max(0, ms);
  while (CLOCK() < end) {
    if (!active(runId)) return false;
    await SLEEP(Math.min(500, end - CLOCK()));
  }
  return active(runId);
}
async function runDevice(device, config, runId) {
  const end = CLOCK() + config.action_duration_seconds * 1000;
  let packageIndex = Number(device.id) % config.package_names.length;
  let direction = Number(device.id) % 2 ? 'down' : 'up';
  let actionIndex = 0, appSwitches = 0, gestures = 0, failures = 0, cancelled = false;
  while (CLOCK() < end) {
    if (!active(runId)) { cancelled = true; break; }
    if (actionIndex % 2 === 0) {
      const packageName = config.package_names[packageIndex++ % config.package_names.length];
      const opened = await DISPATCH(device.serial_number, 'OPEN_APP', { package_name: packageName });
      opened && opened.success ? appSwitches++ : failures++;
      if (!active(runId)) { cancelled = true; break; }
    }
    if (config.natural_scrolls_enabled) {
      const scrolled = await DISPATCH(device.serial_number, 'SCROLL', { direction });
      scrolled && scrolled.success ? gestures++ : failures++;
      direction = direction === 'down' ? 'up' : 'down';
    }
    actionIndex++;
    const remaining = end - CLOCK();
    if (remaining <= 0) break;
    if (!await wait(Math.min(config.gesture_interval_seconds * 1000, remaining), runId)) { cancelled = true; break; }
  }
  return { device_id: Number(device.id), app_switches: appSwitches, gestures, failures, cancelled };
}
async function cycle(trigger = 'scheduled') {
  const config = state();
  if (!config.enabled) return { accepted: false, reason: 'disabled' };
  const runId = crypto.randomUUID();
  let devices;
  try { devices = targets(config.device_ids, false); }
  catch (error) {
    DB.run('UPDATE anti_idle_state SET enabled=0,running=0,next_run_at=NULL,last_error=?,updated_at=? WHERE id=1', [error.message, now()]);
    labControl.audit('anti_idle.cycle', 'blocked', { trigger, error: error.message }, {});
    return { accepted: false, reason: error.message };
  }
  const runnable = devices.filter(device => device.status === 'online' && device.current_task_id == null);
  DB.run('UPDATE anti_idle_state SET running=1,active_run_id=?,last_run_at=?,last_error=NULL,updated_at=? WHERE id=1', [runId, now(), now()]);
  try {
    const results = await Promise.all(runnable.map(device => runDevice(device, config, runId)));
    const summary = {
      trigger, targeted: devices.length, executed: runnable.length,
      skipped_busy_or_offline: devices.length - runnable.length,
      app_switches: results.reduce((sum, result) => sum + result.app_switches, 0),
      gestures: results.reduce((sum, result) => sum + result.gestures, 0),
      failures: results.reduce((sum, result) => sum + result.failures, 0),
      cancelled: results.filter(result => result.cancelled).length,
    };
    const next = state().enabled ? isoAt(CLOCK() + config.interval_seconds * 1000) : null;
    DB.run('UPDATE anti_idle_state SET running=0,active_run_id=NULL,last_result=?,next_run_at=?,updated_at=? WHERE id=1', [JSON.stringify(summary), next, now()]);
    labControl.audit('anti_idle.cycle', summary.failures ? 'partial' : 'ok', summary, {});
    return { accepted: true, summary, state: state() };
  } catch (error) {
    DB.run('UPDATE anti_idle_state SET enabled=0,running=0,active_run_id=NULL,next_run_at=NULL,last_error=?,updated_at=? WHERE id=1', [error.message, now()]);
    labControl.audit('anti_idle.cycle', 'failed', { trigger, error: error.message }, {});
    return { accepted: false, reason: error.message, state: state() };
  }
}
async function tick() {
  ready();
  if (RUN_PROMISE) return RUN_PROMISE;
  const current = state();
  if (!current.enabled) return { accepted: false, reason: 'disabled' };
  if (labControl.state().halted) {
    DB.run('UPDATE anti_idle_state SET enabled=0,running=0,active_run_id=NULL,next_run_at=NULL,last_error=?,updated_at=? WHERE id=1', ['Lab emergency stop is active', now()]);
    return { accepted: false, reason: 'lab halted' };
  }
  const dueAt = current.next_run_at ? Date.parse(`${current.next_run_at.replace(' ', 'T')}Z`) : CLOCK();
  if (Number.isFinite(dueAt) && dueAt > CLOCK()) return { accepted: false, reason: 'not_due', next_run_at: current.next_run_at };
  RUN_PROMISE = cycle('scheduled').finally(() => { RUN_PROMISE = null; });
  return RUN_PROMISE;
}
function runNow(input = {}) {
  ready();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  if (!state().enabled) throw new Error('Active anti-idle antes de usar run-now');
  if (RUN_PROMISE || state().running) return { accepted: false, reason: 'already_running', state: state() };
  if (replay(input)) return { accepted: true, idempotent_replay: true, state: state() };
  DB.run('UPDATE anti_idle_state SET next_run_at=?,updated_at=? WHERE id=1', [isoAt(CLOCK()), now()]);
  labControl.audit('anti_idle.run_now', 'accepted', {}, input);
  setImmediate(() => tick().catch(error => console.error('[anti-idle]', error.message)));
  return { accepted: true, state: state() };
}
function shutdown() {
  if (!DB) return;
  try {
    DB.run('UPDATE anti_idle_state SET enabled=0,running=0,active_run_id=NULL,next_run_at=NULL,last_error=?,updated_at=? WHERE id=1', ['Application stopped; explicit start required', now()]);
  } catch (_) {}
  RUN_PROMISE = null;
}

module.exports = { DEFAULT_PACKAGES, init, state, configure, start, stop, runNow, tick, shutdown, _cycle: cycle };
