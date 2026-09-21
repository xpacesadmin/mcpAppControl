'use strict';

const ANIMATION_SCALES = new Set([0, 0.5, 1]);
const TIMEZONE_PATTERN = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-.]+)+$/;
const PROXY_DISABLED_VALUES = new Set(['', ':0', 'null']);

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
  if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  throw new Error(`Valor booleano inválido: ${value}`);
}

function normalizeStabilizeParams(params = {}) {
  const screenTimeoutMinutes = Number(params.screen_timeout_minutes ?? 30);
  if (!Number.isInteger(screenTimeoutMinutes) || screenTimeoutMinutes < 1 || screenTimeoutMinutes > 120) {
    throw new Error('screen_timeout_minutes debe ser un entero entre 1 y 120');
  }

  const animationScale = Number(params.animation_scale ?? 0);
  if (!ANIMATION_SCALES.has(animationScale)) {
    throw new Error('animation_scale solo admite 0, 0.5 o 1');
  }

  const syncTime = toBoolean(params.sync_time, true);
  const clockSource = String(params.clock_source || 'host').trim().toLowerCase();
  if (!['host', 'automatic'].includes(clockSource)) {
    throw new Error('clock_source solo admite host o automatic');
  }

  const detectedTimezone = process.env.MCP_DEFAULT_TIMEZONE
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || 'UTC';
  const timezone = String(params.timezone || (syncTime && clockSource === 'host' ? detectedTimezone : '')).trim();
  if (timezone && !TIMEZONE_PATTERN.test(timezone)) {
    throw new Error('Zona horaria inválida; usa un identificador como America/Chicago');
  }

  const maxClockDriftSeconds = Number(params.max_clock_drift_seconds ?? 10);
  if (!Number.isInteger(maxClockDriftSeconds) || maxClockDriftSeconds < 1 || maxClockDriftSeconds > 60) {
    throw new Error('max_clock_drift_seconds debe ser un entero entre 1 y 60');
  }

  return {
    keepAwake: toBoolean(params.keep_awake, true),
    screenTimeoutMinutes,
    screenTimeoutMs: screenTimeoutMinutes * 60 * 1000,
    animationScale,
    syncTime,
    clockSource,
    timezone,
    maxClockDriftSeconds,
  };
}

