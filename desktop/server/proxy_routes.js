const net = require('net');
const { now } = require('./db');
const labControl = require('./lab_control');

let DB = null;
let VERIFY_DEVICE_EGRESS = null;
let GET_DEVICE_PROXY = null;
let APPLY_DEVICE_PROXY = null;
let RESTORE_DEVICE_PROXY = null;
let PROBE_DEVICE_ROUTE = null;
let REQUEST_PROVIDER_ROTATION = null;

const PROTOCOLS = new Set(['HTTP', 'HTTPS', 'SOCKS5']);
const ROUTE_ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const SECRET_KEY_RE = /(pass(word)?|token|secret|credential|totp|authorization)/i;
const DISABLED_PROXY_VALUES = new Set(['', ':0', 'null']);

function init(db, options = {}) {
  DB = db;
  VERIFY_DEVICE_EGRESS = options.verifyDeviceEgress || null;
  GET_DEVICE_PROXY = options.getDeviceProxy || null;
  APPLY_DEVICE_PROXY = options.applyDeviceProxy || null;
  RESTORE_DEVICE_PROXY = options.restoreDeviceProxy || null;
  PROBE_DEVICE_ROUTE = options.probeDeviceRoute || null;
  REQUEST_PROVIDER_ROTATION = options.requestProviderRotation || null;
}

function requireDb() {
  if (!DB) throw new Error('proxy_routes no inicializado');
}

function rejectSecrets(input) {
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key) && child != null && child !== '') throw new Error(`Campo secreto prohibido: ${key}`);
      if (child && typeof child === 'object') walk(child);
    }
  };
  walk(input);
}

function publicRoute(row) {
  if (!row) return null;
  return {
    route_id: row.route_id,
    provider: row.provider,
    internal_endpoint: { host: row.internal_host, port: row.internal_port, protocol: row.protocol },
    country: row.country,
    region: row.region,
    city: row.city,
    classification: row.classification,
    assigned_device_id: row.assigned_device_id,
    assigned_fleet_vlan: row.assigned_fleet_vlan,
    health_state: row.health_state,
    expected_public_ip: row.expected_public_ip,
    observed_public_ip: row.observed_public_ip,
    last_verification_time: row.last_verification_time,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function list(filters = {}) {
  requireDb();
  let sql = 'SELECT * FROM proxy_routes WHERE 1=1';
  const params = [];
  if (filters.health_state) { sql += ' AND health_state=?'; params.push(filters.health_state); }
  if (filters.assigned_device_id != null) { sql += ' AND assigned_device_id=?'; params.push(Number(filters.assigned_device_id)); }
  sql += ' ORDER BY route_id';
  return DB.all(sql, params).map(publicRoute);
}

function inspect(routeId) {
  requireDb();
  const route = DB.get('SELECT * FROM proxy_routes WHERE route_id=?', [routeId]);
  if (!route) return null;
  const assignment = DB.get('SELECT * FROM proxy_route_assignments WHERE route_id=? AND active=1', [routeId]);
  return { ...publicRoute(route), assignment: assignment || null };
}

function enroll(input = {}) {
  requireDb();
  labControl.assertOperational();
  rejectSecrets(input);
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  const routeId = String(input.route_id || '').trim().toLowerCase();
  const provider = String(input.provider || '').trim();
  const host = String(input.internal_host || '').trim();
  const port = Number(input.internal_port);
  const protocol = String(input.protocol || '').trim().toUpperCase();
  const classification = String(input.classification || 'dedicated_static');
  if (!ROUTE_ID_RE.test(routeId)) throw new Error('route_id inválido');
  if (!provider || !host) throw new Error('provider e internal_host son requeridos');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('internal_port inválido');
  if (!PROTOCOLS.has(protocol)) throw new Error('protocol debe ser HTTP, HTTPS o SOCKS5');
  if (classification !== 'dedicated_static') throw new Error('Solo dedicated_static está permitido en este laboratorio');
  const vlan = input.assigned_fleet_vlan == null ? null : Number(input.assigned_fleet_vlan);
  if (vlan != null && ![60, 61].includes(vlan)) throw new Error('assigned_fleet_vlan debe ser 60 o 61');
  if (input.idempotency_key) {
    const prior = DB.get('SELECT * FROM audit_events WHERE idempotency_key=?', [input.idempotency_key]);
    if (prior) return inspect(routeId);
  }
  const existing = DB.get('SELECT * FROM proxy_routes WHERE route_id=?', [routeId]);
  if (existing) {
    const same = existing.provider === provider && existing.internal_host === host &&
      Number(existing.internal_port) === port && existing.protocol === protocol &&
      existing.classification === classification;
    if (!same) throw new Error('route_id ya existe con otra definición');
    return inspect(routeId);
  }
  DB.run(
    'INSERT INTO proxy_routes(route_id,provider,internal_host,internal_port,protocol,country,region,city,classification,expected_public_ip,assigned_fleet_vlan,health_state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [routeId, provider, host, port, protocol, input.country || null, input.region || null, input.city || null,
      classification, input.expected_public_ip || null, vlan, 'unverified', now(), now()]
  );
  labControl.audit('proxy_route.enroll', 'ok', { route_id: routeId, provider, internal_host: host, internal_port: port, protocol }, { ...input, route_id: routeId });
  return inspect(routeId);
}

function tcpProbe(host, port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const started = Date.now();
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (reachable, error = null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reachable, latency_ms: Date.now() - started, error });
    };
    socket.setTimeout(Math.min(Math.max(Number(timeoutMs) || 3000, 250), 10000));
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false, 'timeout'));
    socket.on('error', error => finish(false, error.code || error.message));
  });
}

