const crypto = require('crypto');
const { now } = require('./db');
const labControl = require('./lab_control');

let DB = null;
let DISPATCH = null;
let CLOCK = () => Date.now();
let RUN_PROMISE = null;

function ready() {
  if (!DB || !DISPATCH) throw new Error('Monitor de YT Music no inicializado');
}
function isoAt(ms = CLOCK()) {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}
function safeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}
function replay(input = {}) {
  return input.idempotency_key
    ? DB.get('SELECT id FROM audit_events WHERE idempotency_key=?', [String(input.idempotency_key)])
    : null;
}

function init(db, options = {}) {
  if (DB === db && DISPATCH) return state();
  DB = db;
  DISPATCH = options.dispatch;
  CLOCK = options.clock || (() => Date.now());
  RUN_PROMISE = null;
  ready();
  DB.run(
    `INSERT OR IGNORE INTO youtube_music_guard_state(
      id,enabled,running,device_ids,device_cursor,poll_interval_seconds,
      cooldown_seconds,batch_size,updated_at
    ) VALUES (1,0,0,'[]',0,30,90,5,?)`,
    [now()]
  );
  const previous = DB.get('SELECT enabled,running FROM youtube_music_guard_state WHERE id=1');
  const restartMessage = previous && (previous.enabled || previous.running)
    ? 'Paused after application restart; explicit start required'
    : null;
  DB.run(
    `UPDATE youtube_music_guard_state SET enabled=0,running=0,active_run_id=NULL,
     next_run_at=NULL,last_error=?,updated_at=? WHERE id=1`,
    [restartMessage, now()]
  );
  return state();
}

function publicDeviceState(row) {
  return {
    device_id: Number(row.device_id),
    prompt_latched: !!row.prompt_latched,
    last_detected_at: row.last_detected_at || null,
    last_handled_at: row.last_handled_at || null,
    last_result: safeJson(row.last_result, null),
    last_error: row.last_error || null,
    updated_at: row.updated_at || null,
  };
}
function state() {
  if (!DB) throw new Error('Monitor de YT Music no inicializado');
  const row = DB.get('SELECT * FROM youtube_music_guard_state WHERE id=1');
  if (!row) return null;
  return {
    enabled: !!row.enabled,
    running: !!row.running,
    device_ids: safeJson(row.device_ids, []),
    device_cursor: Number(row.device_cursor || 0),
    poll_interval_seconds: Number(row.poll_interval_seconds),
    cooldown_seconds: Number(row.cooldown_seconds),
    batch_size: Number(row.batch_size),
    last_run_at: row.last_run_at || null,
    next_run_at: row.next_run_at || null,
    last_result: safeJson(row.last_result, null),
    last_error: row.last_error || null,
    updated_at: row.updated_at || null,
    devices: DB.all(
      `SELECT ymgd.*,d.name,d.serial_number,d.status
       FROM youtube_music_guard_devices ymgd
       JOIN devices d ON d.id=ymgd.device_id ORDER BY d.id`
    ).map(row => ({ ...publicDeviceState(row), name: row.name, serial_number: row.serial_number, status: row.status })),
  };
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
    return !route || route.health_state !== 'verified' || !route.expected_public_ip || route.expected_public_ip !== route.observed_public_ip;
  });
  if (unsafe.length) throw new Error(`Rutas no verificadas: ${unsafe.join(', ')}`);
  return devices;
}

function configure(input = {}) {
  ready();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  if (replay(input)) return state();
  const current = state();
  if (current.enabled || current.running) throw new Error('Detenga el monitor antes de configurarlo');
  const devices = targets(input.device_ids);
  const poll = Number(input.poll_interval_seconds ?? 30);
  const cooldown = Number(input.cooldown_seconds ?? 90);
  const batchSize = Number(input.batch_size ?? 5);
  if (!Number.isInteger(poll) || poll < 15 || poll > 300) throw new Error('poll_interval_seconds debe estar entre 15 y 300');
  if (!Number.isInteger(cooldown) || cooldown < 30 || cooldown > 1800) throw new Error('cooldown_seconds debe estar entre 30 y 1800');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10) throw new Error('batch_size debe estar entre 1 y 10');
  const ids = devices.map(device => Number(device.id));
  DB.run(
    `UPDATE youtube_music_guard_state SET device_ids=?,device_cursor=0,poll_interval_seconds=?,
     cooldown_seconds=?,batch_size=?,last_error=NULL,updated_at=? WHERE id=1`,
    [JSON.stringify(ids), poll, cooldown, batchSize, now()]
  );
  const marks = ids.map(() => '?').join(',');
  DB.run(`DELETE FROM youtube_music_guard_devices WHERE device_id NOT IN (${marks})`, ids);
  for (const id of ids) {
    DB.run(
      `INSERT OR IGNORE INTO youtube_music_guard_devices(
        device_id,prompt_latched,last_result,updated_at
      ) VALUES (?,0,'{}',?)`,
      [id, now()]
    );
  }
  labControl.audit('youtube_music.guard.configure', 'ok', {
    device_ids: ids, poll_interval_seconds: poll, cooldown_seconds: cooldown, batch_size: batchSize,
  }, input);
  return state();
}

