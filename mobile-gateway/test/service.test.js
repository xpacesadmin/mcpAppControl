'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MobileStore } = require('../src/store');
const { GatewayService, ApiError } = require('../src/service');
const { canonicalPairing, canonicalRequest, canonicalStepUp } = require('../src/crypto');

function keyPair() {
  const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    privateKey: pair.privateKey,
    publicPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

function sign(privateKey, value) {
  return crypto.sign('sha256', Buffer.from(value, 'utf8'), privateKey).toString('base64url');
}

function signedRequest({ token = null, privateKey, method = 'GET', path = '/mobile/v1/me', body = {}, now, nonce = crypto.randomBytes(16).toString('base64url') }) {
  const rawBody = ['GET', 'HEAD'].includes(method) && Object.keys(body).length === 0
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify(body));
  const signature = sign(privateKey, canonicalRequest(method, path, now, nonce, rawBody));
  return {
    method,
    pathWithQuery: path,
    path,
    body,
    rawBody,
    peerAddress: '100.100.1.4',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-xsalpha-timestamp': String(now),
      'x-xsalpha-nonce': nonce,
      'x-xsalpha-signature': signature,
    },
  };
}

class FakeUpstream {
  constructor() {
    this.lab = {
      lab_mode_enabled: true,
      halted: false,
      lab_scope: 'canary',
      hermes_enabled: false,
      updated_at: '2026-09-22T20:00:00.000Z',
    };
    this.devices = [{
      id: 1,
      name: 'FLEET_01',
      serial_number: 'SERIAL-MUST-NOT-LEAK',
      adb_serial: '192.0.2.4:5555',
      status: 'online',
      screen_control_allowed: true,
      last_seen: '2026-09-22T20:00:00.000Z',
    }];
    this.routes = [{
      route_id: 'route-fleet-01',
      assigned_device_id: 1,
      assigned_fleet_vlan: 60,
      health_state: 'verified',
      expected_public_ip: '198.51.100.7',
      observed_public_ip: '198.51.100.7',
      internal_host: '10.0.0.4',
      provider: 'must-not-leak',
      updated_at: '2026-09-22T20:00:00.000Z',
    }];
    this.calls = [];
  }

  async getLabStatus() { return this.lab; }
  async getDashboardStats() { return { devices: { total: 1, online: 1, busy: 0, offline: 0, error: 0 }, tasks: {} }; }
  async getTaskStats() { return { running_tasks: 0, scheduled_tasks: 0, failed_tasks: 0, completed_tasks: 5 }; }
  async getDevices() { return this.devices; }
  async getRoutes() { return this.routes; }
  async getAccountInventory() { return [{ device_id: 1, email: 'owner@example.com', username: 'owner', verification_state: 'present', last_verified_at: '2026-09-22T20:00:00.000Z' }]; }
  async getAntiIdle() { return { enabled: false, running: false, device_ids: [1], updated_at: '2026-09-22T20:00:00.000Z' }; }
  async getRecentTasks() { return []; }
  async getNotifications() { return []; }
  async getAudit() { return []; }
  async dispatchDeviceCommand(ids, command, params) { this.calls.push({ type: 'command', ids, command, params }); return { total: ids.length, ok: ids.length, failed: 0 }; }
  async stopTasks(ids) { this.calls.push({ type: 'stop_task', ids }); return { devices: ids.length }; }
  async startAntiIdle(input) { this.calls.push({ type: 'anti_idle_start', input }); return { enabled: true }; }
  async stopAntiIdle(input) { this.calls.push({ type: 'anti_idle_stop', input }); return { enabled: false }; }
  async emergencyStop(input) { this.calls.push({ type: 'emergency_stop', input }); this.lab.halted = true; return this.lab; }
  async resume(input) { this.calls.push({ type: 'resume', input }); this.lab.halted = false; return this.lab; }
}