function normalizeProxyParams(params = {}) {
  const host = String(params.host ?? params.proxy_host ?? '').trim();
  const port = Number(params.port ?? params.proxy_port);
  if (!host || /[\s/?#@]/.test(host)) throw new Error('Host de proxy inválido');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Puerto de proxy inválido');
  return { host, port, value: `${host}:${port}` };
}

async function runOperation(serial, shell, operation) {
  try {
    const output = await shell(serial, operation.args);
    return { key: operation.key, success: true, output: String(output ?? '').trim() };
  } catch (error) {
    return { key: operation.key, success: false, error: error.message };
  }
}

async function readSetting(serial, shell, namespace, key) {
  try {
    return String(await shell(serial, ['settings', 'get', namespace, key])).trim();
  } catch {
    return null;
  }
}

async function readDeviceState(serial, shell) {
  const [proxy, timezone, date, epochSeconds, route, stayAwake, screenTimeout, windowScale, transitionScale, animatorScale] = await Promise.all([
    readSetting(serial, shell, 'global', 'http_proxy'),
    shell(serial, ['getprop', 'persist.sys.timezone']).then(String).then(value => value.trim()).catch(() => null),
    shell(serial, ['date']).then(String).then(value => value.trim()).catch(() => null),
    shell(serial, ['date', '+%s']).then(String).then(value => Number(value.trim())).catch(() => null),
    shell(serial, ['ip', 'route']).then(String).then(value => value.trim()).catch(() => null),
    readSetting(serial, shell, 'global', 'stay_on_while_plugged_in'),
    readSetting(serial, shell, 'system', 'screen_off_timeout'),
    readSetting(serial, shell, 'global', 'window_animation_scale'),
    readSetting(serial, shell, 'global', 'transition_animation_scale'),
    readSetting(serial, shell, 'global', 'animator_duration_scale'),
  ]);

  const localIpMatch = route && route.match(/\bsrc\s+(\d+\.\d+\.\d+\.\d+)/);
  return {
    proxy: PROXY_DISABLED_VALUES.has(proxy ?? '') ? null : proxy,
    timezone,
    date,
    epoch_seconds: Number.isFinite(epochSeconds) ? epochSeconds : null,
    route,
    local_ip: localIpMatch ? localIpMatch[1] : null,
    stay_on_while_plugged_in: stayAwake === null ? null : Number(stayAwake),
    screen_off_timeout_ms: screenTimeout === null ? null : Number(screenTimeout),
    animation_scale: {
      window: windowScale === null ? null : Number(windowScale),
      transition: transitionScale === null ? null : Number(transitionScale),
      animator: animatorScale === null ? null : Number(animatorScale),
    },
  };
}

async function stabilizeDevice(serial, params, shell) {
  const options = normalizeStabilizeParams(params);
  const operations = [
    { key: 'wake_screen', args: ['input', 'keyevent', '224'] },
    { key: 'keep_awake', args: ['settings', 'put', 'global', 'stay_on_while_plugged_in', options.keepAwake ? '3' : '0'] },
    { key: 'screen_timeout', args: ['settings', 'put', 'system', 'screen_off_timeout', String(options.screenTimeoutMs)] },
    { key: 'window_animation', args: ['settings', 'put', 'global', 'window_animation_scale', String(options.animationScale)] },
    { key: 'transition_animation', args: ['settings', 'put', 'global', 'transition_animation_scale', String(options.animationScale)] },
    { key: 'animator_animation', args: ['settings', 'put', 'global', 'animator_duration_scale', String(options.animationScale)] },
  ];

  const hostEpochMs = Date.now();
  if (options.syncTime && options.clockSource === 'host') {
    operations.push({ key: 'automatic_time', args: ['settings', 'put', 'global', 'auto_time', '0'] });
    operations.push({ key: 'automatic_timezone', args: ['settings', 'put', 'global', 'auto_time_zone', '0'] });
  } else if (options.syncTime) {
    operations.push({ key: 'automatic_time', args: ['settings', 'put', 'global', 'auto_time', '1'] });
    operations.push({
      key: 'automatic_timezone',
      args: ['settings', 'put', 'global', 'auto_time_zone', options.timezone ? '0' : '1'],
    });
  }
  if (options.timezone) {
    operations.push({ key: 'timezone', args: ['cmd', 'alarm', 'set-timezone', options.timezone] });
  }
  if (options.syncTime && options.clockSource === 'host') {
    operations.push({ key: 'host_clock', args: ['cmd', 'alarm', 'set-time', String(hostEpochMs)] });
  }

  const operationsResult = [];
  for (const operation of operations) {
    operationsResult.push(await runOperation(serial, shell, operation));
  }

  const state = await readDeviceState(serial, shell);
  const observedAtSeconds = Math.floor(Date.now() / 1000);
  const clockDriftSeconds = state.epoch_seconds === null ? null : Math.abs(observedAtSeconds - state.epoch_seconds);
  const checks = {
    keep_awake: state.stay_on_while_plugged_in === (options.keepAwake ? 3 : 0),
    screen_timeout: state.screen_off_timeout_ms === options.screenTimeoutMs,
    animations: Object.values(state.animation_scale).every(value => value === options.animationScale),
    timezone: !options.timezone || state.timezone === options.timezone,
    clock: !options.syncTime || (clockDriftSeconds !== null && clockDriftSeconds <= options.maxClockDriftSeconds),
  };
  // Some Samsung/Android builds apply `cmd alarm set-time` (and occasionally
  // `set-timezone`) but still return adb exit 255. The read-back below is
  // authoritative for those two commands: preserve the raw adb failure for
  // diagnostics while allowing a verified postcondition to count as success.
  const operationChecks = {
    host_clock: 'clock',
    timezone: 'timezone',
  };
  const reconciledOperations = operationsResult.map(result => {
    const checkKey = operationChecks[result.key];
    const verifiedByReadback = !result.success && checkKey && checks[checkKey] === true;
    return verifiedByReadback
      ? { ...result, effective_success: true, verified_by_readback: true }
      : { ...result, effective_success: result.success };
  });
  const failedOperations = reconciledOperations.filter(result => !result.effective_success);
  const recoveredOperations = reconciledOperations.filter(result => result.verified_by_readback);
  const failedChecks = Object.entries(checks).filter(([, valid]) => !valid).map(([key]) => key);
  const success = failedOperations.length === 0 && failedChecks.length === 0;

  return {
    success,
    message: success
      ? 'Dispositivo estabilizado y reloj verificado (' + options.clockSource + ', deriva ' + clockDriftSeconds + 's'
        + (recoveredOperations.length ? '; ' + recoveredOperations.length + ' respuesta(s) ADB validada(s) por lectura' : '') + ')'
      : 'Estabilización incompleta: ' + failedOperations.length + ' comandos fallaron; verificaciones: ' + (failedChecks.join(', ') || 'sin fallos'),
    data: {
      requested: options,
      host: { epoch_ms: hostEpochMs, timezone: options.timezone },
      state,
      clock_drift_seconds: clockDriftSeconds,
      checks,
      operations: reconciledOperations,
    },
  };
}

async function setProxy(serial, params, shell) {
  const proxy = normalizeProxyParams(params);
  const operations = [
    { key: 'clear_proxy_username', args: ['settings', 'delete', 'global', 'global_http_proxy_username'] },
    { key: 'clear_proxy_password', args: ['settings', 'delete', 'global', 'global_http_proxy_password'] },
    { key: 'set_proxy', args: ['settings', 'put', 'global', 'http_proxy', proxy.value] },
  ];
  const operationsResult = [];
  for (const operation of operations) {
    operationsResult.push(await runOperation(serial, shell, operation));
  }
  const actual = await readSetting(serial, shell, 'global', 'http_proxy');
  const failedOperations = operationsResult.filter(result => !result.success);
  const success = failedOperations.length === 0 && actual === proxy.value;
  return {
    success,
    message: success ? `Proxy ${proxy.value} aplicado y verificado` : `No se pudo verificar el proxy ${proxy.value}`,
    data: { host: proxy.host, port: proxy.port, expected: proxy.value, actual, operations: operationsResult },
  };
}

async function clearProxy(serial, shell) {
  const keys = [
    'http_proxy',
    'global_http_proxy_host',
    'global_http_proxy_port',
    'global_http_proxy_username',
    'global_http_proxy_password',
  ];
  const operations = [
    { key: 'disable_proxy', args: ['settings', 'put', 'global', 'http_proxy', ':0'] },
    ...keys.map(key => ({ key: `delete_${key}`, args: ['settings', 'delete', 'global', key] })),
  ];
  const operationsResult = [];
  for (const operation of operations) {
    operationsResult.push(await runOperation(serial, shell, operation));
  }
  const actual = await readSetting(serial, shell, 'global', 'http_proxy');
  const failedOperations = operationsResult.filter(result => !result.success);
  const success = failedOperations.length === 0 && PROXY_DISABLED_VALUES.has(actual ?? '');
  return {
    success,
    message: success ? 'Proxy global eliminado; el acceso WAN no se verifica en esta operación' : 'El proxy no pudo eliminarse completamente',
    data: { proxy: PROXY_DISABLED_VALUES.has(actual ?? '') ? null : actual, actual, operations: operationsResult },
  };
}

async function getNetworkStatus(serial, shell) {
  const state = await readDeviceState(serial, shell);
  return {
    success: true,
    message: state.proxy ? `Proxy actual: ${state.proxy}` : 'Conexión directa, sin proxy',
    data: state,
  };
}

module.exports = {
  clearProxy,
  getNetworkStatus,
  normalizeProxyParams,
  normalizeStabilizeParams,
  setProxy,
  stabilizeDevice,
};
