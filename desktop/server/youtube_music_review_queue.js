const crypto = require('crypto');
const { now } = require('./db');
const labControl = require('./lab_control');

let DB = null;
let RANDOM = Math.random;

function ready() {
  if (!DB) throw new Error('Cola de revision de YT Music no inicializada');
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

function uniqueDeviceIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(Number))];
}

function validateDevices(deviceIds) {
  const ids = uniqueDeviceIds(deviceIds);
  const control = labControl.state();
  const maximum = control.lab_mode_enabled ? Math.max(1, control.allowlisted_device_count) : 200;
  if (!ids.length || ids.length > maximum || ids.some(id => !Number.isInteger(id) || id <= 0)) {
    throw new Error(`Se requieren entre 1 y ${maximum} device_ids explicitos`);
  }
  labControl.assertOperational();
  ids.forEach(id => labControl.assertDeviceAllowed(id));
  const marks = ids.map(() => '?').join(',');
  const devices = DB.all(
    `SELECT id,name,serial_number,adb_serial,status FROM devices WHERE id IN (${marks}) ORDER BY id`,
    ids,
  );
  if (devices.length !== ids.length) throw new Error('Uno o mas dispositivos no existen');
  return devices;
}

function validateProbability(value, name) {
  const probability = Number(value);
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error(`${name} debe estar entre 0 y 1`);
  }
  return probability;
}

