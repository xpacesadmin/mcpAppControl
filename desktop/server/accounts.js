// Almacén de cuentas: credenciales cifradas (AES-256-GCM) asignables a dispositivos,
// con rotación, TOTP (2FA) y sustitución de variables {{account.*}} en las rutinas.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { now } = require('./db');

let DB = null;
let KEY = null;

function init(db) {
  DB = db;
  const dir = path.dirname(db.file && db.file !== ':memory:' ? db.file : __dirname);
  const keyFile = path.join(dir, 'secret.key');
  try {
    if (fs.existsSync(keyFile)) KEY = fs.readFileSync(keyFile);
    if (!KEY || KEY.length !== 32) { KEY = crypto.randomBytes(32); try { fs.writeFileSync(keyFile, KEY); } catch (_) {} }
  } catch (_) { KEY = crypto.createHash('sha256').update('mcp-fallback-key').digest(); }
}

// ---------- cifrado ----------
function enc(text) {
  if (text == null || text === '') return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}
function dec(blob) {
  if (!blob) return '';
  try {
    const raw = Buffer.from(blob, 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch (_) { return ''; }
}

// ---------- TOTP (RFC 6238, SHA1, 6 dígitos, 30s) ----------
function base32ToBuf(s) {
  const alph = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of s) bits += alph.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substr(i, 8), 2));
  return Buffer.from(bytes);
}
function totp(secret, when = Date.now()) {
  try {
    const key = base32ToBuf(secret);
    if (!key.length) return '';
    let counter = Math.floor(when / 1000 / 30);
    const buf = Buffer.alloc(8);
    for (let i = 7; i >= 0; i--) { buf[i] = counter & 0xff; counter = Math.floor(counter / 256); }
    const hmac = crypto.createHmac('sha1', key).update(buf).digest();
    const off = hmac[hmac.length - 1] & 0xf;
    const code = ((hmac[off] & 0x7f) << 24 | (hmac[off + 1] & 0xff) << 16 | (hmac[off + 2] & 0xff) << 8 | (hmac[off + 3] & 0xff)) % 1e6;
    return String(code).padStart(6, '0');
  } catch (_) { return ''; }
}

// ---------- serialización segura (sin secretos en claro) ----------
function publicView(a) {
  if (!a) return a;
  return {
    id: a.id, platform: a.platform, username: a.username, email: a.email,
    notes: a.notes, status: a.status, device_id: a.device_id, active: !!a.active,
    has_password: !!a.password_enc, has_totp: !!a.totp_enc,
    has_secret_ref: !!a.secret_ref,
    cooldown_until: a.cooldown_until, last_used_at: a.last_used_at,
    created_at: a.created_at, updated_at: a.updated_at,
  };
}