function harness({ role = 'viewer', writesEnabled = false, allowedActions = [], upstream = new FakeUpstream() } = {}) {
  let now = Date.parse('2026-09-22T20:01:00.000Z');
  const clock = () => now;
  const store = new MobileStore(':memory:', { clock });
  const pending = [];
  const config = {
    writesEnabled,
    allowedActions: new Set(allowedActions),
    allowedPackages: new Set(['com.example.approved']),
    accessTtlSeconds: 300,
    refreshTtlSeconds: 3600,
    maxClockSkewSeconds: 120,
  };
  const service = new GatewayService({ config, store, upstream, clock, scheduler: callback => pending.push(callback) });
  const deviceKey = keyPair();
  const stepUpKey = keyPair();
  const pairing = store.createPairingCode({ role, ttlSeconds: 300 });
  const pairBody = {
    code: pairing.code,
    device_name: 'Owner phone',
    public_key_pem: deviceKey.publicPem,
    step_up_public_key_pem: stepUpKey.publicPem,
    timestamp: now,
    proof_signature: sign(deviceKey.privateKey, canonicalPairing(pairing.code, 'Owner phone', now)),
  };
  const paired = service.pairComplete({ body: pairBody, peerAddress: '100.100.1.4' }).data;
  const authenticate = (path = '/mobile/v1/me') => service.authenticate(signedRequest({
    token: paired.session.access_token,
    privateKey: deviceKey.privateKey,
    path,
    now,
  }));
  return {
    service, store, upstream, pending, deviceKey, stepUpKey, paired, authenticate,
    now: () => now,
    advance: milliseconds => { now += milliseconds; },
    close: () => store.close(),
  };
}

test('pairing creates a signed short-lived session and request nonce replay fails', () => {
  const h = harness();
  try {
    const request = signedRequest({
      token: h.paired.session.access_token,
      privateKey: h.deviceKey.privateKey,
      now: h.now(),
    });
    const identity = h.service.authenticate(request);
    assert.equal(identity.role, 'viewer');
    assert.throws(() => h.service.authenticate(request), error => error instanceof ApiError && error.code === 'replay_detected');
  } finally { h.close(); }
});

test('authentication attempts are rate-limited before bearer lookup', () => {
  const h = harness();
  try {
    h.service.rateLimiter = { consume: () => ({ allowed: false, retryAfterMs: 1_000 }) };
    assert.throws(() => h.service.authenticate({ peerAddress: '100.100.1.4', headers: {} }), error => error instanceof ApiError && error.code === 'rate_limited');
  } finally { h.close(); }
});

test('refresh rotates both tokens and reuse revokes the device sessions', () => {
  const h = harness();
  try {
    const refreshBody = { device_id: h.paired.device.id, refresh_token: h.paired.session.refresh_token };
    const first = h.service.refresh(signedRequest({
      privateKey: h.deviceKey.privateKey,
      method: 'POST',
      path: '/mobile/v1/session/refresh',
      body: refreshBody,
      now: h.now(),
    })).data;
    assert.notEqual(first.session.refresh_token, h.paired.session.refresh_token);
    assert.notEqual(first.session.access_token, h.paired.session.access_token);

    assert.throws(() => h.service.refresh(signedRequest({
      privateKey: h.deviceKey.privateKey,
      method: 'POST',
      path: '/mobile/v1/session/refresh',
      body: refreshBody,
      now: h.now(),
    })), error => error instanceof ApiError && error.code === 'refresh_reuse_detected');

    assert.throws(() => h.service.authenticate(signedRequest({
      token: first.session.access_token,
      privateKey: h.deviceKey.privateKey,
      now: h.now(),
    })), error => error instanceof ApiError && error.code === 'session_revoked');
  } finally { h.close(); }
});

