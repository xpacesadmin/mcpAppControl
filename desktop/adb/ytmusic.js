const K = require('./ui-kit');
const mediaSession = require('./media_session');

const PACKAGE = 'com.google.android.apps.youtube.music';
const COMMANDS = new Set([
  'YTMUSIC_CREATE_PLAYLIST',
  'YTMUSIC_CREATE_PLAYLIST_FROM_TRACKS',
  'YTMUSIC_HANDLE_INACTIVITY_PROMPT',
]);

const L = {
  search: ['Search', 'Buscar'],
  more: ['More options', 'More actions', 'Más opciones', 'Más acciones'],
  saveToPlaylist: [
    'Save to playlist', 'Add to playlist', 'Guardar en playlist',
    'Agregar a playlist', 'Guardar en lista de reproducción',
    'Añadir a lista de reproducción',
  ],
  newPlaylist: ['New playlist', 'Nueva playlist', 'Nueva lista de reproducción'],
  create: ['Create', 'Crear'],
  privacy: ['Privacy', 'Privacidad', 'Public', 'Pública', 'Publica', 'Unlisted', 'No listada', 'Private', 'Privada'],
  private: ['Private', 'Privada', 'Privado'],
  unlisted: ['Unlisted', 'No listada', 'No listado'],
  public: ['Public', 'Pública', 'Publica', 'Público', 'Publico'],
  pausedPrompt: [
    'Video paused. Continue watching?', 'Video paused', 'Continue watching?',
    'Video pausado. ¿Quieres seguir mirando?', 'Video pausado',
    '¿Quieres seguir mirando?', '¿Continuar viendo?',
  ],
  continue: ['Yes', 'Continue', 'Continue watching', 'Sí', 'Si', 'Continuar', 'Seguir mirando'],
};

function handles(command) { return COMMANDS.has(command); }

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function nodeText(node) {
  return normalize(`${node && node.text || ''} ${node && node.desc || ''}`);
}

function parseTracks(value) {
  const raw = Array.isArray(value) ? value : [];
  if (!raw.length) throw new Error('Agregue al menos una canción con artista y título');
  if (raw.length > 50) throw new Error('Máximo 50 canciones por playlist');

  const tracks = raw.map((entry, index) => {
    let artist;
    let title;
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      artist = String(entry.artist ?? '').trim();
      title = String(entry.title ?? entry.song ?? entry.music ?? '').trim();
    } else {
      const parts = String(entry ?? '').split(/\s*(?:\||\t|::)\s*/);
      artist = String(parts.shift() || '').trim();
      title = parts.join(' | ').trim();
    }
    if (!artist || !title) throw new Error(`Canción ${index + 1}: artista y título son obligatorios`);
    if (artist.length > 160 || title.length > 200) throw new Error(`Canción ${index + 1}: artista o título demasiado largo`);
    if (!normalize(artist) || !normalize(title)) throw new Error(`Canción ${index + 1}: artista o título inválido`);
    const url = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? String(entry.url ?? '').trim()
      : '';
    if (url) {
      let parsed;
      try { parsed = new URL(url); } catch (_) { throw new Error(`Canción ${index + 1}: URL inválida`); }
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'music.youtube.com') {
        throw new Error(`Canción ${index + 1}: solo se aceptan enlaces HTTPS de music.youtube.com`);
      }
    }
    return { artist, title, ...(url ? { url } : {}) };
  });

  const seen = new Set();
  for (const [index, track] of tracks.entries()) {
    const key = `${normalize(track.artist)}\n${normalize(track.title)}`;
    if (seen.has(key)) throw new Error(`Canción ${index + 1}: la combinación artista/título está duplicada`);
    seen.add(key);
  }
  return tracks;
}

function exactTrackRows(nodes, track) {
  const title = normalize(track.title);
  const artist = normalize(track.artist);
  const bounded = (Array.isArray(nodes) ? nodes : []).filter(node => node && node.bounds);
  const candidates = bounded.filter(node => {
    const text = nodeText(node);
    return text === title || text.startsWith(`${title} `) || text.includes(` ${title} `) || text.endsWith(` ${title}`);
  });
  const matches = [];
  for (const titleNode of candidates) {
    const rowRadius = Math.max(120, Math.round((titleNode.bounds.y2 - titleNode.bounds.y1) * 3));
    const rowNodes = bounded.filter(node => Math.abs(node.cy - titleNode.cy) <= rowRadius);
    const rowText = normalize(rowNodes.map(node => `${node.text || ''} ${node.desc || ''}`).join(' '));
    if (rowText.includes(artist)) matches.push({ titleNode, rowNodes, rowText });
  }
  const unique = [];
  for (const match of matches) {
    if (!unique.some(item => Math.abs(item.titleNode.cy - match.titleNode.cy) < 40)) unique.push(match);
  }
  return unique;
}

function foregroundPackage(output) {
  const text = String(output || '');
  const match = text.match(/(?:mCurrentFocus|mFocusedApp|topResumedActivity|mResumedActivity)[^\n]*?\s([A-Za-z0-9._]+)\/[A-Za-z0-9.$_]+/);
  return match ? match[1] : null;
}

