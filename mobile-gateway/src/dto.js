'use strict';

const ACCOUNT_STATES = new Set(['present', 'missing', 'swapped', 'needs_reauth', 'unreachable', 'unknown', 'unassigned']);
const DEVICE_STATES = new Set(['online', 'busy', 'offline', 'error']);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeLabel(value, fallback = null, maximum = 120) {
  const text = String(value || '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return text ? text.slice(0, maximum) : fallback;
}

function redactMessage(value) {
  return safeLabel(value, null, 300)
    ?.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@') || null;
}

function freshness(sourceTime, options = {}) {
  const nowMs = (options.clock || (() => Date.now()))();
  const maximumAgeSeconds = Number(options.maximumAgeSeconds || 60);
  const normalized = safeTimestamp(sourceTime);
  const sourceMs = normalized ? new Date(normalized).getTime() : NaN;
  const ageSeconds = Number.isFinite(sourceMs) ? Math.max(0, Math.floor((nowMs - sourceMs) / 1000)) : null;
  return {
    as_of: normalized,
    age_seconds: ageSeconds,
    maximum_age_seconds: maximumAgeSeconds,
    state: ageSeconds === null ? 'unknown' : ageSeconds <= maximumAgeSeconds ? 'fresh' : 'stale',
  };
}

function envelope(data, options = {}) {
  return {
    data,
    server_time: new Date((options.clock || (() => Date.now()))()).toISOString(),
    data_freshness: freshness(options.sourceTime || new Date((options.clock || (() => Date.now()))()).toISOString(), options),
  };
}

function routeDto(route) {
  if (!route) return null;
  return {
    route_id: safeLabel(route.route_id),
    assigned_device_id: Number.isInteger(Number(route.assigned_device_id)) ? Number(route.assigned_device_id) : null,
    fleet_vlan: Number.isInteger(Number(route.assigned_fleet_vlan)) ? Number(route.assigned_fleet_vlan) : null,
    health_state: safeLabel(route.health_state, 'unknown', 40),
    observed_public_ip: safeLabel(route.observed_public_ip, null, 64),
    last_verified_at: safeTimestamp(route.last_verification_time),
    updated_at: safeTimestamp(route.updated_at),
  };
}

function accountSummary(rows) {
  const normalized = (Array.isArray(rows) ? rows : []).map(row => {
    const state = ACCOUNT_STATES.has(row.verification_state) ? row.verification_state : 'unknown';
    return { state, last_verified_at: safeTimestamp(row.last_verified_at) };
  });
  const counts = {
    present: 0,
    missing: 0,
    swapped: 0,
    needs_reauth: 0,
    unreachable: 0,
    unknown: 0,
  };
  for (const row of normalized) counts[row.state] = (counts[row.state] || 0) + 1;
  const latest = normalized.map(row => row.last_verified_at).filter(Boolean).sort().at(-1) || null;
  let state = 'unassigned';
  if (normalized.length) {
    state = counts.swapped ? 'swapped'
      : counts.missing ? 'missing'
        : counts.needs_reauth ? 'needs_reauth'
          : counts.unreachable ? 'unreachable'
            : counts.unknown ? 'unknown'
              : 'present';
  }
  return { state, assigned_count: normalized.length, counts, last_verified_at: latest };
}

function accountHealthByDevice(inventory) {
  const grouped = new Map();
  for (const row of Array.isArray(inventory) ? inventory : []) {
    const deviceId = Number(row.device_id);
    if (!Number.isInteger(deviceId) || deviceId <= 0) continue;
    if (!grouped.has(deviceId)) grouped.set(deviceId, []);
    grouped.get(deviceId).push(row);
  }
  const result = new Map();
  for (const [deviceId, rows] of grouped) result.set(deviceId, accountSummary(rows));
  return result;
}

function deviceDto(device, route, accountHealth) {
  const status = DEVICE_STATES.has(device.status) ? device.status : 'error';
  const lastSeen = safeTimestamp(device.last_seen || device.updated_at);
  return {
    id: Number(device.id),
    name: safeLabel(device.name, `Device ${Number(device.id)}`),
    model: safeLabel(device.model, null, 80),
    android_version: safeLabel(device.android_version, null, 40),
    status,
    fleet_vlan: route?.fleet_vlan ?? (Number.isInteger(Number(device.fleet_vlan)) ? Number(device.fleet_vlan) : null),
    route: route || null,
    timezone: safeLabel(device.timezone, null, 80),
    battery: {
      level_percent: finiteNumber(device.battery_level),
      charging: device.charging === null || device.charging === undefined ? null : Boolean(device.charging),
      temperature_c: finiteNumber(device.temperature_c),
      storage_free_mb: finiteNumber(device.storage_free_mb),
      measured_at: safeTimestamp(device.health_at),
    },
    account_health: accountHealth || accountSummary([]),
    current_task: Number.isInteger(Number(device.current_task_id)) ? { id: Number(device.current_task_id) } : null,
    last_seen_at: lastSeen,
    in_command_scope: device.screen_control_allowed === true,
  };
}

function devicesDto(devices, routes, inventory) {
  const routeByDevice = new Map();
  for (const rawRoute of Array.isArray(routes) ? routes : []) {
    const route = routeDto(rawRoute);
    if (route && route.assigned_device_id) routeByDevice.set(route.assigned_device_id, route);
  }
  const accounts = accountHealthByDevice(inventory);
  return (Array.isArray(devices) ? devices : []).map(device => {
    const id = Number(device.id);
    return deviceDto(device, routeByDevice.get(id) || null, accounts.get(id) || accountSummary([]));
  });
}

function fleetSummaryDto({ dashboard, tasks, lab }) {
  const devices = dashboard?.devices || {};
  const taskStats = tasks || dashboard?.tasks || {};
  return {
    fleet: {
      total: finiteNumber(devices.total) || 0,
      online: finiteNumber(devices.online) || 0,
      busy: finiteNumber(devices.busy) || 0,
      offline: finiteNumber(devices.offline) || 0,
      error: finiteNumber(devices.error) || 0,
    },
    tasks: {
      running: finiteNumber(taskStats.running_tasks ?? taskStats.running) || 0,
      scheduled: finiteNumber(taskStats.scheduled_tasks ?? taskStats.scheduled) || 0,
      failed: finiteNumber(taskStats.failed_tasks ?? taskStats.failed) || 0,
      completed: finiteNumber(taskStats.completed_tasks ?? taskStats.completed) || 0,
    },
    lab: {
      halted: lab?.halted === true,
      halt_reason: redactMessage(lab?.halt_reason),
      scope: safeLabel(lab?.lab_scope, 'unknown', 40),
      hermes_enabled: lab?.hermes_enabled === true,
      updated_at: safeTimestamp(lab?.updated_at),
    },
  };
}

function automationDto(antiIdle) {
  return {
    automations: [
      {
        id: 'anti_idle',
        name: 'Anti-idle guard',
        available: true,
        enabled: antiIdle?.enabled === true,
        running: antiIdle?.running === true,
        target_device_ids: Array.isArray(antiIdle?.device_ids) ? antiIdle.device_ids.map(Number).filter(Number.isInteger) : [],
        last_run_at: safeTimestamp(antiIdle?.last_run_at),
        next_run_at: safeTimestamp(antiIdle?.next_run_at),
        last_error: redactMessage(antiIdle?.last_error),
        updated_at: safeTimestamp(antiIdle?.updated_at),
      },
      {
        id: 'youtube_music_guard',
        name: 'YouTube Music guard',
        available: false,
        enabled: false,
        running: false,
        target_device_ids: [],
        last_run_at: null,
        next_run_at: null,
        last_error: null,
        updated_at: null,
      },
    ],
  };
}

function taskDto(task) {
  return {
    id: Number(task.id),
    workflow_name: safeLabel(task.workflow_name, null, 100),
    status: safeLabel(task.status, 'unknown', 40),
    created_at: safeTimestamp(task.created_at),
    started_at: safeTimestamp(task.started_at),
    completed_at: safeTimestamp(task.completed_at),
  };
}

function alertDto(alert) {
  return {
    id: Number(alert.id),
    type: safeLabel(alert.type, 'unknown', 80),
    severity: safeLabel(alert.severity, 'info', 20),
    message: redactMessage(alert.message),
    read: Boolean(alert.read),
    occurred_at: safeTimestamp(alert.sent_at || alert.created_at || alert.updated_at),
  };
}

const SAFE_AUDIT_DETAIL_KEYS = new Set([
  'reason', 'state', 'action', 'count', 'devices', 'device_count', 'assigned_count',
  'present_count', 'missing_count', 'swapped_count', 'needs_reauth_count',
  'lab_mode_enabled', 'halted', 'identifiers_exposed', 'operation_id',
]);

function auditDto(event) {
  let details = event.details;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch (_) { details = {}; }
  }
  const safeDetails = {};
  if (details && typeof details === 'object') {
    for (const [key, value] of Object.entries(details)) {
      if (!SAFE_AUDIT_DETAIL_KEYS.has(key)) continue;
      safeDetails[key] = typeof value === 'string' ? redactMessage(value) : value;
    }
  }
  return {
    id: Number(event.id),
    operation: safeLabel(event.operation, 'unknown', 120),
    actor: safeLabel(event.actor, 'local-operator', 80),
    role: safeLabel(event.role, null, 40),
    device_id: Number.isInteger(Number(event.device_id)) ? Number(event.device_id) : null,
    route_id: safeLabel(event.route_id, null, 80),
    result: safeLabel(event.result, 'unknown', 80),
    details: safeDetails,
    occurred_at: safeTimestamp(event.created_at),
  };
}

module.exports = {
  freshness,
  envelope,
  routeDto,
  accountSummary,
  accountHealthByDevice,
  deviceDto,
  devicesDto,
  fleetSummaryDto,
  automationDto,
  taskDto,
  alertDto,
  auditDto,
  redactMessage,
};