async function testRoute(routeId, input = {}) {
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  requireDb();
  labControl.assertOperational();
  const route = DB.get('SELECT * FROM proxy_routes WHERE route_id=?', [routeId]);
  if (!route) throw new Error('Ruta no encontrada');

  let probe;
  if (input.device_id != null) {
    const deviceId = Number(input.device_id);
    labControl.assertDeviceAllowed(deviceId);
    const device = DB.get('SELECT * FROM devices WHERE id=?', [deviceId]);
    if (!device) throw new Error('Dispositivo no encontrado');
    if (!PROBE_DEVICE_ROUTE) throw new Error('Sonda de ruta desde dispositivo no configurada');
    const started = Date.now();
    const result = await PROBE_DEVICE_ROUTE(device, route, input.timeout_ms);
    probe = {
      reachable: !!(result && result.success),
      latency_ms: Date.now() - started,
      error: result && result.success ? null : (result && result.message) || 'device probe failed',
      observed_public_ip: result && result.data ? result.data.external_ip || null : null,
      source: 'named_device',
    };
  } else {
    probe = { ...(await tcpProbe(route.internal_host, route.internal_port, input.timeout_ms)), source: 'desktop' };
  }

  const health = probe.reachable ? 'listener_reachable' : 'listener_unreachable';
  DB.run('UPDATE proxy_routes SET health_state=?,updated_at=? WHERE route_id=?', [health, now(), routeId]);
  labControl.audit('proxy_route.test', probe.reachable ? 'ok' : 'failed', probe, { ...input, route_id: routeId });
  return {
    route: inspect(routeId),
    probe,
    note: input.device_id != null
      ? 'La sonda usa el dispositivo canario nombrado y el listener interno.'
      : 'La sonda de escritorio solo valida conectividad TCP al listener interno.',
  };
}

function activeAssignmentForDevice(deviceId) {
  return DB.get('SELECT * FROM proxy_route_assignments WHERE device_id=? AND active=1', [deviceId]);
}

function parseProxyState(value) {
  const normalized = String(value == null ? '' : value).trim();
  if (DISABLED_PROXY_VALUES.has(normalized)) {
    return { proxy_enabled: false, proxy_host: null, proxy_port: null, observed_proxy: null };
  }
  const match = /^(.+):(\d+)$/.exec(normalized);
  if (!match) throw new Error(`Estado de proxy Android inválido: ${normalized}`);
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Puerto de proxy Android inválido');
  return { proxy_enabled: true, proxy_host: match[1], proxy_port: port, observed_proxy: normalized };
}

