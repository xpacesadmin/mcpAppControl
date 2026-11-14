'use strict';

const {
  canonicalPairing,
  canonicalRequest,
  canonicalStepUp,
  importEcPublicKey,
  sha256,
  verifyEcSignature,
} = require('./crypto');
const { SlidingWindowRateLimiter } = require('./rate-limit');
const { normalizeTargets } = require('./store');
const {
  envelope,
  devicesDto,
  routeDto,
  accountSummary,
  fleetSummaryDto,
  automationDto,
  taskDto,
  alertDto,
  auditDto,
} = require('./dto');

const ROLE_LEVEL = Object.freeze({ viewer: 1, operator: 2, administrator: 3 });
const IDEMPOTENCY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ACTIONS = Object.freeze({
  refresh_status: { role: 'operator', kind: 'command', command: 'DEVICE_HEALTH', params: () => ({}) },
  capture_screenshot: { role: 'operator', kind: 'command', command: 'CAPTURE_SCREEN', params: () => ({}) },
  screen_on: { role: 'operator', kind: 'command', command: 'SCREEN_ON', params: () => ({}) },
  screen_off: { role: 'operator', kind: 'command', command: 'SCREEN_OFF', params: () => ({}) },
  home: { role: 'operator', kind: 'command', command: 'PRESS_HOME', params: () => ({}) },
  back: { role: 'operator', kind: 'command', command: 'PRESS_BACK', params: () => ({}) },
  open_package: {
    role: 'operator',
    kind: 'command',
    command: 'OPEN_APP',
    params: (input, config) => {
      const packageName = String(input?.package_name || '').trim();
      if (!config.allowedPackages.has(packageName)) throw new ApiError(422, 'package_not_allowed', 'The package is not in the mobile allowlist');
      return { package_name: packageName };
    },
  },
  media_play: { role: 'operator', kind: 'command', command: 'INPUT_KEYEVENT', params: () => ({ keycode: 126 }) },
  media_pause: { role: 'operator', kind: 'command', command: 'INPUT_KEYEVENT', params: () => ({ keycode: 127 }) },
  media_next: { role: 'operator', kind: 'command', command: 'INPUT_KEYEVENT', params: () => ({ keycode: 87 }) },
  stop_task: { role: 'operator', kind: 'stop_task', stepUp: true },
  start_anti_idle: { role: 'operator', kind: 'anti_idle_start', stepUp: true },
  stop_anti_idle: { role: 'operator', kind: 'anti_idle_stop', stepUp: true },
});

class ApiError extends Error {
  constructor(status, code, message, details = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function header(headers, name) {
  const key = Object.keys(headers || {}).find(item => item.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

function bearer(headers) {
  const value = String(header(headers, 'authorization') || '');
  const match = value.match(/^Bearer\s+([A-Za-z0-9_-]+)$/i);
  return match ? match[1] : null;
}

function roleAtLeast(actual, required) {
  return Number(ROLE_LEVEL[actual] || 0) >= Number(ROLE_LEVEL[required] || Infinity);
}

function page(items, requestedPage, requestedSize) {
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(requestedSize, 10) || 50));
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(lastPage, Math.max(1, Number.parseInt(requestedPage, 10) || 1));
  const start = (currentPage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    pagination: {
      page: currentPage,
      per_page: pageSize,
      total,
      total_pages: lastPage,
      next_page: currentPage < lastPage ? currentPage + 1 : null,
    },
  };
}

function requestedTargets(values) {
  try { return normalizeTargets(values); }
  catch (_) { throw new ApiError(422, 'invalid_targets', 'Target device IDs must be unique positive integers'); }
}

function strictBody(input, allowedKeys, requiredKeys = allowedKeys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(422, 'invalid_request', 'A JSON object request body is required');
  }
  const keys = Object.keys(input);
  const unknown = keys.filter(key => !allowedKeys.includes(key));
  const missing = requiredKeys.filter(key => !Object.prototype.hasOwnProperty.call(input, key));
  if (unknown.length || missing.length) {
    throw new ApiError(422, 'invalid_request', 'The request body does not match the closed mobile API schema');
  }
  return input;
}

function mappedParameters(action, input, definition, config) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(422, 'invalid_parameters', 'Command parameters must be a JSON object');
  }
  const keys = Object.keys(input);
  if (action === 'open_package') {
    if (keys.length !== 1 || keys[0] !== 'package_name') {
      throw new ApiError(422, 'invalid_parameters', 'Open-package accepts only package_name');
    }
  } else if (keys.length) {
    throw new ApiError(422, 'invalid_parameters', 'This fixed action accepts no parameters');
  }
  return definition.kind === 'command' ? definition.params(input, config) : {};
}

