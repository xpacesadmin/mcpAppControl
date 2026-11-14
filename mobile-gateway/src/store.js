'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomToken, tokenHash } = require('./crypto');

const ROLES = new Set(['viewer', 'operator', 'administrator']);

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA secure_delete = ON;

CREATE TABLE IF NOT EXISTS mobile_devices (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  step_up_public_key_pem TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','operator','administrator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('viewer','operator','administrator')),
  expires_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS mobile_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,
  access_expires_at INTEGER NOT NULL,
  refresh_hash TEXT NOT NULL UNIQUE,
  refresh_expires_at INTEGER NOT NULL,
  refresh_family_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  revoke_reason TEXT,
  FOREIGN KEY(device_id) REFERENCES mobile_devices(id)
);

CREATE TABLE IF NOT EXISTS spent_refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  refresh_family_id TEXT NOT NULL,
  spent_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request_nonces (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY(scope, scope_id, nonce)
);

CREATE TABLE IF NOT EXISTS step_up_challenges (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  challenge_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  target_device_ids TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES mobile_sessions(id)
);

CREATE TABLE IF NOT EXISTS step_up_tokens (
  token_hash TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_device_ids TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES mobile_sessions(id)
);

CREATE TABLE IF NOT EXISTS mobile_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL,
  actor_device_id TEXT,
  session_id TEXT,
  role TEXT,
  operation TEXT NOT NULL,
  target_device_ids TEXT NOT NULL DEFAULT '[]',
  result TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS mobile_operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL,
  target_device_ids TEXT NOT NULL,
  reason TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(session_id, idempotency_key),
  FOREIGN KEY(session_id) REFERENCES mobile_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_mobile_sessions_device ON mobile_sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_mobile_audit_time ON mobile_audit_events(id DESC);