test('read DTOs never expose desktop identifiers, account emails, or proxy internals', async () => {
  const h = harness();
  try {
    const devices = await h.service.devices({});
    const routes = await h.service.routes({});
    const serialized = JSON.stringify({ devices, routes });
    for (const forbidden of ['SERIAL-MUST-NOT-LEAK', '192.0.2.4:5555', 'owner@example.com', 'must-not-leak', '10.0.0.4']) {
      assert.equal(serialized.includes(forbidden), false, `mobile response leaked ${forbidden}`);
    }
  } finally { h.close(); }
});

test('Hermes-enabled upstream state fails closed', async () => {
  const upstream = new FakeUpstream();
  upstream.lab.hermes_enabled = true;
  const h = harness({ upstream });
  try {
    await assert.rejects(() => h.service.fleetSummary(), error => error instanceof ApiError && error.code === 'unsafe_upstream_state');
  } finally { h.close(); }
});

test('read-only default and viewer role both block writes', async () => {
  const readOnly = harness({ role: 'operator', writesEnabled: false, allowedActions: ['home'] });
  try {
    const identity = readOnly.authenticate();
    await assert.rejects(() => readOnly.service.submitCommand(identity, {
      action: 'home', target_device_ids: [1], parameters: {}, reason: 'owner requested', confirm: true, idempotency_key: crypto.randomUUID(),
    }, { 'x-xsalpha-confirmation': 'true' }), error => error instanceof ApiError && error.code === 'read_only_mode');
  } finally { readOnly.close(); }

  const viewer = harness({ role: 'viewer', writesEnabled: true, allowedActions: ['home'] });
  try {
    const identity = viewer.authenticate();
    await assert.rejects(() => viewer.service.submitCommand(identity, {
      action: 'home', target_device_ids: [1], parameters: {}, reason: 'owner requested', confirm: true, idempotency_key: crypto.randomUUID(),
    }, { 'x-xsalpha-confirmation': 'true' }), error => error instanceof ApiError && error.code === 'insufficient_role');
  } finally { viewer.close(); }
});

test('one fixed action executes once per idempotency key and rejects conflicts', async () => {
  const h = harness({ role: 'operator', writesEnabled: true, allowedActions: ['home', 'screen_on'] });
  try {
    const identity = h.authenticate();
    const idempotencyKey = crypto.randomUUID();
    const input = {
      action: 'home', target_device_ids: [1], parameters: {}, reason: 'owner requested', confirm: true, idempotency_key: idempotencyKey,
    };
    const first = await h.service.submitCommand(identity, input, { 'x-xsalpha-confirmation': 'true' });
    const second = await h.service.submitCommand(identity, input, { 'x-xsalpha-confirmation': 'true' });
    assert.equal(first.data.operation_id, second.data.operation_id);
    assert.equal(h.pending.length, 1);
    await h.pending[0]();
    assert.equal(h.upstream.calls.length, 1);
    assert.equal(h.upstream.calls[0].command, 'PRESS_HOME');
    assert.equal(h.service.operation(identity, first.data.operation_id).data.status, 'succeeded');

    await assert.rejects(() => h.service.submitCommand(identity, { ...input, action: 'screen_on' }, { 'x-xsalpha-confirmation': 'true' }), error => error instanceof ApiError && error.code === 'idempotency_conflict');
    await assert.rejects(() => h.service.submitCommand(identity, { ...input, reason: 'different request' }, { 'x-xsalpha-confirmation': 'true' }), error => error instanceof ApiError && error.code === 'idempotency_conflict');
  } finally { h.close(); }
});