function validateDrafts(values) {
  if (!Array.isArray(values)) throw new Error('comment_drafts debe ser una lista');
  const drafts = [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
  if (drafts.length > 50) throw new Error('Maximo 50 borradores de comentario');
  if (drafts.some(value => value.length > 280)) throw new Error('Cada borrador debe tener 280 caracteres o menos');
  return drafts;
}

function init(db, options = {}) {
  DB = db;
  RANDOM = options.random || Math.random;
  ready();
  DB.run(
    `INSERT OR IGNORE INTO youtube_music_review_state(
      id,device_ids,like_candidate_probability,comment_candidate_probability,
      cooldown_seconds,comment_drafts,updated_at
    ) VALUES (1,'[]',0.15,0.05,1800,'[]',?)`,
    [now()],
  );
  return state();
}

function configRow() {
  ready();
  return DB.get('SELECT * FROM youtube_music_review_state WHERE id=1');
}

function state() {
  const row = configRow();
  const counts = DB.all(
    `SELECT status,COUNT(*) AS count FROM youtube_music_review_candidates
     GROUP BY status ORDER BY status`,
  );
  return {
    device_ids: safeJson(row.device_ids, []),
    like_candidate_probability: Number(row.like_candidate_probability),
    comment_candidate_probability: Number(row.comment_candidate_probability),
    cooldown_seconds: Number(row.cooldown_seconds),
    comment_drafts: safeJson(row.comment_drafts, []),
    updated_at: row.updated_at || null,
    counts: Object.fromEntries(counts.map(item => [item.status, Number(item.count)])),
    safety_mode: 'manual_review_only',
    device_actions_enabled: false,
  };
}

function configure(input = {}) {
  ready();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  if (replay(input)) return state();
  const devices = validateDevices(input.device_ids);
  const likeProbability = validateProbability(input.like_candidate_probability ?? 0.15, 'like_candidate_probability');
  const commentProbability = validateProbability(input.comment_candidate_probability ?? 0.05, 'comment_candidate_probability');
  const cooldown = Number(input.cooldown_seconds ?? 1800);
  if (!Number.isInteger(cooldown) || cooldown < 60 || cooldown > 604800) {
    throw new Error('cooldown_seconds debe estar entre 60 y 604800');
  }
  const drafts = validateDrafts(input.comment_drafts || []);
  if (commentProbability > 0 && !drafts.length) {
    throw new Error('Agregue al menos un borrador cuando comment_candidate_probability sea mayor que 0');
  }
  const ids = devices.map(device => Number(device.id));
  DB.run(
    `UPDATE youtube_music_review_state SET device_ids=?,like_candidate_probability=?,
     comment_candidate_probability=?,cooldown_seconds=?,comment_drafts=?,updated_at=? WHERE id=1`,
    [JSON.stringify(ids), likeProbability, commentProbability, cooldown, JSON.stringify(drafts), now()],
  );
  labControl.audit('youtube_music.review_queue.configure', 'ok', {
    device_ids: ids,
    like_candidate_probability: likeProbability,
    comment_candidate_probability: commentProbability,
    cooldown_seconds: cooldown,
    comment_draft_count: drafts.length,
    safety_mode: 'manual_review_only',
  }, input);
  return state();
}

function normalizeObservation(input = {}) {
  const title = String(input.track_title || '').trim().slice(0, 200);
  const artist = String(input.track_artist || '').trim().slice(0, 200);
  const source = String(input.source || 'operator-observation').trim().slice(0, 80) || 'operator-observation';
  const observedAt = String(input.observed_at || now());
  if (!title && !artist) throw new Error('track_title o track_artist requerido');
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('observed_at invalido');
  return { title, artist, source, observedAt: new Date(observedAt).toISOString() };
}

function cooldownOpen(deviceId, type, seconds) {
  const last = DB.get(
    `SELECT generated_at FROM youtube_music_review_candidates
     WHERE device_id=? AND candidate_type=? ORDER BY id DESC LIMIT 1`,
    [deviceId, type],
  );
  if (!last) return true;
  const timestamp = Date.parse(last.generated_at);
  return !Number.isFinite(timestamp) || Date.now() - timestamp >= seconds * 1000;
}

function insertCandidate(device, type, observation, commentDraft, eventKey) {
  const inserted = DB.run(
    `INSERT INTO youtube_music_review_candidates(
      candidate_uuid,device_id,candidate_type,track_title,track_artist,comment_draft,
      status,source,observation_key,generated_at,updated_at
    ) VALUES (?,?,?,?,?,?,'pending_review',?,?,?,?)`,
    [
      crypto.randomUUID(), Number(device.id), type, observation.title || null,
      observation.artist || null, commentDraft || null, observation.source,
      eventKey || null, now(), now(),
    ],
  );
  return DB.get('SELECT * FROM youtube_music_review_candidates WHERE id=?', [inserted.lastInsertRowid]);
}

function observe(input = {}) {
  ready();
  const eventKey = String(input.observation_key || '').trim();
  if (!eventKey) throw new Error('observation_key requerido para evitar duplicados');
  const deviceId = Number(input.device_id);
  const configured = state();
  if (!configured.device_ids.includes(deviceId)) throw new Error('Dispositivo no configurado para la cola');
  const [device] = validateDevices([deviceId]);
  const existingObservation = DB.get(
    'SELECT device_id,result FROM youtube_music_review_observations WHERE device_id=? AND observation_key=?',
    [deviceId, eventKey],
  );
  if (existingObservation) {
    if (Number(existingObservation.device_id) !== deviceId) throw new Error('La observacion pertenece a otro dispositivo');
    return { idempotent_replay: true, ...safeJson(existingObservation.result, { candidates: [], skipped: [] }) };
  }
  const observation = normalizeObservation(input);
  const generated = [];
  const skipped = [];

  const consider = (type, probability, draft = null) => {
    if (!cooldownOpen(deviceId, type, configured.cooldown_seconds)) {
      skipped.push({ type, reason: 'cooldown' });
      return;
    }
    if (RANDOM() >= probability) {
      skipped.push({ type, reason: 'probability' });
      return;
    }
    generated.push(insertCandidate(device, type, observation, draft, eventKey));
  };

  consider('like', configured.like_candidate_probability);
  const drafts = configured.comment_drafts;
  const draft = drafts.length ? drafts[Math.min(drafts.length - 1, Math.floor(RANDOM() * drafts.length))] : null;
  consider('comment', configured.comment_candidate_probability, draft);

  const result = { candidates: generated.map(publicCandidate), skipped };
  DB.run(
    `INSERT INTO youtube_music_review_observations(
      observation_key,device_id,track_title,track_artist,result,observed_at,created_at
    ) VALUES (?,?,?,?,?,?,?)`,
    [
      eventKey, deviceId, observation.title || null, observation.artist || null,
      JSON.stringify(result), observation.observedAt, now(),
    ],
  );

  labControl.audit('youtube_music.review_queue.observe', generated.length ? 'queued' : 'no_candidate', {
    device_id: deviceId,
    track_title: observation.title,
    track_artist: observation.artist,
    generated_types: generated.map(item => item.candidate_type),
    skipped,
    safety_mode: 'manual_review_only',
  }, { actor: input.actor || 'local-operator' });
  return { idempotent_replay: false, ...result };
}

function publicCandidate(row) {
  return {
    id: Number(row.id),
    candidate_uuid: row.candidate_uuid,
    device_id: Number(row.device_id),
    device_name: row.device_name || null,
    serial_number: row.serial_number || null,
    candidate_type: row.candidate_type,
    track_title: row.track_title || null,
    track_artist: row.track_artist || null,
    comment_draft: row.comment_draft || null,
    status: row.status,
    source: row.source,
    generated_at: row.generated_at,
    reviewed_at: row.reviewed_at || null,
    reviewed_by: row.reviewed_by || null,
    review_note: row.review_note || null,
    manual_action_only: true,
  };
}

function list(input = {}) {
  ready();
  const allowedStatuses = new Set(['pending_review', 'approved_manual', 'dismissed']);
  const status = input.status ? String(input.status) : '';
  if (status && !allowedStatuses.has(status)) throw new Error('status invalido');
  const limit = Math.min(200, Math.max(1, Number(input.limit) || 100));
  const rows = DB.all(
    `SELECT c.*,d.name AS device_name,d.serial_number
     FROM youtube_music_review_candidates c JOIN devices d ON d.id=c.device_id
     ${status ? 'WHERE c.status=?' : ''} ORDER BY c.id DESC LIMIT ?`,
    status ? [status, limit] : [limit],
  );
  return rows.filter(row => labControl.isDeviceInScope(row.device_id)).map(publicCandidate);
}

function findCandidate(id) {
  const row = DB.get(
    `SELECT c.*,d.name AS device_name,d.serial_number
     FROM youtube_music_review_candidates c JOIN devices d ON d.id=c.device_id WHERE c.id=?`,
    [Number(id)],
  );
  if (!row) throw new Error('Candidato no encontrado');
  labControl.assertDeviceAllowed(row.device_id);
  return row;
}

function editDraft(id, input = {}) {
  ready();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  const row = findCandidate(id);
  if (row.candidate_type !== 'comment') throw new Error('Solo los candidatos de comentario tienen borrador');
  if (row.status !== 'pending_review') throw new Error('Solo se puede editar un candidato pendiente');
  const [draft] = validateDrafts([input.comment_draft]);
  if (!draft) throw new Error('comment_draft requerido');
  DB.run('UPDATE youtube_music_review_candidates SET comment_draft=?,updated_at=? WHERE id=?', [draft, now(), row.id]);
  labControl.audit('youtube_music.review_queue.edit_draft', 'ok', {
    candidate_id: Number(row.id), device_id: Number(row.device_id), draft_length: draft.length,
  }, { ...input, device_id: Number(row.device_id) });
  return publicCandidate(findCandidate(row.id));
}

function review(id, decision, input = {}) {
  ready();
  if (input.confirm !== true) throw new Error('confirm=true requerido');
  if (!['approve', 'dismiss'].includes(decision)) throw new Error('decision invalida');
  if (replay(input)) return publicCandidate(findCandidate(id));
  const row = findCandidate(id);
  if (row.status !== 'pending_review') throw new Error('El candidato ya fue revisado');
  const actor = String(input.actor || 'local-operator').trim().slice(0, 80) || 'local-operator';
  const note = String(input.review_note || '').trim().slice(0, 500) || null;
  const status = decision === 'approve' ? 'approved_manual' : 'dismissed';
  DB.run(
    `UPDATE youtube_music_review_candidates SET status=?,reviewed_at=?,reviewed_by=?,
     review_note=?,updated_at=? WHERE id=?`,
    [status, now(), actor, note, now(), row.id],
  );
  labControl.audit(`youtube_music.review_queue.${decision}`, status, {
    candidate_id: Number(row.id),
    device_id: Number(row.device_id),
    candidate_type: row.candidate_type,
    manual_action_only: true,
    device_command_dispatched: false,
  }, { ...input, actor, device_id: Number(row.device_id) });
  return publicCandidate(findCandidate(row.id));
}

function exportApproved(input = {}) {
  return {
    exported_at: now(),
    safety_mode: 'manual_review_only',
    instructions: 'Approved items are suggestions only. No device action was or will be dispatched.',
    items: list({ status: 'approved_manual', limit: input.limit || 200 }),
  };
}

module.exports = {
  init,
  state,
  configure,
  observe,
  list,
  editDraft,
  approve: (id, input) => review(id, 'approve', input),
  dismiss: (id, input) => review(id, 'dismiss', input),
  exportApproved,
};