function start(input = {}) {
  ready();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  if (replay(input)) return state();
  const current = state();
  targets(current.device_ids);
  const first = input.run_immediately === false ? CLOCK() + current.poll_interval_seconds * 1000 : CLOCK();
  DB.run(
    'UPDATE youtube_music_guard_state SET enabled=1,running=0,next_run_at=?,last_error=NULL,updated_at=? WHERE id=1',
    [isoAt(first), now()]
  );
  labControl.audit('youtube_music.guard.start', 'ok', {
    device_ids: current.device_ids, run_immediately: input.run_immediately !== false,
  }, input);
  if (input.run_immediately !== false) {
    setImmediate(() => tick().catch(error => console.error('[youtube-music-guard]', error.message)));
  }
  return state();
}

function stop(input = {}) {
  ready();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  if (replay(input)) return state();
  const reason = String(input.reason || 'operator stop').trim().slice(0, 240);
  DB.run(
    'UPDATE youtube_music_guard_state SET enabled=0,next_run_at=NULL,last_error=?,updated_at=? WHERE id=1',
    [reason, now()]
  );
  labControl.audit('youtube_music.guard.stop', 'ok', { reason }, input);
  return state();
}

function active(runId) {
  const row = DB.get('SELECT enabled,active_run_id FROM youtube_music_guard_state WHERE id=1');
  return !!(row && row.enabled && row.active_run_id === runId && !labControl.state().halted);
}

function cooldownActive(deviceState, cooldownSeconds) {
  if (!deviceState || !deviceState.last_handled_at) return false;
  const timestamp = Date.parse(`${String(deviceState.last_handled_at).replace(' ', 'T')}Z`);
  return Number.isFinite(timestamp) && CLOCK() - timestamp < cooldownSeconds * 1000;
}

function nextPromptLatch(deviceState, data) {
  if (data.prompt_detected) return 1;
  if (data.ui_status === 'prompt_absent' || data.reason === 'prompt_absent') return 0;
  return deviceState && deviceState.prompt_latched ? 1 : 0;
}

async function inspectDevice(device, config, runId) {
  if (!active(runId)) return { device_id: Number(device.id), cancelled: true };
  const deviceState = DB.get('SELECT * FROM youtube_music_guard_devices WHERE device_id=?', [device.id]);
  const detectOnly = cooldownActive(deviceState, config.cooldown_seconds);
  const result = await DISPATCH(device.serial_number, 'YTMUSIC_HANDLE_INACTIVITY_PROMPT', { act: !detectOnly, settle_ms: 1000 });
  const data = result && result.data || {};
  const stamp = isoAt();
  if (!result || !result.success) {
    const message = String(result && result.message || 'Sin respuesta del dispositivo').slice(0, 300);
    DB.run(
      'UPDATE youtube_music_guard_devices SET last_result=?,last_error=?,updated_at=? WHERE device_id=?',
      [JSON.stringify(data), message, stamp, device.id]
    );
    return { device_id: Number(device.id), success: false, handled: false, error: message };
  }
  if (data.handled) {
    const promptLatched = nextPromptLatch(deviceState, data);
    DB.run(
      `UPDATE youtube_music_guard_devices SET prompt_latched=?,last_detected_at=?,last_handled_at=?,
       last_result=?,last_error=NULL,updated_at=? WHERE device_id=?`,
      [promptLatched, stamp, stamp, JSON.stringify(data), stamp, device.id]
    );
    return { device_id: Number(device.id), success: true, handled: true };
  }
  if (data.detected) {
    const promptLatched = nextPromptLatch(deviceState, data);
    DB.run(
      `UPDATE youtube_music_guard_devices SET prompt_latched=?,last_detected_at=?,last_result=?,
       last_error=NULL,updated_at=? WHERE device_id=?`,
      [promptLatched, stamp, JSON.stringify(data), stamp, device.id]
    );
    return { device_id: Number(device.id), success: true, handled: false, detected: true, debounced: true };
  }
  if (data.reason === 'prompt_absent') {
    DB.run(
      `UPDATE youtube_music_guard_devices SET prompt_latched=0,last_result=?,last_error=NULL,
       updated_at=? WHERE device_id=?`,
      [JSON.stringify(data), stamp, device.id]
    );
  } else {
    DB.run(
      'UPDATE youtube_music_guard_devices SET last_result=?,last_error=NULL,updated_at=? WHERE device_id=?',
      [JSON.stringify(data), stamp, device.id]
    );
  }
  return { device_id: Number(device.id), success: true, handled: false, reason: data.reason || 'no_action' };
}