async function getActualProxyState(device) {
  if (!GET_DEVICE_PROXY) throw new Error('Lector de proxy Android no configurado');
  const result = await GET_DEVICE_PROXY(device);
  if (!result || !result.success) throw new Error((result && result.message) || 'No se pudo leer el proxy Android');
  const value = result.data && Object.prototype.hasOwnProperty.call(result.data, 'proxy') ? result.data.proxy : null;
  return parseProxyState(value);
}

async function applyRouteToDevice(device, route) {
  if (!APPLY_DEVICE_PROXY) throw new Error('Aplicador de proxy Android no configurado');
  const result = await APPLY_DEVICE_PROXY(device, route);
  if (!result || !result.success) throw new Error((result && result.message) || 'No se pudo aplicar el proxy Android');
  const actual = result.data && (result.data.actual || result.data.proxy || result.data.expected);
  const expected = `${route.internal_host}:${route.internal_port}`;
  if (actual && String(actual) !== expected) throw new Error(`El dispositivo retuvo ${actual}; se esperaba ${expected}`);
  return result;
}

async function restoreDeviceProxy(device, previousState) {
  if (!RESTORE_DEVICE_PROXY) throw new Error('Restaurador de proxy Android no configurado');
  const result = await RESTORE_DEVICE_PROXY(device, previousState);
  if (!result || !result.success) throw new Error((result && result.message) || 'No se pudo restaurar el proxy Android');
  return result;
}

function updateDeviceProxyState(deviceId, state) {
  DB.run(
    'UPDATE devices SET proxy_enabled=?,proxy_host=?,proxy_port=?,updated_at=? WHERE id=?',
    [state.proxy_enabled ? 1 : 0, state.proxy_host || null, state.proxy_port || null, now(), deviceId]
  );
}

