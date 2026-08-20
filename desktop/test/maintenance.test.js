'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const maintenance = require('../adb/maintenance');

function createShell(initial = {}, failKey = '') {
  const settings = new Map(Object.entries(initial));
  const calls = [];
  const shell = async (serial, args) => {
    calls.push({ serial, args });
    if (args.join(' ') === failKey) throw new Error('simulated adb failure');

    if (args[0] === 'settings' && args[1] === 'put') {
      settings.set(`${args[2]}.${args[3]}`, String(args[4]));
      return '';
    }
    if (args[0] === 'settings' && args[1] === 'delete') {
      settings.delete(`${args[2]}.${args[3]}`);
      return 'Deleted 1 rows';
    }
    if (args[0] === 'settings' && args[1] === 'get') {
      return settings.get(`${args[2]}.${args[3]}`) ?? 'null';
    }
    if (args[0] === 'cmd' && args[1] === 'alarm' && args[2] === 'set-timezone') {
      settings.set('device.timezone', args[3]);
      return '';
    }
    if (args[0] === 'cmd' && args[1] === 'alarm' && args[2] === 'set-time') {
      settings.set('device.epoch_seconds', Math.floor(Number(args[3]) / 1000));
      return '';
    }
    if (args[0] === 'getprop' && args[1] === 'persist.sys.timezone') {
      return settings.get('device.timezone') ?? 'America/Santo_Domingo';
    }
    if (args[0] === 'date' && args[1] === '+%s') {
      return String(settings.get('device.epoch_seconds') ?? Math.floor(Date.now() / 1000));
    }
    if (args[0] === 'date') return 'Sat Jul 25 12:00:00 AST 2026';
    if (args[0] === 'ip' && args[1] === 'route') return 'default via 192.168.1.1 dev wlan0 src 192.168.1.50';
    return '';
  };
  return { calls, settings, shell };
}

test('stabilizer validates input and verifies every setting', async () => {
  assert.throws(
    () => maintenance.normalizeStabilizeParams({ screen_timeout_minutes: 0 }),
    /entre 1 y 120/,
  );
  assert.throws(
    () => maintenance.normalizeStabilizeParams({ timezone: 'invalid timezone' }),
    /Zona horaria inválida/,
  );

  const adb = createShell();
  const result = await maintenance.stabilizeDevice('USB-1', {
    keep_awake: true,
    screen_timeout_minutes: 30,
    animation_scale: 0,
    sync_time: true,
    timezone: 'America/Chicago',
  }, adb.shell);

  assert.equal(result.success, true);
  assert.equal(result.data.state.local_ip, '192.168.1.50');
  assert.equal(result.data.state.timezone, 'America/Chicago');
  assert.deepEqual(result.data.checks, {
    keep_awake: true,
    screen_timeout: true,
    animations: true,
    timezone: true,
    clock: true,
  });
  assert.ok(result.data.clock_drift_seconds <= 10);
  assert.ok(adb.calls.some(call => call.args.join(' ') === 'settings put global auto_time 0'));
  assert.ok(adb.calls.some(call => call.args.slice(0, 3).join(' ') === 'cmd alarm set-time'));
});

test('stabilizer reports partial ADB failures instead of false success', async () => {
  const adb = createShell({}, 'settings put global window_animation_scale 0');
  const result = await maintenance.stabilizeDevice('USB-2', {}, adb.shell);

  assert.equal(result.success, false);
  assert.match(result.message, /Estabilización incompleta/);
  assert.equal(result.data.operations.find(item => item.key === 'window_animation').success, false);
  assert.equal(result.data.checks.animations, false);
});

test('proxy operations remove stale credentials and verify final state', async () => {
  const adb = createShell({
    'global.global_http_proxy_username': 'old-user',
    'global.global_http_proxy_password': 'old-password',
  });

  const applied = await maintenance.setProxy('USB-3', { host: '192.168.40.10', port: 3129 }, adb.shell);
  assert.equal(applied.success, true);
  assert.equal(applied.data.actual, '192.168.40.10:3129');
  assert.equal(adb.settings.has('global.global_http_proxy_username'), false);
  assert.equal(adb.settings.has('global.global_http_proxy_password'), false);

  const cleared = await maintenance.clearProxy('USB-3', adb.shell);
  assert.equal(cleared.success, true);
  assert.equal(cleared.data.proxy, null);
  assert.equal(adb.settings.has('global.http_proxy'), false);
});