async function cycle(trigger = 'scheduled') {
  const config = state();
  if (!config.enabled) return { accepted: false, reason: 'disabled' };
  const runId = crypto.randomUUID();
  let devices;
  try { devices = targets(config.device_ids, false); }
  catch (error) {
    DB.run(
      'UPDATE youtube_music_guard_state SET enabled=0,running=0,next_run_at=NULL,last_error=?,updated_at=? WHERE id=1',
      [error.message, now()]
    );
    labControl.audit('youtube_music.guard.cycle', 'blocked', { trigger, error: error.message }, {});
    return { accepted: false, reason: error.message };
  }
  const cursor = devices.length ? config.device_cursor % devices.length : 0;
  const selected = [];
  for (let offset = 0; offset < Math.min(config.batch_size, devices.length); offset++) {
    selected.push(devices[(cursor + offset) % devices.length]);
  }
  const runnable = selected.filter(device => device.status === 'online' && device.current_task_id == null);
  DB.run(
    'UPDATE youtube_music_guard_state SET running=1,active_run_id=?,last_run_at=?,last_error=NULL,updated_at=? WHERE id=1',
    [runId, now(), now()]
  );
  try {
    const results = await Promise.all(runnable.map(device => inspectDevice(device, config, runId)));
    const remainsEnabled = state().enabled && !labControl.state().halted;
    const nextCursor = devices.length ? (cursor + selected.length) % devices.length : 0;
    const summary = {
      trigger,
      targeted: selected.length,
      executed: runnable.length,
      skipped_busy_or_offline: selected.length - runnable.length,
      handled: results.filter(item => item.handled).length,
      detected_debounced: results.filter(item => item.detected && !item.handled).length,
      failures: results.filter(item => item.success === false).length,
      cancelled: results.filter(item => item.cancelled).length,
      device_ids: selected.map(device => Number(device.id)),
    };
    const nextAt = remainsEnabled ? isoAt(CLOCK() + config.poll_interval_seconds * 1000) : null;
    DB.run(
      `UPDATE youtube_music_guard_state SET running=0,active_run_id=NULL,last_result=?,next_run_at=?,
       device_cursor=?,updated_at=? WHERE id=1`,
      [JSON.stringify(summary), nextAt, nextCursor, now()]
    );
    if (summary.handled || summary.failures) {
      labControl.audit('youtube_music.guard.cycle', summary.failures ? 'partial' : 'handled', summary, {});
    }
    return { accepted: true, summary, state: state() };
  } catch (error) {
    DB.run(
      `UPDATE youtube_music_guard_state SET enabled=0,running=0,active_run_id=NULL,
       next_run_at=NULL,last_error=?,updated_at=? WHERE id=1`,
      [error.message, now()]
    );
    labControl.audit('youtube_music.guard.cycle', 'failed', { trigger, error: error.message }, {});
    return { accepted: false, reason: error.message, state: state() };
  }
}

async function tick() {
  ready();
  if (RUN_PROMISE) return RUN_PROMISE;
  const current = state();
  if (!current.enabled) return { accepted: false, reason: 'disabled' };
  if (labControl.state().halted) {
    DB.run(
      `UPDATE youtube_music_guard_state SET enabled=0,running=0,active_run_id=NULL,
       next_run_at=NULL,last_error=?,updated_at=? WHERE id=1`,
      ['Lab emergency stop is active', now()]
    );
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
  if (!state().enabled) throw new Error('Active el monitor antes de comprobar ahora');
  if (RUN_PROMISE || state().running) return { accepted: false, reason: 'already_running', state: state() };
  if (replay(input)) return { accepted: true, idempotent_replay: true, state: state() };
  DB.run('UPDATE youtube_music_guard_state SET next_run_at=?,updated_at=? WHERE id=1', [isoAt(CLOCK()), now()]);
  labControl.audit('youtube_music.guard.run_now', 'accepted', {}, input);
  setImmediate(() => tick().catch(error => console.error('[youtube-music-guard]', error.message)));
  return { accepted: true, state: state() };
}

function shutdown() {
  if (!DB) return;
  try {
    DB.run(
      `UPDATE youtube_music_guard_state SET enabled=0,running=0,active_run_id=NULL,
       next_run_at=NULL,last_error=?,updated_at=? WHERE id=1`,
      ['Application stopped; explicit start required', now()]
    );
  } catch (_) {}
  RUN_PROMISE = null;
}

module.exports = { init, state, configure, start, stop, runNow, tick, shutdown, _cycle: cycle };