CREATE INDEX IF NOT EXISTS idx_request_nonces_seen ON request_nonces(seen_at);
`;

function iso(clock) {
  return new Date(clock()).toISOString();
}

function json(value, fallback) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function pairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const groups = [];
  for (let group = 0; group < 3; group += 1) {
    let part = '';
    for (let index = 0; index < 4; index += 1) part += alphabet[crypto.randomInt(alphabet.length)];
    groups.push(part);
  }
  return groups.join('-');
}

function normalizeTargets(values) {
  const targets = [...new Set((Array.isArray(values) ? values : []).map(Number))];
  if (targets.some(value => !Number.isInteger(value) || value <= 0)) throw new Error('Invalid target device ID');
  return targets.sort((left, right) => left - right);
}

function safeMetadata(input) {
  const secret = /(pass(word)?|token|secret|credential|totp|authorization|cookie|session|email|username|public_key|signature|screenshot|image|frame|screen_content)/i;
  const walk = (value, key = '') => {
    if (secret.test(String(key))) return '[REDACTED]';
    if (typeof value === 'string') {
      return value
        .slice(0, 500)
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@');
    }
    if (Array.isArray(value)) return value.slice(0, 50).map(item => walk(item));
    if (value && typeof value === 'object') {
      const result = {};
      for (const [childKey, childValue] of Object.entries(value)) result[childKey] = walk(childValue, childKey);
      return result;
    }
    return value;
  };
  return walk(input || {});
}

class MobileStore {
  constructor(databaseFile, options = {}) {
    this.clock = options.clock || (() => Date.now());
    if (databaseFile !== ':memory:') {
      const parent = path.dirname(databaseFile);
      if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
        throw new Error('The mobile gateway database directory must already exist');
      }
    }
    this.db = new DatabaseSync(databaseFile);
    this.db.exec('PRAGMA busy_timeout = 5000');
    if (databaseFile !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
    const operationColumns = this.db.prepare('PRAGMA table_info(mobile_operations)').all();
    if (!operationColumns.some(column => column.name === 'request_fingerprint')) {
      this.db.exec("ALTER TABLE mobile_operations ADD COLUMN request_fingerprint TEXT NOT NULL DEFAULT ''");
    }
    this.recoverInterruptedOperations();
    if (databaseFile !== ':memory:') {
      try { fs.chmodSync(databaseFile, 0o600); } catch (_) {}
    }
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = callback();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  recoverInterruptedOperations() {
    const result = { code: 'gateway_restarted', message: 'The gateway restarted before the operation completed' };
    const recovered = this.db.prepare(
      "UPDATE mobile_operations SET status='failed',result=?,updated_at=? WHERE status IN ('accepted','running')"
    ).run(JSON.stringify(result), iso(this.clock)).changes;
    if (recovered) {
      this.audit({ operation: 'operation.recovery', result: 'failed', metadata: { count: recovered, code: result.code } });
    }
    return recovered;
  }

  createPairingCode({ role = 'viewer', ttlSeconds = 300, createdBy = 'local-administrator' } = {}) {
    if (!ROLES.has(role)) throw new Error('Invalid mobile role');
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 900) {
      throw new Error('Pairing TTL must be between 60 and 900 seconds');
    }
    const code = pairingCode();
    const now = this.clock();
    this.db.prepare(
      'INSERT INTO pairing_codes(id,code_hash,role,expires_at,created_by,created_at) VALUES (?,?,?,?,?,?)'
    ).run(crypto.randomUUID(), tokenHash(code), role, now + ttlSeconds * 1000, String(createdBy).slice(0, 100), iso(this.clock));
    this.audit({ operation: 'pairing.code_created', role: 'administrator', result: 'ok', metadata: { requested_role: role, ttl_seconds: ttlSeconds } });
    return { code, role, expires_at: new Date(now + ttlSeconds * 1000).toISOString() };
  }

  completePairing({ code, displayName, publicKeyPem, stepUpPublicKeyPem, accessTtlSeconds, refreshTtlSeconds }) {
    const now = this.clock();
    return this.transaction(() => {
      const pairing = this.db.prepare('SELECT * FROM pairing_codes WHERE code_hash=?').get(tokenHash(code));
      if (!pairing || pairing.used_at || pairing.expires_at <= now) return null;
      const deviceId = crypto.randomUUID();
      const timestamp = iso(this.clock);
      this.db.prepare(
        `INSERT INTO mobile_devices(id,display_name,public_key_pem,step_up_public_key_pem,role,status,created_at,updated_at)
         VALUES (?,?,?,?,?,'active',?,?)`
      ).run(deviceId, displayName, publicKeyPem, stepUpPublicKeyPem, pairing.role, timestamp, timestamp);
      this.db.prepare('UPDATE pairing_codes SET used_at=? WHERE id=? AND used_at IS NULL').run(timestamp, pairing.id);
      const session = this.#insertSession(deviceId, accessTtlSeconds, refreshTtlSeconds);
      return { device: this.getDevice(deviceId), ...session };
    });
  }

  #insertSession(deviceId, accessTtlSeconds, refreshTtlSeconds) {
    const now = this.clock();
    const accessToken = randomToken();
    const refreshToken = randomToken(48);
    const sessionId = crypto.randomUUID();
    const familyId = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO mobile_sessions(
         id,device_id,access_hash,access_expires_at,refresh_hash,refresh_expires_at,
         refresh_family_id,created_at,last_seen_at
       ) VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      sessionId,
      deviceId,
      tokenHash(accessToken),
      now + accessTtlSeconds * 1000,
      tokenHash(refreshToken),
      now + refreshTtlSeconds * 1000,
      familyId,
      iso(this.clock),
      iso(this.clock)
    );
    return {
      session_id: sessionId,
      access_token: accessToken,
      access_expires_at: new Date(now + accessTtlSeconds * 1000).toISOString(),
      refresh_token: refreshToken,
      refresh_expires_at: new Date(now + refreshTtlSeconds * 1000).toISOString(),
    };
  }

  getDevice(deviceId) {
    return this.db.prepare('SELECT * FROM mobile_devices WHERE id=?').get(deviceId) || null;
  }

  getSessionByAccessToken(accessToken) {
    const row = this.db.prepare(
      `SELECT s.*,d.display_name,d.public_key_pem,d.step_up_public_key_pem,d.role,d.status AS device_status,d.revoked_at AS device_revoked_at
         FROM mobile_sessions s JOIN mobile_devices d ON d.id=s.device_id
        WHERE s.access_hash=?`
    ).get(tokenHash(accessToken));
    return row || null;
  }

  getRefreshIdentity(deviceId) {
    return this.db.prepare('SELECT * FROM mobile_devices WHERE id=?').get(deviceId) || null;
  }

  touchSession(sessionId) {
    this.db.prepare('UPDATE mobile_sessions SET last_seen_at=? WHERE id=?').run(iso(this.clock), sessionId);
  }

  rotateRefresh({ deviceId, refreshToken, accessTtlSeconds, refreshTtlSeconds }) {
    const suppliedHash = tokenHash(refreshToken);
    const now = this.clock();
    return this.transaction(() => {
      const session = this.db.prepare(
        `SELECT s.*,d.status AS device_status,d.revoked_at AS device_revoked_at,d.role,d.public_key_pem,d.step_up_public_key_pem,d.display_name
           FROM mobile_sessions s JOIN mobile_devices d ON d.id=s.device_id
          WHERE s.device_id=? AND s.refresh_hash=?`
      ).get(deviceId, suppliedHash);
      if (!session) {
        const spent = this.db.prepare('SELECT * FROM spent_refresh_tokens WHERE token_hash=? AND device_id=?').get(suppliedHash, deviceId);
        if (spent) {
          const timestamp = iso(this.clock);
          this.db.prepare(
            `UPDATE mobile_sessions SET revoked_at=COALESCE(revoked_at,?),revoke_reason=COALESCE(revoke_reason,'refresh_token_reuse')
              WHERE device_id=?`
          ).run(timestamp, deviceId);
          return { reuse_detected: true };
        }
        return null;
      }
      if (session.revoked_at || session.device_status !== 'active' || session.refresh_expires_at <= now) return null;

      const nextAccessToken = randomToken();
      const nextRefreshToken = randomToken(48);
      this.db.prepare(
        'INSERT INTO spent_refresh_tokens(token_hash,device_id,refresh_family_id,spent_at) VALUES (?,?,?,?)'
      ).run(suppliedHash, deviceId, session.refresh_family_id, iso(this.clock));
      this.db.prepare(
        `UPDATE mobile_sessions SET access_hash=?,access_expires_at=?,refresh_hash=?,refresh_expires_at=?,last_seen_at=? WHERE id=?`
      ).run(
        tokenHash(nextAccessToken),
        now + accessTtlSeconds * 1000,
        tokenHash(nextRefreshToken),
        now + refreshTtlSeconds * 1000,
        iso(this.clock),
        session.id
      );
      return {
        reuse_detected: false,
        session_id: session.id,
        device_id: deviceId,
        role: session.role,
        access_token: nextAccessToken,
        access_expires_at: new Date(now + accessTtlSeconds * 1000).toISOString(),
        refresh_token: nextRefreshToken,
        refresh_expires_at: new Date(now + refreshTtlSeconds * 1000).toISOString(),
      };
    });
  }

  revokeSession(sessionId, reason = 'logout') {
    return this.db.prepare(
      'UPDATE mobile_sessions SET revoked_at=COALESCE(revoked_at,?),revoke_reason=COALESCE(revoke_reason,?) WHERE id=?'
    ).run(iso(this.clock), String(reason).slice(0, 100), sessionId).changes > 0;
  }

  revokeAllSessions(reason = 'administrator_revocation') {
    return this.db.prepare(
      'UPDATE mobile_sessions SET revoked_at=COALESCE(revoked_at,?),revoke_reason=COALESCE(revoke_reason,?) WHERE revoked_at IS NULL'
    ).run(iso(this.clock), String(reason).slice(0, 100)).changes;
  }

  consumeNonce(scope, scopeId, nonce, retentionMs = 10 * 60 * 1000) {
    const now = this.clock();
    this.db.prepare('DELETE FROM request_nonces WHERE seen_at<?').run(now - retentionMs);
    try {
      this.db.prepare('INSERT INTO request_nonces(scope,scope_id,nonce,seen_at) VALUES (?,?,?,?)').run(scope, scopeId, nonce, now);
      return true;
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) return false;
      throw error;
    }
  }

  createStepUpChallenge(sessionId, action, targetDeviceIds, ttlSeconds = 90) {
    const targets = normalizeTargets(targetDeviceIds);
    const challenge = randomToken(32);
    const id = crypto.randomUUID();
    const now = this.clock();
    this.db.prepare(
      `INSERT INTO step_up_challenges(id,session_id,challenge_hash,action,target_device_ids,expires_at,created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).run(id, sessionId, tokenHash(challenge), action, JSON.stringify(targets), now + ttlSeconds * 1000, iso(this.clock));
    return { challenge_id: id, challenge, action, target_device_ids: targets, expires_at: new Date(now + ttlSeconds * 1000).toISOString() };
  }

  consumeStepUpChallenge({ challengeId, sessionId, challenge, action, targetDeviceIds, tokenTtlSeconds = 120 }) {
    const targets = normalizeTargets(targetDeviceIds);
    const now = this.clock();
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM step_up_challenges WHERE id=? AND session_id=?').get(challengeId, sessionId);
      if (!row || row.consumed_at || row.expires_at <= now || row.challenge_hash !== tokenHash(challenge) || row.action !== action) return null;
      if (JSON.stringify(targets) !== row.target_device_ids) return null;
      const consumedAt = iso(this.clock);
      this.db.prepare('UPDATE step_up_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL').run(consumedAt, row.id);
      const token = randomToken(32);
      this.db.prepare(
        `INSERT INTO step_up_tokens(token_hash,session_id,action,target_device_ids,expires_at,created_at)
         VALUES (?,?,?,?,?,?)`
      ).run(tokenHash(token), sessionId, action, row.target_device_ids, now + tokenTtlSeconds * 1000, consumedAt);
      return { step_up_token: token, expires_at: new Date(now + tokenTtlSeconds * 1000).toISOString() };
    });
  }

  consumeStepUpToken(token, sessionId, action, targetDeviceIds) {
    const targets = normalizeTargets(targetDeviceIds);
    const now = this.clock();
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM step_up_tokens WHERE token_hash=? AND session_id=?').get(tokenHash(token), sessionId);
      if (!row || row.consumed_at || row.expires_at <= now || row.action !== action || row.target_device_ids !== JSON.stringify(targets)) return false;
      this.db.prepare('UPDATE step_up_tokens SET consumed_at=? WHERE token_hash=? AND consumed_at IS NULL').run(iso(this.clock), row.token_hash);
      return true;
    });
  }

  audit({ actorDeviceId = null, sessionId = null, role = null, operation, targetDeviceIds = [], result, metadata = {} }) {
    const targets = normalizeTargets(targetDeviceIds);
    const event = {
      event_id: crypto.randomUUID(),
      occurred_at: iso(this.clock),
      actor_device_id: actorDeviceId,
      session_id: sessionId,
      role,
      operation: String(operation).slice(0, 120),
      target_device_ids: targets,
      result: String(result).slice(0, 80),
      metadata: safeMetadata(metadata),
    };
    this.db.prepare(
      `INSERT INTO mobile_audit_events(event_id,occurred_at,actor_device_id,session_id,role,operation,target_device_ids,result,metadata)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      event.event_id,
      event.occurred_at,
      event.actor_device_id,
      event.session_id,
      event.role,
      event.operation,
      JSON.stringify(event.target_device_ids),
      event.result,
      JSON.stringify(event.metadata)
    );
    return event;
  }

  listAudit({ limit = 50, beforeId = null } = {}) {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const rows = beforeId
      ? this.db.prepare('SELECT * FROM mobile_audit_events WHERE id<? ORDER BY id DESC LIMIT ?').all(Number(beforeId), safeLimit)
      : this.db.prepare('SELECT * FROM mobile_audit_events ORDER BY id DESC LIMIT ?').all(safeLimit);
    return rows.map(row => ({
      id: row.id,
      event_id: row.event_id,
      occurred_at: row.occurred_at,
      actor_device_id: row.actor_device_id,
      role: row.role,
      operation: row.operation,
      target_device_ids: json(row.target_device_ids, []),
      result: row.result,
      metadata: json(row.metadata, {}),
    }));
  }

  createOperation({ sessionId, idempotencyKey, action, targetDeviceIds, reason, requestFingerprint }) {
    const existing = this.db.prepare('SELECT * FROM mobile_operations WHERE session_id=? AND idempotency_key=?').get(sessionId, idempotencyKey);
    if (existing) return { replay: true, operation: this.#operation(existing), requestFingerprint: existing.request_fingerprint };
    if (!/^[a-f0-9]{64}$/.test(String(requestFingerprint || ''))) throw new Error('Invalid request fingerprint');
    const now = iso(this.clock);
    const id = crypto.randomUUID();
    const safeReason = String(safeMetadata({ reason }).reason || '').slice(0, 240);
    this.db.prepare(
      `INSERT INTO mobile_operations(id,session_id,idempotency_key,action,target_device_ids,reason,request_fingerprint,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,'accepted',?,?)`
    ).run(id, sessionId, idempotencyKey, action, JSON.stringify(normalizeTargets(targetDeviceIds)), safeReason, requestFingerprint, now, now);
    return { replay: false, operation: this.getOperation(id), requestFingerprint };
  }

  getOperationByIdempotency(sessionId, idempotencyKey) {
    const row = this.db.prepare(
      'SELECT * FROM mobile_operations WHERE session_id=? AND idempotency_key=?'
    ).get(sessionId, idempotencyKey);
    return row ? { operation: this.#operation(row), requestFingerprint: row.request_fingerprint } : null;
  }

  updateOperation(id, status, result = null) {
    this.db.prepare('UPDATE mobile_operations SET status=?,result=?,updated_at=? WHERE id=?').run(
      status,
      result == null ? null : JSON.stringify(safeMetadata(result)),
      iso(this.clock),
      id
    );
    return this.getOperation(id);
  }

  #operation(row) {
    if (!row) return null;
    return {
      operation_id: row.id,
      action: row.action,
      target_device_ids: json(row.target_device_ids, []),
      status: row.status,
      result: json(row.result, null),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  getOperation(id, sessionId = null) {
    const row = sessionId
      ? this.db.prepare('SELECT * FROM mobile_operations WHERE id=? AND session_id=?').get(id, sessionId)
      : this.db.prepare('SELECT * FROM mobile_operations WHERE id=?').get(id);
    return this.#operation(row);
  }

  close() {
    this.db.close();
  }
}

module.exports = { MobileStore, ROLES, normalizeTargets, safeMetadata };