async function assign(routeId, input = {}) {
  requireDb();
  rejectSecrets(input);
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  if (!Object.prototype.hasOwnProperty.call(input, 'expected_previous_route_id')) {
    throw new Error('expected_previous_route_id requerido; use null cuando no exista');
  }
  const deviceId = Number(input.device_id);
  if (!Number.isInteger(deviceId) || deviceId <= 0) throw new Error('device_id inválido');
  labControl.assertDeviceAllowed(deviceId);

  if (input.idempotency_key) {
    const prior = DB.get('SELECT * FROM proxy_route_assignments WHERE idempotency_key=?', [input.idempotency_key]);
    if (prior) {
      if (!prior.active || !['applied', 'active'].includes(prior.state)) {
        throw new Error(`Intento idempotente previo no activo: ${prior.state}`);
      }
      return { route: inspect(prior.route_id), assignment: prior, idempotent_replay: true };
    }
  }

  const route = DB.get('SELECT * FROM proxy_routes WHERE route_id=?', [routeId]);
  const device = DB.get('SELECT * FROM devices WHERE id=?', [deviceId]);
  if (!route) throw new Error('Ruta no encontrada');
  if (!device) throw new Error('Dispositivo no encontrado');
  const current = activeAssignmentForDevice(deviceId);
  const expected = input.expected_previous_route_id == null ? null : String(input.expected_previous_route_id);
  const actualRouteId = current ? current.route_id : null;
  if (actualRouteId !== expected) throw new Error(`La ruta previa cambió: esperado=${expected || 'none'}, actual=${actualRouteId || 'none'}`);

  if (current && current.route_id === routeId) {
    const applyResult = await applyRouteToDevice(device, route);
    updateDeviceProxyState(deviceId, { proxy_enabled: true, proxy_host: route.internal_host, proxy_port: route.internal_port });
    return { route: inspect(routeId), assignment: current, apply_result: applyResult, idempotent_replay: true };
  }

  const occupied = DB.get('SELECT * FROM proxy_route_assignments WHERE route_id=? AND active=1', [routeId]);
  if (occupied) throw new Error('Ruta ya asignada a otro dispositivo');

  const previousState = await getActualProxyState(device);
  const inserted = DB.run(
    'INSERT INTO proxy_route_assignments(route_id,device_id,previous_route_id,previous_proxy_state,state,active,idempotency_key,assigned_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [routeId, deviceId, actualRouteId, JSON.stringify(previousState), 'pending_apply', 0, input.idempotency_key || null, now(), now(), now()]
  );

  let applyResult;
  try {
    applyResult = await applyRouteToDevice(device, route);
  } catch (error) {
    let rollbackResult = 'not_attempted';
    try {
      await restoreDeviceProxy(device, previousState);
      updateDeviceProxyState(deviceId, previousState);
      rollbackResult = 'restored';
    } catch (rollbackError) {
      rollbackResult = `failed: ${rollbackError.message}`;
    }
    DB.run("UPDATE proxy_route_assignments SET state='apply_failed',active=0,released_at=?,updated_at=? WHERE id=?", [now(), now(), inserted.lastInsertRowid]);
    labControl.audit('proxy_route.assign', 'failed', { error: error.message, rollback_result: rollbackResult, previous_proxy_state: previousState }, { ...input, route_id: routeId, device_id: deviceId, idempotency_key: input.idempotency_key ? `${input.idempotency_key}:audit` : null });
    throw new Error(`${error.message}; rollback=${rollbackResult}`);
  }

  if (current) {
    DB.run("UPDATE proxy_route_assignments SET active=0,state='superseded',released_at=?,updated_at=? WHERE id=?", [now(), now(), current.id]);
    DB.run('UPDATE proxy_routes SET assigned_device_id=NULL,updated_at=? WHERE route_id=?', [now(), current.route_id]);
  }
  DB.run("UPDATE proxy_route_assignments SET active=1,state='applied',updated_at=? WHERE id=?", [now(), inserted.lastInsertRowid]);
  DB.run('UPDATE proxy_routes SET assigned_device_id=?,updated_at=? WHERE route_id=?', [deviceId, now(), routeId]);
  updateDeviceProxyState(deviceId, { proxy_enabled: true, proxy_host: route.internal_host, proxy_port: route.internal_port });
  labControl.audit('proxy_route.assign', 'applied', { previous_route_id: actualRouteId, previous_proxy_state: previousState, applied_proxy: `${route.internal_host}:${route.internal_port}` }, { ...input, device_id: deviceId, route_id: routeId, idempotency_key: input.idempotency_key ? `${input.idempotency_key}:audit` : null });
  return { route: inspect(routeId), assignment: DB.get('SELECT * FROM proxy_route_assignments WHERE id=?', [inserted.lastInsertRowid]), apply_result: applyResult };
}

async function release(routeId, input = {}) {
  requireDb();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  const deviceId = Number(input.device_id);
  labControl.assertDeviceAllowed(deviceId);
  const restoreMode = String(input.restore_mode || 'previous').toLowerCase();
  if (!['previous', 'direct'].includes(restoreMode)) throw new Error('restore_mode debe ser previous o direct');
  if (input.idempotency_key) {
    const prior = DB.get('SELECT * FROM audit_events WHERE idempotency_key=?', [input.idempotency_key]);
    if (prior) return { released: true, idempotent_replay: true };
  }
  const current = activeAssignmentForDevice(deviceId);
  if (!current || current.route_id !== routeId) throw new Error('La ruta no es la asignación activa esperada');
  const device = DB.get('SELECT * FROM devices WHERE id=?', [deviceId]);
  if (!device) throw new Error('Dispositivo no encontrado');
  const previousState = JSON.parse(current.previous_proxy_state || '{}');
  const targetState = restoreMode === 'direct'
    ? { proxy_enabled: false, proxy_host: null, proxy_port: null, observed_proxy: null }
    : previousState;

  let restoreResult;
  try {
    restoreResult = await restoreDeviceProxy(device, targetState);
  } catch (error) {
    DB.run("UPDATE proxy_route_assignments SET state='rollback_failed',updated_at=? WHERE id=?", [now(), current.id]);
    labControl.audit('proxy_route.release', 'failed', { error: error.message, restore_mode: restoreMode, previous_proxy_state: previousState }, { ...input, route_id: routeId, device_id: deviceId });
    throw error;
  }

  DB.run("UPDATE proxy_route_assignments SET active=0,state='released',released_at=?,updated_at=? WHERE id=?", [now(), now(), current.id]);
  DB.run('UPDATE proxy_routes SET assigned_device_id=NULL,updated_at=? WHERE route_id=?', [now(), routeId]);
  updateDeviceProxyState(deviceId, targetState);
  labControl.audit('proxy_route.release', 'ok', {
    restore_mode: restoreMode, previous_proxy_state: previousState, applied_proxy_state: targetState,
  }, { ...input, route_id: routeId, device_id: deviceId });
  return {
    released: true, route: inspect(routeId), restore_mode: restoreMode,
    previous_proxy_state: previousState, rollback_proxy_state: targetState, restore_result: restoreResult,
  };
}

