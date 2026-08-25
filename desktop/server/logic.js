// Lógica de negocio portada de Laravel a Node:
//  - executor  = TaskExecutionService (traduce un paso y lo despacha al router)
//  - dispatcher = WorkflowDispatcher + ExecuteWorkflowTask (ejecuta una rutina)
//  - scheduleRunner = ScheduleRunner (dispara horarios)
const http = require('http');
const crypto = require('crypto');
const { now } = require('./db');
const labControl = require('./lab_control');

let DB = null;
let ROUTER_PORT = 6011;
function init(db, routerPort) { DB = db; ROUTER_PORT = routerPort; labControl.init(db); }

const sleep = ms => new Promise(r => setTimeout(r, Math.min(ms, 120000)));
const uuid = () => crypto.randomUUID();

function taskStopReason(taskId) {
  if (!taskId || !DB) return null;
  const task = DB.get('SELECT status FROM tasks WHERE id=?', [taskId]);
  const control = labControl.state();
  if (control.halted) return control.halt_reason || 'Emergency stop';
  if (!task || ['cancel_requested', 'cancelled'].includes(task.status)) return 'Cancellation requested';
  return null;
}

async function cancellableDelay(taskId, durationMs) {
  let remaining = Math.max(0, Number(durationMs) || 0);
  while (remaining > 0) {
    const reason = taskStopReason(taskId);
    if (reason) return { success: false, cancelled: true, message: reason, data: null };
    const chunk = Math.min(remaining, 500);
    await sleep(chunk);
    remaining -= chunk;
  }
  const reason = taskStopReason(taskId);
  return reason
    ? { success: false, cancelled: true, message: reason, data: null }
    : { success: true, message: 'Wait completed', data: null };
}