test('raw or unsupported actions and unverified routes fail closed', async () => {
  const h = harness({ role: 'operator', writesEnabled: true, allowedActions: ['home'] });
  try {
    const identity = h.authenticate();
    const common = { target_device_ids: [1], parameters: {}, reason: 'owner requested', confirm: true, idempotency_key: crypto.randomUUID() };
    await assert.rejects(() => h.service.submitCommand(identity, { ...common, action: 'raw_adb', parameters: { command: 'shell id' } }, { 'x-xsalpha-confirmation': 'true' }), error => error instanceof ApiError && error.code === 'action_not_allowed');
    await assert.rejects(() => h.service.submitCommand(identity, { ...common, action: 'home', parameters: { command: 'shell id' }, idempotency_key: crypto.randomUUID() }, { 'x-xsalpha-confirmation': 'true' }), error => error instanceof ApiError && error.code === 'invalid_parameters');
    await assert.rejects(() => h.service.submitCommand(identity, { ...common, action: 'home', parameters: {}, unexpected: true, idempotency_key: crypto.randomUUID() }, { 'x-xsalpha-confirmation': 'true' }), error => error instanceof ApiError && error.code === 'invalid_request');
    h.upstream.routes[0].health_state = 'unverified';
    await assert.rejects(() => h.service.submitCommand(identity, { ...common, action: 'home', idempotency_key: crypto.randomUUID() }, { 'x-xsalpha-confirmation': 'true' }), error => error instanceof ApiError && error.code === 'route_unverified');
    const rejected = h.store.listAudit({ limit: 20 }).filter(event => event.operation === 'command.rejected');
    assert.equal(rejected.length, 4);
    assert.equal(rejected.every(event => event.result === 'rejected' && event.metadata.idempotency_key), true);
    assert.equal(rejected.some(event => event.metadata.code === 'invalid_parameters'), true);
  } finally { h.close(); }
});

test('interrupted operations fail closed during gateway recovery', async () => {
  const h = harness({ role: 'operator', writesEnabled: true, allowedActions: ['home'] });
  try {
    const identity = h.authenticate();
    const accepted = await h.service.submitCommand(identity, {
      action: 'home', target_device_ids: [1], parameters: {}, reason: 'owner requested', confirm: true, idempotency_key: crypto.randomUUID(),
    }, { 'x-xsalpha-confirmation': 'true' });
    assert.equal(accepted.data.status, 'accepted');
    assert.equal(h.store.recoverInterruptedOperations(), 1);
    const recovered = h.service.operation(identity, accepted.data.operation_id).data;
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.result.code, 'gateway_restarted');
  } finally { h.close(); }
});

test('administrator emergency stop requires and consumes a biometric step-up token', async () => {
  const h = harness({ role: 'administrator', writesEnabled: true });
  try {
    const identity = h.authenticate();
    const challenge = h.service.createStepUpChallenge(identity, { action: 'emergency_stop', target_device_ids: [] }).data;
    const stepUpSignature = sign(h.stepUpKey.privateKey, canonicalStepUp(
      challenge.challenge_id,
      challenge.challenge,
      'emergency_stop',
      []
    ));
    const completed = h.service.completeStepUp(identity, {
      challenge_id: challenge.challenge_id,
      challenge: challenge.challenge,
      action: challenge.action,
      target_device_ids: challenge.target_device_ids,
      step_up_signature: stepUpSignature,
    }).data;
    const input = {
      target_device_ids: [], reason: 'owner emergency stop', confirm: true, idempotency_key: crypto.randomUUID(),
    };
    const accepted = await h.service.emergencyStop(identity, input, {
      'x-xsalpha-confirmation': 'true',
      'x-xsalpha-step-up-token': completed.step_up_token,
    });
    assert.equal(accepted.data.status, 'accepted');
    assert.equal(h.pending.length, 1);
    await h.pending[0]();
    assert.equal(h.upstream.calls[0].type, 'emergency_stop');
    assert.equal(h.service.operation(identity, accepted.data.operation_id).data.status, 'succeeded');

    await assert.rejects(() => h.service.emergencyStop(identity, { ...input, idempotency_key: crypto.randomUUID() }, {
      'x-xsalpha-confirmation': 'true',
      'x-xsalpha-step-up-token': completed.step_up_token,
    }), error => error instanceof ApiError && error.code === 'step_up_required');
  } finally { h.close(); }
});