async function rollbackAssignment(assignment, device, state = 'rotation_rolled_back') {
  const previousState = JSON.parse(assignment.previous_proxy_state || '{}');
  const restoreResult = await restoreDeviceProxy(device, previousState);
  updateDeviceProxyState(device.id, previousState);
  DB.run('UPDATE proxy_route_assignments SET state=?,active=0,released_at=?,updated_at=? WHERE id=?',
    [state, now(), now(), assignment.id]);
  DB.run('UPDATE proxy_routes SET assigned_device_id=NULL,updated_at=? WHERE route_id=?',
    [now(), assignment.route_id]);

  let previousRoute = null;
  if (assignment.previous_route_id) {
    const previousAssignment = DB.get(
      'SELECT * FROM proxy_route_assignments WHERE device_id=? AND route_id=? ORDER BY id DESC LIMIT 1',
      [device.id, assignment.previous_route_id]
    );
    if (previousAssignment) {
      DB.run("UPDATE proxy_route_assignments SET state='active',active=1,released_at=NULL,updated_at=? WHERE id=?",
        [now(), previousAssignment.id]);
      DB.run('UPDATE proxy_routes SET assigned_device_id=?,updated_at=? WHERE route_id=?',
        [device.id, now(), assignment.previous_route_id]);
      previousRoute = inspect(assignment.previous_route_id);
    }
  }
  return { restored: true, result: restoreResult, previous_route: previousRoute };
}

function selectRotationTarget(deviceId, currentRouteId, input = {}) {
  const currentRoute = DB.get('SELECT * FROM proxy_routes WHERE route_id=?', [currentRouteId]);
  if (!currentRoute) throw new Error('La ruta activa no existe en el registro');

  const explicit = input.target_route_id ? String(input.target_route_id).trim().toLowerCase() : null;
  const params = [currentRouteId, deviceId];
  let sql = [
    'SELECT * FROM proxy_routes',
    'WHERE route_id<>?',
    'AND (assigned_device_id IS NULL OR assigned_device_id=?)',
    "AND health_state IN ('verified','listener_reachable')",
    'AND expected_public_ip IS NOT NULL',
  ].join(' ');
  if (currentRoute.assigned_fleet_vlan != null) {
    sql += ' AND (assigned_fleet_vlan IS NULL OR assigned_fleet_vlan=?)';
    params.push(currentRoute.assigned_fleet_vlan);
  }
  if (explicit) {
    sql += ' AND route_id=?';
    params.push(explicit);
  }
  sql += ' ORDER BY route_id';
  const candidates = DB.all(sql, params);
  if (!candidates.length) {
    throw new Error(explicit
      ? 'La ruta objetivo no está disponible, saludable o no coincide con la VLAN'
      : 'No hay una ruta dedicada verificada y libre para rotar');
  }
  if (explicit) return candidates[0];
  return candidates.find(route => route.route_id > currentRouteId) || candidates[0];
}