function writeFingerprint(action, targets, reason, parameters = {}) {
  return sha256(JSON.stringify({ action, target_device_ids: targets, reason, parameters }));
}

class GatewayService {
  constructor({ config, store, upstream, clock = () => Date.now(), scheduler = queueMicrotask, rateLimiter = null }) {
    this.config = config;
    this.store = store;
    this.upstream = upstream;
    this.clock = clock;
    this.scheduler = scheduler;
    this.rateLimiter = rateLimiter || new SlidingWindowRateLimiter(clock);
    this.deviceLocks = new Set();
  }

  #rate(key, limit, windowMs) {
    const result = this.rateLimiter.consume(key, limit, windowMs);
    if (!result.allowed) {
      throw new ApiError(429, 'rate_limited', 'Too many requests', { retry_after_seconds: Math.ceil(result.retryAfterMs / 1000) });
    }
  }

  #assertFreshTimestamp(value) {
    const timestamp = Number(value);
    if (!Number.isInteger(timestamp)) throw new ApiError(401, 'invalid_signature', 'A signed timestamp is required');
    if (Math.abs(this.clock() - timestamp) > this.config.maxClockSkewSeconds * 1000) {
      throw new ApiError(401, 'stale_signature', 'The signed timestamp is outside the allowed clock window');
    }
    return timestamp;
  }

  #verifySignedRequest(publicKeyPem, request) {
    const timestamp = this.#assertFreshTimestamp(header(request.headers, 'x-xsalpha-timestamp'));
    const nonce = String(header(request.headers, 'x-xsalpha-nonce') || '');
    const signature = String(header(request.headers, 'x-xsalpha-signature') || '');
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || !signature) {
      throw new ApiError(401, 'invalid_signature', 'Signed nonce and signature are required');
    }
    const canonical = canonicalRequest(request.method, request.pathWithQuery, timestamp, nonce, request.rawBody);
    let valid = false;
    try { valid = verifyEcSignature(publicKeyPem, canonical, signature); } catch (_) {}
    if (!valid) throw new ApiError(401, 'invalid_signature', 'Request signature is invalid');
    return { nonce, timestamp };
  }

  pairComplete(request) {
    this.#rate(`pair:${request.peerAddress}`, 5, 10 * 60 * 1000);
    const input = strictBody(request.body, [
      'code', 'device_name', 'public_key_pem', 'step_up_public_key_pem', 'timestamp', 'proof_signature',
    ]);
    const code = String(input.code || '').trim().toUpperCase();
    const displayName = String(input.device_name || '').trim();
    const timestamp = this.#assertFreshTimestamp(input.timestamp);
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
      throw new ApiError(422, 'invalid_pairing', 'Pairing code format is invalid');
    }
    if (displayName.length < 2 || displayName.length > 80) {
      throw new ApiError(422, 'invalid_pairing', 'Device name must be between 2 and 80 characters');
    }
    let publicKey;
    let stepUpKey;
    try {
      publicKey = importEcPublicKey(input.public_key_pem).export({ type: 'spki', format: 'pem' });
      stepUpKey = importEcPublicKey(input.step_up_public_key_pem).export({ type: 'spki', format: 'pem' });
    } catch (error) {
      throw new ApiError(422, 'invalid_pairing', error.message);
    }
    const proof = canonicalPairing(code, displayName, timestamp);
    let valid = false;
    try { valid = verifyEcSignature(publicKey, proof, String(input.proof_signature || '')); } catch (_) {}
    if (!valid) throw new ApiError(401, 'invalid_pairing_proof', 'Pairing proof is invalid');

    const result = this.store.completePairing({
      code,
      displayName,
      publicKeyPem: publicKey,
      stepUpPublicKeyPem: stepUpKey,
      accessTtlSeconds: this.config.accessTtlSeconds,
      refreshTtlSeconds: this.config.refreshTtlSeconds,
    });
    if (!result) throw new ApiError(401, 'pairing_expired', 'Pairing code is invalid, expired, or already used');
    this.store.audit({
      actorDeviceId: result.device.id,
      sessionId: result.session_id,
      role: result.device.role,
      operation: 'pairing.complete',
      result: 'ok',
      metadata: { device_name: displayName },
    });
    return envelope({
      device: { id: result.device.id, name: result.device.display_name, role: result.device.role },
      session: {
        id: result.session_id,
        access_token: result.access_token,
        access_expires_at: result.access_expires_at,
        refresh_token: result.refresh_token,
        refresh_expires_at: result.refresh_expires_at,
      },
    }, { clock: this.clock });
  }

  refresh(request) {
    this.#rate(`refresh:${request.peerAddress}`, 10, 10 * 60 * 1000);
    const input = strictBody(request.body, ['device_id', 'refresh_token']);
    const deviceId = String(input.device_id || '');
    const identity = this.store.getRefreshIdentity(deviceId);
    if (!identity || identity.status !== 'active' || identity.revoked_at) {
      throw new ApiError(401, 'invalid_refresh', 'Refresh identity is invalid');
    }
    const signed = this.#verifySignedRequest(identity.public_key_pem, request);
    if (!this.store.consumeNonce('refresh', deviceId, signed.nonce)) {
      throw new ApiError(409, 'replay_detected', 'Request nonce was already used');
    }
    const result = this.store.rotateRefresh({
      deviceId,
      refreshToken: String(input.refresh_token || ''),
      accessTtlSeconds: this.config.accessTtlSeconds,
      refreshTtlSeconds: this.config.refreshTtlSeconds,
    });
    if (result?.reuse_detected) {
      this.store.audit({ actorDeviceId: deviceId, role: identity.role, operation: 'session.refresh', result: 'reuse_detected' });
      throw new ApiError(401, 'refresh_reuse_detected', 'Refresh token reuse revoked all sessions for this device');
    }
    if (!result) throw new ApiError(401, 'invalid_refresh', 'Refresh token is invalid or expired');
    this.store.audit({ actorDeviceId: deviceId, sessionId: result.session_id, role: result.role, operation: 'session.refresh', result: 'ok' });
    return envelope({
      session: {
        id: result.session_id,
        access_token: result.access_token,
        access_expires_at: result.access_expires_at,
        refresh_token: result.refresh_token,
        refresh_expires_at: result.refresh_expires_at,
      },
    }, { clock: this.clock });
  }

  authenticate(request, requiredRole = 'viewer') {
    this.#rate(`auth:${request.peerAddress || 'unknown'}`, 240, 60 * 1000);
    const token = bearer(request.headers);
    if (!token) throw new ApiError(401, 'authentication_required', 'A mobile access token is required');
    const session = this.store.getSessionByAccessToken(token);
    if (!session || session.revoked_at || session.device_status !== 'active' || session.device_revoked_at) {
      throw new ApiError(401, 'session_revoked', 'The mobile session is not active');
    }
    if (session.access_expires_at <= this.clock()) throw new ApiError(401, 'session_expired', 'The mobile access token expired');
    if (!roleAtLeast(session.role, requiredRole)) throw new ApiError(403, 'insufficient_role', 'The mobile role does not permit this operation');
    const signed = this.#verifySignedRequest(session.public_key_pem, request);
    if (!this.store.consumeNonce('access', session.id, signed.nonce)) {
      throw new ApiError(409, 'replay_detected', 'Request nonce was already used');
    }
    this.store.touchSession(session.id);
    this.#rate(`session:${session.id}`, 180, 60 * 1000);
    return {
      sessionId: session.id,
      accessExpiresAt: new Date(session.access_expires_at).toISOString(),
      deviceId: session.device_id,
      deviceName: session.display_name,
      publicKeyPem: session.public_key_pem,
      stepUpPublicKeyPem: session.step_up_public_key_pem,
      role: session.role,
    };
  }

  me(identity) {
    const availableActions = this.config.writesEnabled && roleAtLeast(identity.role, 'operator')
      ? [...this.config.allowedActions].filter(action => ACTIONS[action] && roleAtLeast(identity.role, ACTIONS[action].role)).sort()
      : [];
    return envelope({
      device: { id: identity.deviceId, name: identity.deviceName },
      role: identity.role,
      session: { id: identity.sessionId, access_expires_at: identity.accessExpiresAt },
      capabilities: {
        read_dashboard: true,
        live_view: false,
        writes_enabled: this.config.writesEnabled,
        actions: availableActions,
        approved_packages: availableActions.includes('open_package') ? [...this.config.allowedPackages].sort() : [],
        emergency_stop: this.config.writesEnabled && identity.role === 'administrator',
        resume: this.config.writesEnabled && identity.role === 'administrator',
      },
    }, { clock: this.clock });
  }

  logout(identity) {
    this.store.revokeSession(identity.sessionId, 'logout');
    this.store.audit({ actorDeviceId: identity.deviceId, sessionId: identity.sessionId, role: identity.role, operation: 'session.logout', result: 'ok' });
    return envelope({ logged_out: true }, { clock: this.clock });
  }

  async #labStatus() {
    const lab = await this.upstream.getLabStatus();
    if (lab?.hermes_enabled === true) {
      throw new ApiError(503, 'unsafe_upstream_state', 'Mobile access is unavailable while Hermes is enabled');
    }
    return lab;
  }

  async fleetSummary() {
    const [lab, dashboard, tasks] = await Promise.all([
      this.#labStatus(),
      this.upstream.getDashboardStats(),
      this.upstream.getTaskStats(),
    ]);
    return envelope(fleetSummaryDto({ dashboard, tasks, lab }), { clock: this.clock, sourceTime: lab?.updated_at });
  }

  async devices(query = {}) {
    const [lab, rawDevices, routes, inventory] = await Promise.all([
      this.#labStatus(),
      this.upstream.getDevices(),
      this.upstream.getRoutes(),
      this.upstream.getAccountInventory(),
    ]);
    let devices = devicesDto(rawDevices, routes, inventory);
    if (query.status) devices = devices.filter(device => device.status === query.status);
    if (query.search) {
      const term = String(query.search).trim().toLowerCase().slice(0, 80);
      devices = devices.filter(device => device.name.toLowerCase().includes(term));
    }
    return envelope(page(devices, query.page, query.per_page), { clock: this.clock, sourceTime: lab?.updated_at });
  }

  async device(deviceId) {
    const [lab, rawDevices, routes, inventory] = await Promise.all([
      this.#labStatus(),
      this.upstream.getDevices(),
      this.upstream.getRoutes(),
      this.upstream.getAccountInventory(),
    ]);
    const device = devicesDto(rawDevices, routes, inventory).find(item => item.id === Number(deviceId));
    if (!device) throw new ApiError(404, 'device_not_found', 'Named device was not found');
    return envelope(device, { clock: this.clock, sourceTime: device.last_seen_at || lab?.updated_at });
  }

  async accountHealth(deviceId) {
    const [lab, inventory] = await Promise.all([this.#labStatus(), this.upstream.getAccountInventory()]);
    const rows = inventory.filter(row => Number(row.device_id) === Number(deviceId));
    const devices = await this.upstream.getDevices();
    const named = devices.find(item => Number(item.id) === Number(deviceId));
    if (!named) throw new ApiError(404, 'device_not_found', 'Named device was not found');
    const summary = accountSummary(rows);
    return envelope({ device_id: Number(deviceId), device_name: String(named.name || `Device ${deviceId}`).slice(0, 120), ...summary }, {
      clock: this.clock,
      sourceTime: summary.last_verified_at || lab?.updated_at,
      maximumAgeSeconds: 600,
    });
  }

  async routes(query = {}) {
    await this.#labStatus();
    let routes = (await this.upstream.getRoutes()).map(routeDto);
    if (query.health_state) routes = routes.filter(route => route.health_state === query.health_state);
    return envelope(page(routes, query.page, query.per_page), { clock: this.clock, sourceTime: routes.map(route => route.updated_at).filter(Boolean).sort().at(-1) });
  }

  async automations() {
    const [lab, antiIdle] = await Promise.all([this.#labStatus(), this.upstream.getAntiIdle()]);
    return envelope(automationDto(antiIdle), { clock: this.clock, sourceTime: antiIdle?.updated_at || lab?.updated_at });
  }

  async activity(query = {}) {
    await this.#labStatus();
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const tasks = (await this.upstream.getRecentTasks(limit)).map(taskDto);
    return envelope({ items: tasks, pagination: { limit, count: tasks.length } }, { clock: this.clock, sourceTime: tasks.map(task => task.created_at).filter(Boolean).sort().at(-1) });
  }

  async alerts(query = {}) {
    await this.#labStatus();
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const alerts = (await this.upstream.getNotifications()).slice(0, limit).map(alertDto);
    return envelope({ items: alerts, pagination: { limit, count: alerts.length } }, { clock: this.clock, sourceTime: alerts.map(alert => alert.occurred_at).filter(Boolean).sort().at(-1) });
  }

  async audit(query = {}) {
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
    const [lab, desktopRows, localRows] = await Promise.all([
      this.#labStatus(),
      this.upstream.getAudit(limit),
      Promise.resolve(this.store.listAudit({ limit, beforeId: query.before_id })),
    ]);
    const desktop = (Array.isArray(desktopRows) ? desktopRows : []).map(row => ({ source: 'desktop', ...auditDto(row) }));
    const mobile = localRows.map(row => ({
      source: 'mobile_gateway',
      id: row.id,
      operation: row.operation,
      actor: row.actor_device_id ? `mobile-device:${row.actor_device_id.slice(0, 8)}` : 'gateway',
      role: row.role,
      device_id: row.target_device_ids.length === 1 ? row.target_device_ids[0] : null,
      route_id: null,
      result: row.result,
      details: row.metadata,
      occurred_at: row.occurred_at,
    }));
    const items = [...mobile, ...desktop]
      .sort((left, right) => String(right.occurred_at || '').localeCompare(String(left.occurred_at || '')))
      .slice(0, limit);
    return envelope({ items, pagination: { limit, count: items.length, next_before_id: localRows.at(-1)?.id || null } }, { clock: this.clock, sourceTime: items[0]?.occurred_at || lab?.updated_at });
  }

  createStepUpChallenge(identity, input) {
    input = strictBody(input, ['action', 'target_device_ids']);
    if (!this.config.writesEnabled) throw new ApiError(403, 'read_only_mode', 'The mobile gateway is in read-only mode');
    const action = String(input?.action || '');
    const targets = requestedTargets(input?.target_device_ids || []);
    const requiredRole = ['emergency_stop', 'resume'].includes(action) ? 'administrator' : ACTIONS[action]?.role;
    if (!requiredRole || !roleAtLeast(identity.role, requiredRole)) throw new ApiError(403, 'insufficient_role', 'The action is not available to this role');
    this.#rate(`step-up:${identity.sessionId}`, 10, 10 * 60 * 1000);
    const challenge = this.store.createStepUpChallenge(identity.sessionId, action, targets);
    this.store.audit({ actorDeviceId: identity.deviceId, sessionId: identity.sessionId, role: identity.role, operation: 'step_up.challenge', targetDeviceIds: targets, result: 'issued', metadata: { action } });
    return envelope(challenge, { clock: this.clock });
  }

  completeStepUp(identity, input) {
    input = strictBody(input, ['challenge_id', 'challenge', 'action', 'target_device_ids', 'step_up_signature']);
    const action = String(input?.action || '');
    const targets = requestedTargets(input?.target_device_ids || []);
    const canonical = canonicalStepUp(input?.challenge_id, input?.challenge, action, targets);
    let valid = false;
    try { valid = verifyEcSignature(identity.stepUpPublicKeyPem, canonical, String(input?.step_up_signature || '')); } catch (_) {}
    if (!valid) throw new ApiError(401, 'invalid_step_up', 'Step-up signature is invalid');
    const result = this.store.consumeStepUpChallenge({
      challengeId: String(input.challenge_id || ''),
      sessionId: identity.sessionId,
      challenge: String(input.challenge || ''),
      action,
      targetDeviceIds: targets,
    });
    if (!result) throw new ApiError(401, 'invalid_step_up', 'Step-up challenge is invalid, expired, or already used');
    this.store.audit({ actorDeviceId: identity.deviceId, sessionId: identity.sessionId, role: identity.role, operation: 'step_up.complete', targetDeviceIds: targets, result: 'ok', metadata: { action } });
    return envelope(result, { clock: this.clock });
  }

  #writeInput(identity, input, headers, action, requiredRole) {
    if (!this.config.writesEnabled) throw new ApiError(403, 'read_only_mode', 'The mobile gateway is in read-only mode');
    if (!roleAtLeast(identity.role, requiredRole)) throw new ApiError(403, 'insufficient_role', 'The mobile role does not permit this operation');
    if (input?.confirm !== true || String(header(headers, 'x-xsalpha-confirmation')).toLowerCase() !== 'true') {
      throw new ApiError(422, 'confirmation_required', 'Explicit write confirmation is required');
    }
    const reason = String(input?.reason || '').trim();
    if (reason.length < 4 || reason.length > 240) throw new ApiError(422, 'reason_required', 'A reason between 4 and 240 characters is required');
    const idempotencyKey = String(input?.idempotency_key || '').trim();
    if (!IDEMPOTENCY_RE.test(idempotencyKey)) throw new ApiError(422, 'invalid_idempotency_key', 'A UUID idempotency key is required');
    const targets = requestedTargets(input?.target_device_ids || []);
    return { action, reason, idempotencyKey, targets };
  }

  #idempotentReplay(identity, write) {
    const record = this.store.getOperationByIdempotency(identity.sessionId, write.idempotencyKey);
    if (!record) return null;
    const existing = record.operation;
    if (existing.action !== write.action || JSON.stringify(existing.target_device_ids) !== JSON.stringify(write.targets)) {
      throw new ApiError(409, 'idempotency_conflict', 'The idempotency key was already used for a different operation');
    }
    if (!record.requestFingerprint || record.requestFingerprint !== write.requestFingerprint) {
      throw new ApiError(409, 'idempotency_conflict', 'The idempotency key was already used for a different request');
    }
    return envelope(existing, { clock: this.clock, sourceTime: existing.updated_at });
  }

  #auditWriteRejection(identity, operation, input, error, fallbackAction) {
    let targets = [];
    try { targets = normalizeTargets(input?.target_device_ids || []); } catch (_) {}
    this.store.audit({
      actorDeviceId: identity.deviceId,
      sessionId: identity.sessionId,
      role: identity.role,
      operation,
      targetDeviceIds: targets,
      result: 'rejected',
      metadata: {
        action: String(input?.action || fallbackAction || 'unknown').slice(0, 120),
        idempotency_key: String(input?.idempotency_key || '').slice(0, 80),
        reason: String(input?.reason || '').slice(0, 240),
        confirmation_present: input?.confirm === true,
        code: String(error?.code || 'operation_rejected').slice(0, 80),
      },
    });
  }

  #consumeStepUpIfRequired(identity, headers, action, targets, required) {
    if (!required) return;
    const token = String(header(headers, 'x-xsalpha-step-up-token') || '');
    if (!token || !this.store.consumeStepUpToken(token, identity.sessionId, action, targets)) {
      throw new ApiError(401, 'step_up_required', 'A valid, action-bound biometric step-up token is required');
    }
  }

  async #validateTargets(targets, { requireRoute = true } = {}) {
    if (!targets.length) throw new ApiError(422, 'targets_required', 'At least one named target device is required');
    const [lab, devices, routes] = await Promise.all([this.#labStatus(), this.upstream.getDevices(), this.upstream.getRoutes()]);
    if (lab?.halted) throw new ApiError(423, 'lab_halted', 'The lab is halted');
    const deviceById = new Map(devices.map(device => [Number(device.id), device]));
    const routeByDevice = new Map(routes.filter(route => route.assigned_device_id != null).map(route => [Number(route.assigned_device_id), route]));
    for (const target of targets) {
      const device = deviceById.get(target);
      if (!device || !String(device.name || '').trim()) throw new ApiError(422, 'ambiguous_target', 'Every target must resolve to one named device');
      if (device.screen_control_allowed !== true) throw new ApiError(403, 'target_out_of_scope', 'A target is outside the desktop lab scope');
      if (requireRoute) {
        const route = routeByDevice.get(target);
        const verified = route && route.health_state === 'verified' && route.expected_public_ip && route.observed_public_ip === route.expected_public_ip;
        if (!verified) throw new ApiError(423, 'route_unverified', 'Every target must have its verified assigned route');
      }
    }
    return { lab, devices: targets.map(id => deviceById.get(id)), routes: targets.map(id => routeByDevice.get(id)) };
  }

  async submitCommand(identity, input, headers) {
    try {
    input = strictBody(input, ['action', 'target_device_ids', 'parameters', 'reason', 'confirm', 'idempotency_key']);
    const action = String(input.action || '');
    const definition = ACTIONS[action];
    if (!definition || !this.config.allowedActions.has(action)) {
      throw new ApiError(422, 'action_not_allowed', 'The action is not in the mobile command allowlist');
    }
    const write = this.#writeInput(identity, input, headers, action, definition.role);
    const parameters = mappedParameters(action, input.parameters, definition, this.config);
    write.requestFingerprint = writeFingerprint(action, write.targets, write.reason, parameters);
    if (write.targets.length > 10) throw new ApiError(422, 'too_many_targets', 'Mobile commands are limited to ten named devices');
    const replay = this.#idempotentReplay(identity, write);
    if (replay) return replay;
    this.#rate(`commands:${identity.sessionId}`, 10, 60 * 1000);
    this.#consumeStepUpIfRequired(identity, headers, action, write.targets, definition.stepUp === true || write.targets.length > 1);
    await this.#validateTargets(write.targets);
    const replayAfterValidation = this.#idempotentReplay(identity, write);
    if (replayAfterValidation) return replayAfterValidation;
    if (write.targets.some(target => this.deviceLocks.has(target))) {
      throw new ApiError(409, 'target_busy', 'A conflicting mobile write is already active for a target');
    }
    const created = this.store.createOperation({
      sessionId: identity.sessionId,
      idempotencyKey: write.idempotencyKey,
      action,
      targetDeviceIds: write.targets,
      reason: write.reason,
      requestFingerprint: write.requestFingerprint,
    });
    if (created.replay) {
      if (created.requestFingerprint !== write.requestFingerprint) throw new ApiError(409, 'idempotency_conflict', 'The idempotency key was already used for a different request');
      return envelope(created.operation, { clock: this.clock });
    }
    write.targets.forEach(target => this.deviceLocks.add(target));
    this.store.audit({ actorDeviceId: identity.deviceId, sessionId: identity.sessionId, role: identity.role, operation: 'command.accepted', targetDeviceIds: write.targets, result: 'accepted', metadata: { action, operation_id: created.operation.operation_id, idempotency_key: write.idempotencyKey, reason: write.reason, confirmation_present: true } });
    this.scheduler(() => this.#runCommand(identity, created.operation, definition, write, parameters));
    return envelope(created.operation, { clock: this.clock });
    } catch (error) {
      this.#auditWriteRejection(identity, 'command.rejected', input, error, input?.action);
      throw error;
    }
  }

  async #runCommand(identity, operation, definition, write, parameters) {
    const operationId = operation.operation_id;
    this.store.updateOperation(operationId, 'running');
    try {
      let upstreamResult;
      if (definition.kind === 'command') {
        upstreamResult = await this.upstream.dispatchDeviceCommand(write.targets, definition.command, parameters);
      } else if (definition.kind === 'stop_task') {
        upstreamResult = await this.upstream.stopTasks(write.targets);
      } else if (definition.kind === 'anti_idle_start' || definition.kind === 'anti_idle_stop') {
        const state = await this.upstream.getAntiIdle();
        const configured = [...new Set((state?.device_ids || []).map(Number))].sort((a, b) => a - b);
        if (JSON.stringify(configured) !== JSON.stringify(write.targets)) {
          throw new ApiError(422, 'automation_target_mismatch', 'Targets must exactly match the desktop-configured automation targets');
        }
        const payload = {
          confirm: true,
          reason: write.reason,
          actor: `mobile:${identity.deviceId}`,
          idempotency_key: write.idempotencyKey,
          ...(definition.kind === 'anti_idle_start' ? { run_immediately: false } : {}),
        };
        upstreamResult = definition.kind === 'anti_idle_start'
          ? await this.upstream.startAntiIdle(payload)
          : await this.upstream.stopAntiIdle(payload);
      } else {
        throw new ApiError(500, 'invalid_mapping', 'The fixed action mapping is invalid');
      }
      const summary = {
        accepted: true,
        total: Number(upstreamResult?.total ?? write.targets.length),
        ok: Number(upstreamResult?.ok ?? write.targets.length),
        failed: Number(upstreamResult?.failed ?? 0),
        response_data_suppressed: definition.command === 'CAPTURE_SCREEN',
      };
      this.store.updateOperation(operationId, 'succeeded', summary);
      this.store.audit({ actorDeviceId: identity.deviceId, sessionId: identity.sessionId, role: identity.role, operation: 'command.result', targetDeviceIds: write.targets, result: 'succeeded', metadata: { action: write.action, operation_id: operationId, idempotency_key: write.idempotencyKey, ...summary } });
    } catch (error) {
      const failure = { code: error.code || 'operation_failed', message: 'The mapped operation did not complete' };
      this.store.updateOperation(operationId, 'failed', failure);
      this.store.audit({ actorDeviceId: identity.deviceId, sessionId: identity.sessionId, role: identity.role, operation: 'command.result', targetDeviceIds: write.targets, result: 'failed', metadata: { action: write.action, operation_id: operationId, idempotency_key: write.idempotencyKey, code: failure.code } });
    } finally {
      write.targets.forEach(target => this.deviceLocks.delete(target));
    }
  }

  operation(identity, operationId) {
    const operation = this.store.getOperation(String(operationId || ''), identity.sessionId);
    if (!operation) throw new ApiError(404, 'operation_not_found', 'Operation was not found');
    return envelope(operation, { clock: this.clock, sourceTime: operation.updated_at });
  }

  async emergencyStop(identity, input, headers) {
    try {
    input = strictBody(input, ['target_device_ids', 'reason', 'confirm', 'idempotency_key']);
    const write = this.#writeInput(identity, input, headers, 'emergency_stop', 'administrator');
    write.requestFingerprint = writeFingerprint(write.action, write.targets, write.reason);
    if (write.targets.length) throw new ApiError(422, 'invalid_targets', 'Emergency stop is fleet-wide and does not accept target IDs');
    const replay = this.#idempotentReplay(identity, write);
    if (replay) return replay;
    this.#rate(`emergency:${identity.sessionId}`, 3, 10 * 60 * 1000);
    this.#consumeStepUpIfRequired(identity, headers, 'emergency_stop', [], true);
    const created = this.store.createOperation({ sessionId: identity.sessionId, idempotencyKey: write.idempotencyKey, action: 'emergency_stop', targetDeviceIds: [], reason: write.reason, requestFingerprint: write.requestFingerprint });
    if (created.replay) {
      if (created.requestFingerprint !== write.requestFingerprint) throw new ApiError(409, 'idempotency_conflict', 'The idempotency key was already used for a different request');
      return envelope(created.operation, { clock: this.clock });
    }
    this.store.audit({ actorDeviceId: identity.deviceId, sessionId: identity.sessionId, role: identity.role, operation: 'lab.emergency_stop.accepted', result: 'accepted', metadata: { operation_id: created.operation.operation_id, idempotency_key: write.idempotencyKey, reason: write.reason, confirmation_present: true } });
    this.scheduler(async () => {
      this.store.updateOperation(created.operation.operation_id, 'running');
      try {
        await this.upstream.emergencyStop({ confirm: true, reason: write.reason, actor: `mobile:${identity.deviceId}`, idempotency_key: write.idempotencyKey });
        this.store.updateOperation(created.operation.operation_id, 'succeeded', { halted: true });
        this.store.audit({ actorDeviceId: identity.deviceId, sessionId: identity.sessionId, role: identity.role, operation: 'lab.emergency_stop', result: 'succeeded', metadata: { operation_id: created.operation.operation_id, idempotency_key: write.idempotencyKey, reason: write.reason } });
      } catch (error) {
        this.store.updateOperation(created.operation.operation_id, 'failed', { code: error.code || 'operation_failed' });
        this.store.audit({ actorDeviceId: identity.deviceId, sessionId: identity.sessionId, role: identity.role, operation: 'lab.emergency_stop', result: 'failed', metadata: { operation_id: created.operation.operation_id, idempotency_key: write.idempotencyKey } });
      }
    });
    return envelope(created.operation, { clock: this.clock });
    } catch (error) {
      this.#auditWriteRejection(identity, 'lab.emergency_stop.rejected', input, error, 'emergency_stop');
      throw error;
    }
  }

  async resume(identity, input, headers) {
    try {
    input = strictBody(input, ['target_device_ids', 'reason', 'confirm', 'idempotency_key']);
    const write = this.#writeInput(identity, input, headers, 'resume', 'administrator');
    write.requestFingerprint = writeFingerprint(write.action, write.targets, write.reason);
    if (write.targets.length) throw new ApiError(422, 'invalid_targets', 'Resume is fleet-wide and does not accept target IDs');
    const replay = this.#idempotentReplay(identity, write);
    if (replay) return replay;
    this.#consumeStepUpIfRequired(identity, headers, 'resume', [], true);
    const lab = await this.#labStatus();
    if (!lab?.halted) throw new ApiError(409, 'lab_not_halted', 'The lab is not halted');
    const replayAfterStatus = this.#idempotentReplay(identity, write);
    if (replayAfterStatus) return replayAfterStatus;
    const created = this.store.createOperation({ sessionId: identity.sessionId, idempotencyKey: write.idempotencyKey, action: 'resume', targetDeviceIds: [], reason: write.reason, requestFingerprint: write.requestFingerprint });
    if (created.replay) {
      if (created.requestFingerprint !== write.requestFingerprint) throw new ApiError(409, 'idempotency_conflict', 'The idempotency key was already used for a different request');
      return envelope(created.operation, { clock: this.clock });
    }
    this.store.audit({ actorDeviceId: identity.deviceId, sessionId: identity.sessionId, role: identity.role, operation: 'lab.resume.accepted', result: 'accepted', metadata: { operation_id: created.operation.operation_id, idempotency_key: write.idempotencyKey, reason: write.reason, confirmation_present: true } });
    this.scheduler(async () => {
      this.store.updateOperation(created.operation.operation_id, 'running');
      try {
        await this.upstream.resume({ confirm_resume: true, reason: write.reason, actor: `mobile:${identity.deviceId}`, idempotency_key: write.idempotencyKey });
        this.store.updateOperation(created.operation.operation_id, 'succeeded', { halted: false, schedules_restarted: false });
        this.store.audit({ actorDeviceId: identity.deviceId, sessionId: identity.sessionId, role: identity.role, operation: 'lab.resume', result: 'succeeded', metadata: { operation_id: created.operation.operation_id, idempotency_key: write.idempotencyKey, reason: write.reason } });
      } catch (error) {
        this.store.updateOperation(created.operation.operation_id, 'failed', { code: error.code || 'operation_failed' });
        this.store.audit({ actorDeviceId: identity.deviceId, sessionId: identity.sessionId, role: identity.role, operation: 'lab.resume', result: 'failed', metadata: { operation_id: created.operation.operation_id, idempotency_key: write.idempotencyKey } });
      }
    });
    return envelope(created.operation, { clock: this.clock });
    } catch (error) {
      this.#auditWriteRejection(identity, 'lab.resume.rejected', input, error, 'resume');
      throw error;
    }
  }
}

module.exports = { ACTIONS, ApiError, GatewayService, roleAtLeast };