// ---------- CRUD ----------
function list({ platform, status, device_id } = {}) {
  let sql = 'SELECT * FROM accounts WHERE 1=1'; const p = [];
  if (platform) { sql += ' AND platform=?'; p.push(platform); }
  if (status) { sql += ' AND status=?'; p.push(status); }
  if (device_id != null) { sql += ' AND device_id=?'; p.push(device_id); }
  sql += ' ORDER BY platform, username';
  return DB.all(sql, p).map(publicView);
}
function create(d) {
  const r = DB.run('INSERT INTO accounts(platform,username,password_enc,email,totp_enc,secret_ref,notes,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [d.platform || null, d.username || null, enc(d.password), d.email || null, enc(d.totp_secret), d.secret_ref || null, d.notes || null, d.status || 'unused', now(), now()]);
  return publicView(DB.get('SELECT * FROM accounts WHERE id=?', [r.lastInsertRowid]));
}
function update(id, d) {
  const a = DB.get('SELECT * FROM accounts WHERE id=?', [id]);
  if (!a) return null;
  DB.run('UPDATE accounts SET platform=COALESCE(?,platform), username=COALESCE(?,username), email=COALESCE(?,email), secret_ref=COALESCE(?,secret_ref), notes=COALESCE(?,notes), status=COALESCE(?,status), password_enc=?, totp_enc=?, updated_at=? WHERE id=?',
    [d.platform ?? null, d.username ?? null, d.email ?? null, d.secret_ref ?? null, d.notes ?? null, d.status ?? null,
     d.password !== undefined && d.password !== '' ? enc(d.password) : a.password_enc,
     d.totp_secret !== undefined && d.totp_secret !== '' ? enc(d.totp_secret) : a.totp_enc,
     now(), id]);
  return publicView(DB.get('SELECT * FROM accounts WHERE id=?', [id]));
}
function remove(id) { DB.run('DELETE FROM accounts WHERE id=?', [id]); }

function importBulk(rows) {
  let n = 0;
  for (const d of rows || []) { if (d && (d.username || d.email)) { create(d); n++; } }
  return n;
}

// ---------- asignación / rotación ----------
function assign(id, deviceId) {
  const a = DB.get('SELECT * FROM accounts WHERE id=?', [id]);
  if (!a) return null;
  // desactivar otras cuentas activas de la misma plataforma en ese dispositivo
  DB.run("UPDATE accounts SET active=0 WHERE device_id=? AND platform=? AND id<>?", [deviceId, a.platform, id]);
  DB.run("UPDATE accounts SET device_id=?, active=1, status=CASE WHEN status='unused' THEN 'active' ELSE status END, updated_at=? WHERE id=?", [deviceId, now(), id]);
  return publicView(DB.get('SELECT * FROM accounts WHERE id=?', [id]));
}
// Reparto 1:1 en orden: la entrada i va al dispositivo i. `deviceIds` llega en el
// orden en que el operador ve la matriz, para que "teléfono 3" sea el que él ve
// como 3. Reutiliza la cuenta si ese correo ya existe en la misma plataforma, en
// vez de duplicarla en cada reparto.
function distribute({ entries, deviceIds, platform }) {
  const list = Array.isArray(entries) ? entries : [];
  const devs = Array.isArray(deviceIds) ? deviceIds : [];
  const plat = platform || null;
  const n = Math.min(list.length, devs.length);
  const assignments = [];

  for (let i = 0; i < n; i++) {
    const e = list[i] || {};
    const deviceId = devs[i];
    const ident = e.email || e.username;
    if (!ident) continue;

    let row = DB.get(
      "SELECT * FROM accounts WHERE (email=? OR username=?) AND COALESCE(platform,'')=COALESCE(?,'') LIMIT 1",
      [ident, ident, plat]
    );

    let accId;
    if (row) {
      accId = row.id;
      // Solo pisa la contraseña si en este reparto se ha aportado una nueva.
      if (e.password) update(accId, { password: e.password });
    } else {
      accId = create({ platform: plat, username: e.username || ident, email: e.email || ident, password: e.password, totp_secret: e.totp_secret }).id;
    }

    assign(accId, deviceId);
    assignments.push({ account_id: accId, device_id: deviceId, email: e.email || ident, reused: !!row });
  }

  return {
    assigned: assignments.length,
    assignments,
    leftover_entries: list.slice(n).map(e => e.email || e.username).filter(Boolean),
    leftover_devices: devs.slice(n),
  };
}

function unassign(id) {
  DB.run("UPDATE accounts SET device_id=NULL, active=0, updated_at=? WHERE id=?", [now(), id]);
  return publicView(DB.get('SELECT * FROM accounts WHERE id=?', [id]));
}
function setStatus(id, status) {
  const extra = status === 'cooldown' ? new Date(Date.now() + 6 * 3600000).toISOString() : null;
  DB.run('UPDATE accounts SET status=?, cooldown_until=?, updated_at=? WHERE id=?', [status, extra, now(), id]);
  return publicView(DB.get('SELECT * FROM accounts WHERE id=?', [id]));
}

// cuenta activa asignada a un dispositivo (opcionalmente por plataforma)
function activeFor(deviceId, platform) {
  let sql = 'SELECT * FROM accounts WHERE device_id=? AND active=1'; const p = [deviceId];
  if (platform) { sql += ' AND platform=?'; p.push(platform); }
  return DB.get(sql + ' ORDER BY updated_at DESC LIMIT 1', p);
}

// rota: pasa la activa a cooldown y activa la siguiente cuenta disponible del pool
function rotate(deviceId, platform) {
  const cur = activeFor(deviceId, platform);
  if (cur) DB.run("UPDATE accounts SET active=0, status='cooldown', cooldown_until=?, updated_at=? WHERE id=?", [new Date(Date.now() + 6 * 3600000).toISOString(), now(), cur.id]);
  // candidata: no baneada, sin dispositivo o del mismo, no en cooldown vigente, distinta de la actual
  let sql = "SELECT * FROM accounts WHERE status NOT IN ('banned') AND (device_id IS NULL OR device_id=?) AND (cooldown_until IS NULL OR cooldown_until < ?)";
  const p = [deviceId, now()];
  if (platform) { sql += ' AND platform=?'; p.push(platform); }
  if (cur) { sql += ' AND id<>?'; p.push(cur.id); }
  sql += ' ORDER BY last_used_at IS NULL DESC, last_used_at ASC, id ASC LIMIT 1';
  const next = DB.get(sql, p);
  const prevView = cur ? publicView(DB.get('SELECT * FROM accounts WHERE id=?', [cur.id])) : null;
  if (!next) return { rotated: false, previous: prevView, next: null };
  DB.run("UPDATE accounts SET device_id=?, active=1, status='active', last_used_at=?, updated_at=? WHERE id=?", [deviceId, now(), now(), next.id]);
  return { rotated: true, previous: prevView, next: publicView(DB.get('SELECT * FROM accounts WHERE id=?', [next.id])) };
}

// ---------- sustitución de variables en un paso de rutina ----------
const VAR_RE = /\{\{\s*account\.(\w+)\s*\}\}/g;
function hasVars(step) { return Object.values(step).some(v => typeof v === 'string' && v.includes('{{account.')); }

// Devuelve una copia del paso con {{account.x}} sustituido usando la cuenta activa del dispositivo.
function resolveVars(device, step) {
  if (!hasVars(step)) return step;
  const acc = activeFor(device.id, step.platform);
  const values = acc ? {
    username: acc.username || '', password: dec(acc.password_enc), email: acc.email || '',
    totp: totp(dec(acc.totp_enc)), notes: acc.notes || '', platform: acc.platform || '',
  } : {};
  const out = { ...step };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === 'string' && out[k].includes('{{account.')) {
      out[k] = out[k].replace(VAR_RE, (_, name) => (values[name] != null ? values[name] : ''));
    }
  }
  if (acc) DB.run('UPDATE accounts SET last_used_at=? WHERE id=?', [now(), acc.id]);
  return out;
}

module.exports = { init, list, create, update, remove, importBulk, assign, unassign, distribute, setStatus, activeFor, rotate, resolveVars, totp, publicView, _enc: enc, _dec: dec };