async function rotate(input = {}) {
  requireDb();
  rejectSecrets(input);
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  const deviceId = Number(input.device_id);
  if (!Number.isInteger(deviceId) || deviceId <= 0) throw new Error('device_id inválido');
  labControl.assertDeviceAllowed(deviceId);
  if (!Object.prototype.hasOwnProperty.call(input, 'expected_previous_route_id')) {
    throw new Error('expected_previous_route_id requerido');
  }

  if (input.idempotency_key) {
    const prior = DB.get('SELECT * FROM audit_events WHERE idempotency_key=?', [input.idempotency_key]);
    if (prior) {
      const replay = activeAssignmentForDevice(deviceId);
      return { rotated: true, idempotent_replay: true, route: replay ? inspect(replay.route_id) : null };
    }
  }

  const current = activeAssignmentForDevice(deviceId);
  if (!current) throw new Error('El dispositivo no tiene una ruta estable activa');
  const expected = input.expected_previous_route_id == null ? null : String(input.expected_previous_route_id);
  if (current.route_id !== expected) {
    throw new Error('La ruta previa cambió: esperado=' + (expected || 'none') + ', actual=' + current.route_id);
  }

  const target = selectRotationTarget(deviceId, current.route_id, input);
  const assignResult = await assign(target.route_id, {
    ...input,
    device_id: deviceId,
    expected_previous_route_id: current.route_id,
    idempotency_key: input.idempotency_key ? input.idempotency_key + ':assign' : null,
  });

  let verification;
  try {
    verification = await verifyDeviceEgress(target.route_id, {
      ...input,
      device_id: deviceId,
      confirm: true,
      idempotency_key: input.idempotency_key ? input.idempotency_key + ':verify' : null,
    });
  } catch (error) {
    const assignment = activeAssignmentForDevice(deviceId);
    const device = DB.get('SELECT * FROM devices WHERE id=?', [deviceId]);
    let rollback = null;
    if (assignment && assignment.route_id === target.route_id && device) {
      try { rollback = await rollbackAssignment(assignment, device, 'rotation_verify_failed'); }
      catch (rollbackError) { rollback = { restored: false, error: rollbackError.message }; }
    }
    labControl.emergencyStop({
      confirm: true,
      reason: 'Proxy rotation verification failed for ' + target.route_id + ': ' + error.message,
      actor: input.actor,
      idempotency_key: input.idempotency_key ? input.idempotency_key + ':halt' : null,
    });
    throw new Error(error.message + '; rollback=' + JSON.stringify(rollback));
  }

  if (!verification.matches) {
    throw new Error('La rotación produjo una IP de salida inesperada; se restauró la ruta anterior y se detuvo el laboratorio');
  }

  labControl.audit('proxy_route.rotate', 'ok', {
    previous_route_id: current.route_id,
    target_route_id: target.route_id,
    observed_public_ip: verification.observed_public_ip,
  }, {
    ...input,
    device_id: deviceId,
    route_id: target.route_id,
  });
  return {
    rotated: true,
    previous_route_id: current.route_id,
    route: inspect(target.route_id),
    assignment: assignResult.assignment,
    verification,
  };
}