function resolveRoutineVars(value, params = {}) {
  if (Array.isArray(value)) return value.map(item => resolveRoutineVars(item, params));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, child] of Object.entries(value)) output[key] = resolveRoutineVars(child, params);
    return output;
  }
  if (typeof value !== 'string') return value;
  const exact = value.match(/^\{\{(?:params\.)?([A-Za-z][A-Za-z0-9_]*)\}\}$/);
  if (exact && Object.prototype.hasOwnProperty.call(params, exact[1])) return params[exact[1]];
  return value.replace(/\{\{(?:params\.)?([A-Za-z][A-Za-z0-9_]*)\}\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

function validateRoutineParams(schema, input = {}) {
  const definitions = Array.isArray(schema) ? schema : [];
  const output = {};
  const errors = [];
  for (const definition of definitions) {
    const name = String(definition && definition.name || '').trim();
    if (!name) continue;
    let value = Object.prototype.hasOwnProperty.call(input || {}, name) ? input[name] : definition.default;
    if ((value === undefined || value === null || value === '') && definition.required) {
      errors.push(`${definition.label || name} is required`);
      continue;
    }
    if (value === undefined) continue;
    if (definition.type === 'number') {
      value = Number(value);
      if (!Number.isFinite(value)) { errors.push(`${definition.label || name} must be numeric`); continue; }
      if (definition.min != null && value < Number(definition.min)) errors.push(`${definition.label || name} must be at least ${definition.min}`);
      if (definition.max != null && value > Number(definition.max)) errors.push(`${definition.label || name} must be at most ${definition.max}`);
    } else if (definition.type === 'boolean') {
      value = value === true || /^(1|true|yes)$/i.test(String(value));
    } else {
      value = String(value);
    }
    output[name] = value;
  }
  return { valid: errors.length === 0, params: output, errors };
}

// ---- POST al Command Router (mismo proceso), devuelve {success,message,data} ----
// Scripts de la suite TikMatrix que son bucles de minutos, no comandos puntuales:
// con el timeout general de 130s el router abortaba un warmup de 10 minutos a la
// tercera parte y lo reportaba como fallo mientras el teléfono seguía trabajando.
const COMANDOS_LARGOS = new RegExp(
  '^(' +
  'TIKTOK_(ACCOUNT_WARMUP|SUPER_MARKETING|BOOST_LIVES|BOOST_POSTS|BOOST_COMMENTS|MASS_DM|MASS_COMMENT|' +
             'SCRAPE_USERS|DELETE_POSTS|PRIVACY_SETTINGS|FOLLOW_SUGGESTED|FOLLOW_BACK|UNFOLLOW_ALL|PUBLISH_POST|LOGIN)' +
  '|' +
  'SPOTIFY_(WARMUP|STREAM_CAMPAIGN|PLAY_URL|SEARCH_PLAY|FOLLOW_ARTIST|LOGIN)' +
  '|' +
  'TWITCH_(WARMUP|WATCH_STREAM|WATCH_CAMPAIGN|FOLLOW_CHANNEL|UNFOLLOW_CHANNEL|CHAT_MESSAGE|LOGIN)' +
  ')$');

function dispatchTimeout(command) {
  if (/^INSTALL/.test(command)) return 660000;
  if (COMANDOS_LARGOS.test(command)) return 6 * 3600 * 1000;   // hasta 6 h
  return 130000;
}

function routerDispatch(serial, command, params) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ serial_number: serial, command, params: params || {} });
    const req = http.request({ host: '127.0.0.1', port: ROUTER_PORT, path: '/command/dispatch', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: dispatchTimeout(command) },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ success: false, message: 'respuesta inválida del router' }); } }); });
    req.on('error', e => resolve({ success: false, message: `router: ${e.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ success: false, message: 'timeout del router' }); });
    req.write(body); req.end();
  });
}

// ---- executor: traduce un paso de rutina y lo ejecuta ----
async function executeStep(device, step, runtime = {}) {
  try {
    const control = labControl.assertOperational();
    if (control.lab_mode_enabled) {
      labControl.assertDeviceAllowed(device.id);
      const validationErrors = labControl.validateStep(step);
      if (validationErrors.length) return { success: false, message: validationErrors.join('; '), data: null };
    }
  } catch (error) {
    return { success: false, message: error.message, data: null };
  }
  const t = step.type;
  // Sustituye {{account.username|password|email|totp|...}} con la cuenta activa del dispositivo.
  try { const accounts = require('./accounts'); step = accounts.resolveVars(device, step); } catch (_) {}
  try {
    switch (t) {

      case 'USE_ACCOUNT': {
        // Fija/rota la cuenta activa del dispositivo antes de un login.
        const accounts = require('./accounts');
        if (step.account_id) { const a = accounts.assign(Number(step.account_id), device.id); return { success: !!a, message: a ? `Cuenta ${a.username} activada` : 'Cuenta no encontrada', data: a }; }
        const r = accounts.rotate(device.id, step.platform);
        return { success: r.rotated, message: r.rotated ? `Cuenta activa: ${r.next.username}` : 'Sin cuentas disponibles', data: r };
      }
      case 'ROTATE_ACCOUNT': {
        const accounts = require('./accounts');
        const r = accounts.rotate(device.id, step.platform);
        return { success: r.rotated, message: r.rotated ? `Rotada a ${r.next.username}` : 'Sin cuentas disponibles para rotar', data: r };
      }
      case 'ASSIGN_PROXY':
      case 'ROTATE_PROXY': {
        const proxies = require('./proxies');
        const result = await proxies.assignAndApply(device, {
          proxy_id: step.proxy_id ? Number(step.proxy_id) : undefined,
          strategy: step.strategy || 'round_robin',
          country: step.country || undefined,
          tags: step.tags || undefined,
          exclude_current: t === 'ROTATE_PROXY',
          reason: `workflow:${t.toLowerCase()}`,
        });
        return { success: !!result.success, message: result.message, data: result.data || null };
      }
      case 'CLEAR_PROXY': {
        const proxies = require('./proxies');
        return proxies.clearAndRelease(device, 'workflow');
      }
      case 'CHECK_IP': {
        const proxies = require('./proxies');
        return norm(await proxies.checkIp(device), 'IP de salida comprobada');
      }

      case 'WAIT_FOR_TEXT': {
        // Visión (nativa): espera hasta que aparezca un texto en pantalla o expira.
        const needle = String(step.text ?? '').toLowerCase();
        const timeout = step.timeout_ms ?? (step.timeout ? step.timeout * 1000 : 15000);
        const start = Date.now();
        while (Date.now() - start < timeout) {
          const rr = await routerDispatch(device.serial_number, 'READ_SCREEN_TEXT', {});
          const txt = (rr && rr.data && rr.data.text || '').toLowerCase();
          if (needle && txt.includes(needle)) return { success: true, message: `Texto encontrado: "${step.text}"`, data: null };
          await sleep(700);
        }
        return { success: false, message: `Timeout esperando texto: "${step.text}"`, data: null };
      }
      case 'ASSERT_TEXT': {
        const needle = String(step.text ?? '').toLowerCase();
        const rr = await routerDispatch(device.serial_number, 'READ_SCREEN_TEXT', {});
        const txt = (rr && rr.data && rr.data.text || '').toLowerCase();
        const found = needle && txt.includes(needle);
        return { success: !!found, message: found ? `Texto presente: "${step.text}"` : `Texto ausente: "${step.text}"`, data: { found: !!found } };
      }
      case 'DEVICE_HEALTH': {
        const rr = await routerDispatch(device.serial_number, 'DEVICE_HEALTH', {});
        if (rr && rr.success && rr.data) {
          const h = rr.data;
          DB.run('UPDATE devices SET battery_level=?, temperature_c=?, storage_free_mb=?, charging=?, health_at=?, updated_at=? WHERE id=?',
            [h.battery ?? null, h.temperature_c ?? null, h.storage_free_mb ?? null, h.charging ?? null, now(), now(), device.id]);
        }
        return norm(rr, 'Salud leída');
      }
      case 'WAIT': case 'TYPING_DELAY': {
        const duration = Number(step.duration ?? 1000);
        const waited = await cancellableDelay(runtime.taskId, duration);
        return waited.success ? { ...waited, message: `Espera ${duration}ms` } : waited;
      }
      case 'REPORT_RESULT':
        return { success: true, message: 'Resultado reportado', data: null };

      case 'CHECK_BAN': {
        // Guarda de seguridad: si detecta baneo/captcha/verificación, falla el paso
        // (detiene la rutina) y dispara la alerta desde el monitor.
        const monitor = require('./monitor');
        const hit = await monitor.checkDevice(device, { source: 'routine' });
        if (hit) return { success: false, message: `Detección: ${hit.category} ("${hit.matched}")`, data: hit };
        return { success: true, message: 'Sin señales de baneo/captcha', data: null };
      }

      // Acepta tanto snake_case (constructor de rutinas) como camelCase (frontend antiguo).
      case 'OPEN_APP': { const pkg = step.package_name ?? step.packageName; return norm(await routerDispatch(device.serial_number, 'OPEN_APP', { package_name: pkg }), `App ${pkg} abierta`); }
      case 'CLICK_BY_TEXT': return norm(await routerDispatch(device.serial_number, 'CLICK_BY_TEXT', { text: step.text }), `Click '${step.text}'`);
      case 'CLICK_BY_ID': { const rid = step.resource_id ?? step.resourceId; return norm(await routerDispatch(device.serial_number, 'CLICK_BY_ID', { resource_id: rid }), `Click id '${rid}'`); }
      case 'SET_TEXT': return norm(await routerDispatch(device.serial_number, 'SET_TEXT', { resource_id: step.resource_id ?? step.resourceId, value: step.value }), 'Texto establecido');
      case 'SCROLL': return norm(await routerDispatch(device.serial_number, 'SCROLL', { direction: step.direction ?? 'down' }), `Scroll ${step.direction ?? 'down'}`);
      case 'PRESS_BACK': return norm(await routerDispatch(device.serial_number, 'PRESS_BACK', {}), 'Back');
      case 'PRESS_HOME': return norm(await routerDispatch(device.serial_number, 'PRESS_HOME', {}), 'Home');
      case 'WAIT_FOR_ELEMENT': return norm(await routerDispatch(device.serial_number, 'WAIT_FOR_ELEMENT', { timeout_ms: step.timeout_ms ?? (step.timeout ? step.timeout * 1000 : 30000), text: step.text, resource_id: step.resource_id ?? step.resourceId }), 'Elemento encontrado');
      case 'CAPTURE_SCREEN': return norm(await routerDispatch(device.serial_number, 'CAPTURE_SCREEN', {}), 'Captura');
      case 'PLAY_MEDIA': {
        const ds = Number(step.duration_seconds ?? step.durationSeconds ?? 30);
        const waited = await cancellableDelay(runtime.taskId, ds * 1000);
        return waited.success ? { ...waited, message: `Reproducido ${ds}s` } : waited;
      }
      case 'PAUSE_MEDIA': return norm(await routerDispatch(device.serial_number, 'PAUSE_MEDIA', {}), 'Media pausado');
      case 'GOTO_URL': return norm(await routerDispatch(device.serial_number, 'GOTO_URL', { url: step.url }), `URL ${step.url}`);
      case 'OPEN_WEB_SEARCH': {
        const query = String(step.query || '').trim();
        if (!query) return { success: false, message: 'Search query is required', data: null };
        const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
        return norm(await routerDispatch(device.serial_number, 'GOTO_URL', { url }), `Google search: ${query}`);
      }
      case 'CAPTURE_FOREGROUND_APP': {
        const result = norm(await routerDispatch(device.serial_number, 'GET_FOREGROUND_APP', {}), 'Foreground app captured');
        const pkg = result.data && result.data.package_name;
        if (result.success && pkg) runtime.originalPackage = pkg;
        return result.success && pkg ? { ...result, message: `Original app captured: ${pkg}` } : { success: false, message: 'Could not identify the foreground app', data: result.data };
      }
      case 'RESTORE_FOREGROUND_APP': {
        const pkg = String(runtime.originalPackage || '').trim();
        if (!pkg) return { success: false, message: 'No captured foreground app is available', data: null };
        return norm(await routerDispatch(device.serial_number, 'OPEN_APP', { package_name: pkg }), `Original app restored: ${pkg}`);
      }
      case 'REPEAT_SCROLL': {
        const count = Math.max(1, Math.min(50, Number(step.count) || 1));
        const pauseMs = Math.max(0, Math.min(10000, Number(step.pause_ms) || 800));
        for (let index = 0; index < count; index++) {
          const reason = taskStopReason(runtime.taskId);
          if (reason) return { success: false, cancelled: true, message: reason, data: { completed: index } };
          const result = norm(await routerDispatch(device.serial_number, 'SCROLL', { direction: step.direction || 'down' }), 'Scroll');
          if (!result.success) return { ...result, data: { ...(result.data || {}), completed: index } };
          if (index < count - 1 && pauseMs) {
            const waited = await cancellableDelay(runtime.taskId, pauseMs);
            if (!waited.success) return { ...waited, data: { completed: index + 1 } };
          }
        }
        return { success: true, message: `${count} scrolls completed`, data: { completed: count } };
      }

      default: {
        // Passthrough: utilidades ADB nuevas (INSTALL_APK, REBOOT, TAP_XY, SETTINGS_PUT…)
        const params = { ...step }; delete params.type;
        return norm(await routerDispatch(device.serial_number, t, params), `${t} ejecutado`);
      }
    }
  } catch (e) {
    return { success: false, message: e.message, data: null };
  }
}
function norm(r, okMsg) {
  const ok = !!(r && r.success);
  return {
    success: ok,
    message: ok ? ((r && r.message) || okMsg || 'OK') : (r && r.message) || 'error',
    data: (r && r.data) ?? null,
  };
}

// ---- selección de dispositivos (WorkflowDispatcher) ----
function selectDevices({ groupId = null, deviceIds = null, workflowId = null }) {
  let ids = deviceIds;
  if (ids == null && groupId == null && workflowId != null) {
    const targets = DB.all('SELECT device_id FROM workflow_device_targets WHERE workflow_id=?', [workflowId]).map(r => r.device_id);
    if (targets.length) ids = targets;
  }
  let sql = `SELECT d.* FROM devices d LEFT JOIN device_groups g ON d.assigned_group_id=g.id WHERE d.status='online' AND (g.paused_at IS NULL)`;
  const p = [];
  if (groupId != null) { sql += ' AND d.assigned_group_id=?'; p.push(groupId); }
  if (ids != null) { if (!ids.length) return []; sql += ` AND d.id IN (${ids.map(() => '?').join(',')})`; p.push(...ids); }
  return DB.all(sql, p);
}

// ---- dispatcher: ejecuta una rutina sobre dispositivos ----
async function dispatchWorkflow(workflow, { groupId = null, deviceIds = null, params = {} } = {}) {
  let control;
  try { control = labControl.assertOperational(); }
  catch (error) { return { task: null, devices_assigned: 0, message: error.message }; }
  if (!workflow || workflow.status !== 'active') return { task: null, devices_assigned: 0, message: 'La rutina debe estar activa' };
  const parameterSchema = safeJson(workflow.parameter_schema, []);
  const checkedParams = validateRoutineParams(parameterSchema, params || {});
  if (!checkedParams.valid) return { task: null, devices_assigned: 0, message: checkedParams.errors.join('; ') };
  const resolvedParams = { ...(params || {}), ...checkedParams.params };
  const steps = resolveRoutineVars(safeJson(workflow.steps, []), resolvedParams);
  if (control.lab_mode_enabled) {
    const validation = labControl.validateWorkflowSteps(steps);
    if (!validation.valid) return { task: null, devices_assigned: 0, message: validation.errors.join('; ') };
    if (groupId != null) return { task: null, devices_assigned: 0, message: 'Lab mode requires explicit device_ids instead of group_id' };
    if (!Array.isArray(deviceIds) || !deviceIds.length) {
      return { task: null, devices_assigned: 0, message: 'Lab mode requires explicit device_ids' };
    }
    if (control.lab_scope === 'canary' && deviceIds.length !== 1) {
      return { task: null, devices_assigned: 0, message: 'The canary requires exactly one explicit device_id' };
    }
    if (control.lab_scope === 'allowlist' && deviceIds.length > control.allowlisted_device_count) {
      return { task: null, devices_assigned: 0, message: 'Workflow exceeds the exact lab device allowlist' };
    }
    try { deviceIds.forEach(id => labControl.assertDeviceAllowed(Number(id))); }
    catch (error) {
      return { task: null, devices_assigned: 0, message: error.message };
    }
  }
  const devices = selectDevices({ groupId, deviceIds, workflowId: workflow.id });
  if (!devices.length) return { task: null, devices_assigned: 0, message: 'No hay dispositivos online' };

  const ext = 'task-' + uuid();
  const ins = DB.run('INSERT INTO tasks(external_id,workflow_id,params,status,started_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    [ext, workflow.id, JSON.stringify(labControl.sanitize(resolvedParams)), 'running', now(), now(), now()]);
  const taskId = ins.lastInsertRowid;

  for (const d of devices) {
    DB.run('INSERT INTO task_assignments(task_id,device_id,device_serial,status,created_at,updated_at) VALUES (?,?,?,?,?,?)', [taskId, d.id, d.serial_number, 'assigned', now(), now()]);
    DB.run('UPDATE devices SET status=?, current_task_id=? WHERE id=?', ['busy', taskId, d.id]);
  }

  // ejecución en paralelo entre dispositivos (pasos secuenciales dentro de cada uno)
  runTask(taskId, workflow, steps, devices).catch(e => console.error('[task]', e.message));

  return { task: DB.get('SELECT * FROM tasks WHERE id=?', [taskId]), devices_assigned: devices.length, message: `Rutina lanzada en ${devices.length} dispositivos` };
}

// Ejecuta la secuencia de pasos en UN dispositivo. Los pasos son secuenciales
// (dependen del estado de la pantalla), pero varios dispositivos corren a la vez.
async function runDeviceSteps(taskId, steps, d) {
  DB.run('UPDATE task_assignments SET status=?, started_at=? WHERE task_id=? AND device_id=?', ['running', now(), taskId, d.id]);
  let failed = false, cancelled = false, lastMsg = null;
  let settings = null; try { settings = require('./settings'); } catch (_) {}
  const runtime = { taskId, originalPackage: null };
  for (let i = 0; i < steps.length; i++) {
    const task = DB.get('SELECT status FROM tasks WHERE id=?', [taskId]);
    const control = labControl.state();
    if (!task || ['cancel_requested', 'cancelled'].includes(task.status) || control.halted) {
      cancelled = true;
      lastMsg = control.halted ? (control.halt_reason || 'Emergency stop') : 'Cancellation requested';
      break;
    }
    const step = steps[i];
    let r;
    try { r = await executeStep(d, step, runtime); }
    catch (e) { r = { success: false, message: e.message, data: {} }; }
    DB.run('INSERT INTO execution_logs(task_id,device_serial,command_type,success,message,result_data,timestamp,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [taskId, d.serial_number, step.type, r.success ? 1 : 0, r.message, JSON.stringify(labControl.sanitize(r.data ?? {})), now(), now(), now()]);
    if (!r.success) {
      if (r.cancelled) cancelled = true; else failed = true;
      lastMsg = r.message;
      break;
    }
    if (settings && i < steps.length - 1) { const d2 = settings.interStepDelayMs(); if (d2 > 0) await sleep(d2); }
  }
  const finalStatus = cancelled ? 'cancelled' : (failed ? 'failed' : 'completed');
  DB.run('UPDATE task_assignments SET status=?, error_message=?, completed_at=? WHERE task_id=? AND device_id=?', [finalStatus, lastMsg, now(), taskId, d.id]);
  DB.run('UPDATE devices SET status=?, current_task_id=NULL WHERE id=? AND current_task_id=?', ['online', d.id, taskId]);
  return { device: d, failed, cancelled, lastMsg };
}

// Lanza la rutina en TODOS los dispositivos en paralelo (throughput ~×N en una
// granja). El estado de la tarea agrega el resultado de cada dispositivo.
async function runTask(taskId, workflow, steps, devices) {
  const results = await Promise.all(devices.map(d => runDeviceSteps(taskId, steps, d)));
  const cancellations = results.filter(r => r.cancelled);
  if (cancellations.length) {
    DB.run('UPDATE tasks SET status=?,error_message=?,completed_at=?,updated_at=? WHERE id=?',
      ['cancelled', cancellations[0].lastMsg || 'Cancellation requested', now(), now(), taskId]);
    return;
  }
  const failures = results.filter(r => r.failed);
  if (failures.length) {
    const names = failures.map(f => f.device.serial_number).join(', ');
    DB.run('UPDATE tasks SET status=?, error_message=?, completed_at=? WHERE id=?',
      [failures.length === devices.length ? 'failed' : 'completed', `Fallo en ${failures.length}/${devices.length}: ${names}`, now(), taskId]);
  } else {
    DB.run('UPDATE tasks SET status=?, completed_at=? WHERE id=?', ['completed', now(), taskId]);
  }
}

// ---- scheduleRunner ----
function hm(date) { return date.toTimeString().slice(0, 5); }
function scheduleTick() {
  const control = labControl.state();
  if (control.halted || control.lab_mode_enabled) return;
  const d = new Date();
  const cur = hm(d), dow = d.getDay();
  const list = DB.all("SELECT * FROM schedules WHERE is_active=1");
  for (const s of list) {
    try {
      const wf = DB.get('SELECT * FROM workflows WHERE id=?', [s.workflow_id]);
      if (!wf || wf.status !== 'active') continue;
      const days = safeJson(s.days_of_week, null);
      if (days && !days.includes(dow)) continue;

      let fire = false;
      if (s.mode === 'fixed_times') {
        const times = safeJson(s.times, []);
        const ranThisMin = s.last_run_at && new Date(s.last_run_at).toISOString().slice(0, 16) === d.toISOString().slice(0, 16);
        fire = times.includes(cur) && !ranThisMin;
      } else {
        const start = (s.window_start || '').slice(0, 5), end = (s.window_end || '').slice(0, 5);
        const inWin = start && end && (start <= end ? (cur >= start && cur <= end) : (cur >= start || cur <= end));
        const running = DB.get("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('scheduled','running') AND json_extract(params,'$.schedule_id')=?", [s.id]).c > 0;
        const gapOk = !(s.loop_gap_seconds > 0 && s.last_run_at && (Date.now() - new Date(s.last_run_at).getTime()) < s.loop_gap_seconds * 1000);
        fire = inWin && !running && gapOk;
      }
      if (fire) {
        dispatchWorkflow(wf, { groupId: s.group_id, params: { schedule_id: s.id, schedule_name: s.name } });
        DB.run('UPDATE schedules SET last_run_at=? WHERE id=?', [now(), s.id]);
      }
    } catch (e) { console.error('[schedule]', e.message); }
  }
}

function safeJson(v, def) { if (v == null) return def; if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return def; } }

module.exports = { init, executeStep, dispatchWorkflow, scheduleTick, routerDispatch, safeJson, runDeviceSteps, resolveRoutineVars, validateRoutineParams, validateWorkflowSteps: labControl.validateWorkflowSteps };