async function clearAndType(ctx, serial, ui, value, { submit = true } = {}) {
  await ctx.shell(serial, ['am', 'broadcast', '-a', 'ADB_CLEAR_TEXT']).catch(() => {});
  await ctx.sleep(350);
  await ui.type(value);
  await ctx.sleep(350);
  if (submit) await ui.enter();
}

async function openSearch(ctx, serial, ui, track) {
  await ui.openApp(PACKAGE);
  await ctx.sleep(1000);
  if (!await ui.tapAny(L.search)) throw new Error('No se encontró Buscar en YT Music');
  await ctx.sleep(900);
  const nodes = await ui.dump();
  const edit = nodes.find(node => node.bounds && /EditText/i.test(node.clase));
  if (edit) {
    await ui.tapXY(edit.cx, edit.cy);
    await ctx.sleep(250);
  } else if (!await ui.tapAny(L.search, { ns: nodes })) {
    throw new Error('No se encontró el campo de búsqueda de YT Music');
  }
  await clearAndType(ctx, serial, ui, `${track.title} ${track.artist}`);
  await ctx.sleep(2500);
}

async function openExactTrackMenu(ctx, serial, ui, track) {
  if (track.url) {
    await ctx.shell(serial, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', track.url, '-p', PACKAGE]);
    await ctx.sleep(2500);
    const nodes = await ui.dump();
    const visible = normalize(nodes.map(node => `${node.text || ''} ${node.desc || ''}`).join(' '));
    if (!visible.includes(normalize(track.title)) || !visible.includes(normalize(track.artist))) {
      throw new Error(`El enlace no mostró la canción exacta: "${track.title}" — ${track.artist}`);
    }
    if (!await ui.tapAny(L.more, { ns: nodes })) throw new Error(`No se encontró el menú de "${track.title}"`);
    await ctx.sleep(900);
    return;
  }
  await openSearch(ctx, serial, ui, track);
  const nodes = await ui.dump();
  const matches = exactTrackRows(nodes, track);
  if (!matches.length) throw new Error(`Sin coincidencia exacta: "${track.title}" — ${track.artist}`);
  if (matches.length > 1) throw new Error(`Coincidencia ambigua: "${track.title}" — ${track.artist}`);

  const row = matches[0];
  const menu = row.rowNodes.find(node => ui.matches(node, L.more));
  if (menu) {
    await ui.tapXY(menu.cx, menu.cy);
  } else {
    await ui.tapXY(row.titleNode.cx, row.titleNode.cy);
    await ctx.sleep(1400);
    if (!await ui.tapAny(L.more)) throw new Error(`No se encontró el menú de "${track.title}"`);
  }
  await ctx.sleep(900);
}

async function choosePlaylist(ui, playlistName) {
  for (let page = 0; page < 5; page++) {
    const nodes = await ui.dump();
    const target = normalize(playlistName);
    const matches = nodes.filter(node => node.bounds && nodeText(node) === target);
    if (matches.length === 1) {
      await ui.tapXY(matches[0].cx, matches[0].cy);
      return true;
    }
    if (matches.length > 1) throw new Error(`Más de una playlist se llama "${playlistName}"`);
    if (page < 4) await ui.scrollList();
  }
  return false;
}

async function setPrivacy(ctx, ui, privacy) {
  const labels = { private: L.private, unlisted: L.unlisted, public: L.public }[privacy];
  if (!labels) throw new Error(`Privacidad no soportada: ${privacy}`);
  const nodes = await ui.dump();
  const already = ui.find(nodes, labels);
  if (already) return true;
  const selector = ui.find(nodes, L.privacy);
  if (!selector) throw new Error('No se encontró el selector de privacidad');
  await ui.tapXY(selector.cx, selector.cy);
  await ctx.sleep(600);
  if (!await ui.tapAny(labels)) throw new Error(`No se pudo seleccionar privacidad ${privacy}`);
  return true;
}

async function createPlaylistFromTracks(ctx, serial, p, ui) {
  if (p.confirm !== true) return { success: false, message: 'confirm=true requerido para modificar la biblioteca de YT Music' };
  if (!String(p.idempotency_key || '').trim()) return { success: false, message: 'idempotency_key requerido para crear una playlist' };
  const playlistName = String(p.playlist_name ?? p.name ?? '').trim();
  if (!playlistName || playlistName.length > 100) return { success: false, message: 'Nombre de playlist requerido (máximo 100 caracteres)' };
  const privacy = String(p.privacy || 'private').trim().toLowerCase();
  let tracks;
  try { tracks = parseTracks(p.tracks); }
  catch (error) { return { success: false, message: error.message }; }

  const results = [];
  for (let index = 0; index < tracks.length; index++) {
    const track = tracks[index];
    try {
      await openExactTrackMenu(ctx, serial, ui, track);
      if (!await ui.tapAny(L.saveToPlaylist)) throw new Error('No se encontró Guardar en playlist');
      await ctx.sleep(1000);

      if (index === 0) {
        if (!await ui.tapAny(L.newPlaylist)) {
          throw new Error('No se encontró Nueva playlist; no se creó ninguna lista');
        }
        await ctx.sleep(800);
        const nodes = await ui.dump();
        const edit = nodes.find(node => node.bounds && /EditText/i.test(node.clase));
        if (!edit) throw new Error('No se encontró el campo de nombre de playlist');
        await ui.tapXY(edit.cx, edit.cy);
        await clearAndType(ctx, serial, ui, playlistName, { submit: false });
        await ctx.sleep(350);
        await setPrivacy(ctx, ui, privacy);
        if (!await ui.tapAny(L.create)) throw new Error('No se pudo confirmar la creación de la playlist');
      } else if (!await choosePlaylist(ui, playlistName)) {
        throw new Error(`No se encontró la playlist "${playlistName}"`);
      }
      await ctx.sleep(900);
      results.push({ index: index + 1, artist: track.artist, title: track.title, status: 'added' });
    } catch (error) {
      results.push({ index: index + 1, artist: track.artist, title: track.title, status: 'failed', error: error.message });
      return {
        success: false,
        message: `Playlist detenida en canción ${index + 1}/${tracks.length}: ${error.message}`,
        data: { playlist_name: playlistName, privacy, added: index, total: tracks.length, partial: index > 0, results },
      };
    }
  }

  return {
    success: true,
    message: `Playlist "${playlistName}" guardada con ${tracks.length} canción(es) verificadas`,
    data: { playlist_name: playlistName, privacy, added: tracks.length, total: tracks.length, partial: false, results },
  };
}

async function handleInactivityPrompt(ctx, serial, p, ui) {
  let uiStatus = 'ui_unavailable';
  let promptDetected = false;
  let promptTapped = false;
  try {
    const nodes = await ui.dump();
    if (Array.isArray(nodes) && nodes.length) {
      const visible = normalize(nodes.map(node => `${node.text || ''} ${node.desc || ''}`).join(' '));
      const hasPaused = visible.includes('video paused') || visible.includes('video pausado');
      const hasContinueQuestion = visible.includes('continue watching') || visible.includes('quieres seguir mirando') || visible.includes('continuar viendo');
      promptDetected = hasPaused && hasContinueQuestion;
      uiStatus = promptDetected ? 'prompt_detected' : 'prompt_absent';
      if (promptDetected && p.act !== false) {
        const positiveLabels = new Set(L.continue.map(normalize));
        const positive = nodes.find(node => node.bounds && node.clickable && positiveLabels.has(nodeText(node)));
        if (positive) {
          await ui.tapXY(positive.cx, positive.cy);
          promptTapped = true;
        }
      }
    }
  } catch (_) {}

  const result = await mediaSession.resumeIfPaused(ctx, serial, p);
  const mediaData = result.data || {};
  const promptTapVerifiedPlaying = promptTapped && mediaData.reason === 'already_playing' && mediaData.playback_state === 3;
  const handled = !!mediaData.handled || promptTapVerifiedPlaying;
  const detected = promptDetected || !!mediaData.detected;
  const reason = promptTapVerifiedPlaying
    ? 'prompt_handled'
    : (mediaData.handled || !['already_playing', 'not_paused', 'playback_state_unavailable'].includes(mediaData.reason)
      ? mediaData.reason
      : uiStatus);
  return {
    ...result,
    message: promptTapVerifiedPlaying ? 'Aviso de inactividad confirmado; reproducción verificada' : result.message,
    data: {
      ...mediaData,
      handled,
      detected,
      reason,
      media_reason: mediaData.reason || null,
      ui_status: uiStatus,
      prompt_detected: promptDetected,
      prompt_tapped: promptTapped,
    },
  };
}

async function run(ctx, serial, command, p = {}) {
  const ui = K.makeUi(ctx, serial);
  if (command === 'YTMUSIC_HANDLE_INACTIVITY_PROMPT') return handleInactivityPrompt(ctx, serial, p, ui);

  const min = Number(p.task_interval_min ?? 0);
  const max = Number(p.task_interval_max ?? 0);
  if (max > 0) {
    const waitMinutes = K.randInt(Math.max(0, Math.min(min, max)), Math.max(min, max));
    if (waitMinutes > 0) await ctx.sleep(waitMinutes * 60000);
  }
  const result = await createPlaylistFromTracks(ctx, serial, p, ui);
  if (p.close_app_after && result.success) {
    await ctx.shell(serial, ['am', 'force-stop', PACKAGE]).catch(() => {});
  }
  return result;
}

module.exports = {
  PACKAGE,
  COMMANDS,
  handles,
  run,
  normalize,
  parseTracks,
  exactTrackRows,
  foregroundPackage,
  _createPlaylistFromTracks: createPlaylistFromTracks,
  _handleInactivityPrompt: handleInactivityPrompt,
};