async function requestProviderRotation(routeId, input = {}) {
  requireDb();
  rejectSecrets(input);
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  const normalizedRouteId = String(routeId || '').trim().toLowerCase();
  if (!ROUTE_ID_RE.test(normalizedRouteId)) throw new Error('route_id inválido');
  const deviceId = Number(input.device_id);
  if (!Number.isInteger(deviceId) || deviceId <= 0) throw new Error('device_id inválido');
  labControl.assertDeviceAllowed(deviceId);

  if (input.idempotency_key) {
    const prior = DB.get('SELECT * FROM audit_events WHERE idempotency_key=?', [input.idempotency_key]);
    if (prior) return { requested: true, idempotent_replay: true, route: inspect(normalizedRouteId) };
  }

  const route = DB.get('SELECT * FROM proxy_routes WHERE route_id=?', [normalizedRouteId]);
  const assignment = activeAssignmentForDevice(deviceId);
  if (!route) throw new Error('Ruta no encontrada');
  if (!assignment || assignment.route_id !== normalizedRouteId) {
    throw new Error('La ruta no es la asignación activa esperada para el dispositivo');
  }
  if (!REQUEST_PROVIDER_ROTATION) throw new Error('Adaptador de rotación de Proxy Orch no configurado');

  try {
    const result = await REQUEST_PROVIDER_ROTATION({
      route_id: normalizedRouteId,
      device_id: deviceId,
      idempotency_key: input.idempotency_key,
      timeout_ms: input.timeout_ms,
    });
    if (!result || result.accepted !== true) throw new Error('Proxy Orch did not accept the rotation request');
    const safeResult = {
      accepted: !!(result && result.accepted),
      status: result && result.status != null ? Number(result.status) : null,
      request_id: result && result.request_id ? String(result.request_id) : null,
    };
    labControl.audit('proxy_route.request_provider_rotation', 'ok', safeResult, {
      ...input, route_id: normalizedRouteId, device_id: deviceId,
    });
    return { requested: true, route: inspect(normalizedRouteId), proxy_orch: safeResult };
  } catch (error) {
    labControl.audit('proxy_route.request_provider_rotation', 'failed', { error: error.message }, {
      ...input,
      idempotency_key: input.idempotency_key ? input.idempotency_key + ':failed' : null,
      route_id: normalizedRouteId,
      device_id: deviceId,
    });
    throw error;
  }
}
function extractIp(result) {
  const data = result && result.data ? result.data : result;
  return data && (data.external_ip || data.public_ip || data.ip) ? String(data.external_ip || data.public_ip || data.ip).trim() : null;
}

async function verifyDeviceEgress(routeId, input = {}) {
  requireDb();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  const deviceId = Number(input.device_id);
  labControl.assertDeviceAllowed(deviceId);
  const route = DB.get('SELECT * FROM proxy_routes WHERE route_id=?', [routeId]);
  const assignment = activeAssignmentForDevice(deviceId);
  const device = DB.get('SELECT * FROM devices WHERE id=?', [deviceId]);
  if (!route || !device) throw new Error('Ruta o dispositivo no encontrado');
  if (!assignment || assignment.route_id !== routeId) throw new Error('Ruta no asignada al dispositivo');
  if (!route.expected_public_ip) throw new Error('expected_public_ip requerido antes de verificar');
  if (!VERIFY_DEVICE_EGRESS) throw new Error('Verificador de egreso no configurado');
  const result = await VERIFY_DEVICE_EGRESS(device);
  const observed = extractIp(result);
  const matches = !!observed && observed === route.expected_public_ip;
  const health = matches ? 'verified' : 'mismatch';
  DB.run('UPDATE proxy_routes SET health_state=?,observed_public_ip=?,last_verification_time=?,updated_at=? WHERE route_id=?',
    [health, observed, now(), now(), routeId]);
  DB.run('UPDATE proxy_route_assignments SET state=?,updated_at=? WHERE id=?', [matches ? 'active' : 'mismatch', now(), assignment.id]);
  labControl.audit('proxy_route.verify_device_egress', matches ? 'ok' : 'mismatch',
    { expected_public_ip: route.expected_public_ip, observed_public_ip: observed, verifier_success: !!(result && result.success) },
    { ...input, route_id: routeId, device_id: deviceId });

  let rollback = null;
  if (!matches) {
    try {
      rollback = await rollbackAssignment(assignment, device, 'mismatch_rolled_back');
    } catch (error) {
      DB.run("UPDATE proxy_route_assignments SET state='mismatch_rollback_failed',updated_at=? WHERE id=?", [now(), assignment.id]);
      rollback = { restored: false, error: error.message };
    }
    labControl.emergencyStop({
      confirm: true,
      reason: `Proxy route mismatch for ${routeId}: expected ${route.expected_public_ip}, observed ${observed || 'none'}`,
      actor: input.actor,
      idempotency_key: input.idempotency_key ? `${input.idempotency_key}:halt` : null,
    });
  }
  return { matches, expected_public_ip: route.expected_public_ip, observed_public_ip: observed, rollback, route: inspect(routeId) };
}

module.exports = { init, list, inspect, enroll, testRoute, assign, release, rotate, requestProviderRotation, verifyDeviceEgress, rejectSecrets, publicRoute, parseProxyState, selectRotationTarget };
