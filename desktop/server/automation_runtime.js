const ORIENTATION_SOURCE = 'settings.system';

const PACING_PRESETS = Object.freeze({
  quick: Object.freeze({ step_delay_ms: 650, action_settle_ms: 350 }),
  standard: Object.freeze({ step_delay_ms: 1200, action_settle_ms: 700 }),
  careful: Object.freeze({ step_delay_ms: 2200, action_settle_ms: 1200 }),
});

const PACE_ALIASES = Object.freeze({
  fast: 'quick',
  balanced: 'standard',
  steady: 'standard',
  slow: 'careful',
  deliberate: 'careful',
});

const NO_SETTLE_STEPS = new Set([
  'WAIT',
  'TYPING_DELAY',
  'PLAY_MEDIA',
  'REPORT_RESULT',
]);

function integerInRange(value, fallback, minimum, maximum) {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error('Automation timing values must be numeric');
  return Math.max(minimum, Math.min(maximum, Math.round(numeric)));
}

function booleanValue(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (/^(1|true|yes|on)$/i.test(String(value))) return true;
  if (/^(0|false|no|off)$/i.test(String(value))) return false;
  throw new Error('lock_portrait must be a boolean');
}

function normalizeExecutionOptions(input = {}) {
  const requested = String(input.pace || input.pacing_preset || 'standard').trim().toLowerCase();
  const pace = PACE_ALIASES[requested] || requested;
  const preset = PACING_PRESETS[pace];
  if (!preset) throw new Error(`Unknown automation pace: ${requested}`);
  return {
    pace,
    step_delay_ms: integerInRange(input.step_delay_ms, preset.step_delay_ms, 600, 10000),
    action_settle_ms: integerInRange(input.action_settle_ms, preset.action_settle_ms, 250, 5000),
    lock_portrait: booleanValue(input.lock_portrait, true),
  };
}

function pacingCatalog() {
  return {
    default_pace: 'standard',
    safe_ranges: {
      step_delay_ms: { min: 600, max: 10000 },
      action_settle_ms: { min: 250, max: 5000 },
    },
    presets: Object.entries(PACING_PRESETS).map(([id, timing]) => ({ id, ...timing })),
  };
}

function stepNeedsSettle(type) {
  return !NO_SETTLE_STEPS.has(String(type || '').toUpperCase());
}

async function requireDispatch(dispatch, serial, command, params = {}) {
  const result = await dispatch(serial, command, params);
  if (!result || result.success !== true) {
    throw new Error((result && result.message) || `${command} failed`);
  }
  return result;
}

function settingValue(result, key, allowed) {
  const value = String((result && result.data && result.data.value) ?? '').trim();
  if (!allowed.test(value)) throw new Error(`Could not read ${ORIENTATION_SOURCE}.${key}`);
  return Number(value);
}

function validateOrientationState(value) {
  const auto = Number(value && value.accelerometer_rotation);
  const rotation = Number(value && value.user_rotation);
  if (![0, 1].includes(auto) || ![0, 1, 2, 3].includes(rotation)) {
    throw new Error('Invalid previous orientation state');
  }
  return {
    source: ORIENTATION_SOURCE,
    accelerometer_rotation: auto,
    user_rotation: rotation,
  };
}

async function captureOrientation(dispatch, serial) {
  const automatic = await requireDispatch(dispatch, serial, 'SETTINGS_GET', {
    namespace: 'system', key: 'accelerometer_rotation',
  });
  const fixed = await requireDispatch(dispatch, serial, 'SETTINGS_GET', {
    namespace: 'system', key: 'user_rotation',
  });
  return validateOrientationState({
    accelerometer_rotation: settingValue(automatic, 'accelerometer_rotation', /^[01]$/),
    user_rotation: settingValue(fixed, 'user_rotation', /^[0-3]$/),
  });
}

async function restoreOrientation(dispatch, serial, value) {
  const previous = validateOrientationState(value);
  const errors = [];
  // Restore the remembered fixed angle first, then the auto-rotation preference.
  // Both writes are attempted so a failure cannot skip the more important auto flag.
  try {
    await requireDispatch(dispatch, serial, 'SETTINGS_PUT', {
      namespace: 'system', key: 'user_rotation', value: previous.user_rotation,
    });
  } catch (error) { errors.push(error.message); }
  try {
    await requireDispatch(dispatch, serial, 'SETTINGS_PUT', {
      namespace: 'system', key: 'accelerometer_rotation', value: previous.accelerometer_rotation,
    });
  } catch (error) { errors.push(error.message); }
  if (errors.length) throw new Error(`Could not restore orientation: ${errors.join('; ')}`);
  return previous;
}

async function beginPortraitGuard(dispatch, serial) {
  const previous = await captureOrientation(dispatch, serial);
  try {
    await requireDispatch(dispatch, serial, 'SETTINGS_PUT', {
      namespace: 'system', key: 'accelerometer_rotation', value: 0,
    });
    await requireDispatch(dispatch, serial, 'SETTINGS_PUT', {
      namespace: 'system', key: 'user_rotation', value: 0,
    });
    return previous;
  } catch (error) {
    const rollbackErrors = [];
    try { await restoreOrientation(dispatch, serial, previous); }
    catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
    const suffix = rollbackErrors.length ? `; rollback: ${rollbackErrors.join('; ')}` : '';
    throw new Error(`Could not enforce portrait: ${error.message}${suffix}`);
  }
}

module.exports = {
  ORIENTATION_SOURCE,
  PACING_PRESETS,
  normalizeExecutionOptions,
  pacingCatalog,
  stepNeedsSettle,
  captureOrientation,
  beginPortraitGuard,
  restoreOrientation,
};
