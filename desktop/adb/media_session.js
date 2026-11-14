const ALLOWED_PACKAGES = new Set([
  'com.google.android.apps.youtube.music',
  'com.google.android.youtube',
  'com.spotify.music',
]);

const COMMANDS = new Set(['MEDIA_RESUME_IF_PAUSED']);

function handles(command) {
  return COMMANDS.has(command);
}

function foregroundPackage(output) {
  const text = String(output || '');
  const match = text.match(/(?:topResumedActivity|mResumedActivity|mCurrentFocus|mFocusedApp)[^\r\n]*?\s([A-Za-z0-9._]+)\/[A-Za-z0-9.$_]+/);
  return match ? match[1] : null;
}

function parseMediaSessionDump(output) {
  const text = String(output || '');
  const lines = text.split(/\r?\n/);
  const buttonLine = lines.find(line => /Media button session is/i.test(line));
  const ownerMatch = buttonLine && buttonLine.match(/\b([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)(?=\/|\s|\)|$)/);
  const ownerPackage = ownerMatch ? ownerMatch[1] : null;
  if (!ownerPackage) return { ownerPackage: null, playbackState: null };

  const escapedOwner = ownerPackage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ownerDeclaration = new RegExp(`(?:package|packageName|ownerPackageName)\\s*=\\s*${escapedOwner}\\b`, 'i');
  const statePattern = /PlaybackState\s*\{\s*state=(\d+)\b/i;
  for (let index = 0; index < lines.length; index++) {
    if (!ownerDeclaration.test(lines[index])) continue;
    for (let cursor = index; cursor < Math.min(lines.length, index + 80); cursor++) {
      if (cursor > index && /(?:package|packageName|ownerPackageName)\s*=\s*[A-Za-z]/i.test(lines[cursor])) break;
      const stateMatch = lines[cursor].match(statePattern);
      if (stateMatch) return { ownerPackage, playbackState: Number(stateMatch[1]) };
    }
  }

  const states = [...text.matchAll(/PlaybackState\s*\{\s*state=(\d+)\b/gi)];
  return { ownerPackage, playbackState: states.length === 1 ? Number(states[0][1]) : null };
}

async function readForeground(ctx, serial) {
  const activities = await ctx.shell(serial, ['dumpsys', 'activity', 'activities']).catch(() => '');
  let packageName = foregroundPackage(activities);
  if (!packageName) {
    const windows = await ctx.shell(serial, ['dumpsys', 'window', 'windows']).catch(() => '');
    packageName = foregroundPackage(windows);
  }
  return packageName;
}

async function readSession(ctx, serial) {
  const output = await ctx.shell(serial, ['dumpsys', 'media_session']).catch(() => '');
  return parseMediaSessionDump(output);
}

function safeData(reason, foregroundPackageName, session = {}, extra = {}) {
  return {
    handled: false,
    reason,
    foreground_package: foregroundPackageName || null,
    session_owner_package: session.ownerPackage || null,
    playback_state: session.playbackState ?? null,
    ...extra,
  };
}

async function resumeIfPaused(ctx, serial, params = {}) {
  const target = String(params.target_package || '').trim();
  if (target && !ALLOWED_PACKAGES.has(target)) {
    return { success: false, message: 'Aplicación multimedia no permitida', data: safeData('invalid_target', null) };
  }
  const foreground = await readForeground(ctx, serial);
  if (!foreground) return { success: true, message: 'No se pudo verificar la app visible; sin cambios', data: safeData('foreground_unavailable', null) };
  if (target && foreground !== target) return { success: true, message: 'La app solicitada no está visible; sin cambios', data: safeData('target_not_foreground', foreground) };
  if (!ALLOWED_PACKAGES.has(foreground)) return { success: true, message: 'La app visible no permite reanudación automática; sin cambios', data: safeData('foreground_not_allowlisted', foreground) };

  const before = await readSession(ctx, serial);
  if (!before.ownerPackage) return { success: true, message: 'No hay una sesión multimedia activa verificable; sin cambios', data: safeData('session_unavailable', foreground, before) };
  if (!ALLOWED_PACKAGES.has(before.ownerPackage)) return { success: true, message: 'La sesión multimedia activa no está permitida; sin cambios', data: safeData('session_not_allowlisted', foreground, before) };
  if (before.ownerPackage !== foreground) return { success: true, message: 'La sesión multimedia no pertenece a la app visible; sin cambios', data: safeData('session_owner_mismatch', foreground, before) };
  if (before.playbackState !== 2) {
    const reason = before.playbackState === 3 ? 'already_playing' : (before.playbackState == null ? 'playback_state_unavailable' : 'not_paused');
    return { success: true, message: 'La reproducción no está pausada; sin cambios', data: safeData(reason, foreground, before) };
  }
  if (params.act === false) return { success: true, message: 'Pausa detectada (solo lectura)', data: safeData('detect_only', foreground, before, { detected: true }) };

  const settleMs = Math.max(100, Math.min(2000, Number(params.settle_ms || 500)));
  const attemptedMethods = ['cmd_media_session_play'];
  await ctx.shell(serial, ['cmd', 'media_session', 'dispatch', 'play']);
  await ctx.sleep(settleMs);
  const foregroundAfterCommand = await readForeground(ctx, serial);
  const afterCommand = await readSession(ctx, serial);
  if (foregroundAfterCommand !== foreground || afterCommand.ownerPackage !== foreground) {
    return {
      success: false,
      message: 'La app visible o la sesión cambió después de Play; sin fallback',
      data: safeData('resume_context_changed', foreground, before, {
        attempted_methods: attemptedMethods,
        verified_foreground_package: foregroundAfterCommand || null,
        verified_playback_state: afterCommand.playbackState ?? null,
        verified_session_owner_package: afterCommand.ownerPackage || null,
      }),
    };
  }
  if (afterCommand.playbackState === 3) {
    return {
      success: true,
      message: 'Reproducción reanudada y verificada',
      data: safeData('resumed', foreground, before, {
        handled: true,
        detected: true,
        method: 'cmd_media_session_play',
        attempted_methods: attemptedMethods,
        verified_playback_state: 3,
      }),
    };
  }
  if (afterCommand.playbackState !== 2) {
    return {
      success: false,
      message: 'Play no dejó la sesión pausada ni reproduciendo; sin fallback',
      data: safeData('resume_not_verified', foreground, before, {
        attempted_methods: attemptedMethods,
        verified_playback_state: afterCommand.playbackState ?? null,
        verified_session_owner_package: afterCommand.ownerPackage || null,
      }),
    };
  }

  attemptedMethods.push('keycode_media_play');
  await ctx.shell(serial, ['input', 'keyevent', '126']);
  await ctx.sleep(settleMs);
  const foregroundAfterFallback = await readForeground(ctx, serial);
  const afterFallback = await readSession(ctx, serial);
  if (foregroundAfterFallback !== foreground || afterFallback.ownerPackage !== foreground || afterFallback.playbackState !== 3) {
    return {
      success: false,
      message: 'KEYCODE_MEDIA_PLAY no pudo verificarse',
      data: safeData('resume_not_verified', foreground, before, {
        attempted_methods: attemptedMethods,
        verified_foreground_package: foregroundAfterFallback || null,
        verified_playback_state: afterFallback.playbackState ?? null,
        verified_session_owner_package: afterFallback.ownerPackage || null,
      }),
    };
  }
  return {
    success: true,
    message: 'Reproducción reanudada y verificada',
    data: safeData('resumed', foreground, before, {
      handled: true,
      detected: true,
      method: 'keycode_media_play',
      attempted_methods: attemptedMethods,
      verified_playback_state: 3,
    }),
  };
}

async function run(ctx, serial, command, params = {}) {
  if (command !== 'MEDIA_RESUME_IF_PAUSED') throw new Error(`Comando multimedia no soportado: ${command}`);
  return resumeIfPaused(ctx, serial, params);
}

module.exports = {
  ALLOWED_PACKAGES,
  COMMANDS,
  handles,
  run,
  foregroundPackage,
  parseMediaSessionDump,
  resumeIfPaused,
};
