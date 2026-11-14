'use strict';

const crypto = require('node:crypto');

function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(String(value || ''))) throw new Error('Invalid base64url value');
  return Buffer.from(String(value), 'base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken(bytes = 32) {
  return base64Url(crypto.randomBytes(bytes));
}

function tokenHash(token) {
  return sha256(String(token || ''));
}

function bodyHash(bodyBuffer) {
  return sha256(bodyBuffer || Buffer.alloc(0));
}

function importEcPublicKey(publicKeyPem) {
  const source = String(publicKeyPem || '');
  if (source.length < 80 || source.length > 2048 || !source.includes('BEGIN PUBLIC KEY')) {
    throw new Error('A PEM-encoded public key is required');
  }
  const key = crypto.createPublicKey(source);
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('Only ECDSA P-256 public keys are accepted');
  }
  return key;
}

function verifyEcSignature(publicKeyPem, canonicalValue, signatureBase64Url) {
  const key = importEcPublicKey(publicKeyPem);
  const signature = decodeBase64Url(signatureBase64Url);
  return crypto.verify('sha256', Buffer.from(canonicalValue, 'utf8'), key, signature);
}

function canonicalRequest(method, pathWithQuery, timestamp, nonce, rawBody) {
  return [
    'XSALPHA_REQUEST_V1',
    String(method || '').toUpperCase(),
    String(pathWithQuery || ''),
    String(timestamp || ''),
    String(nonce || ''),
    bodyHash(rawBody),
  ].join('\n');
}

function canonicalPairing(code, deviceName, timestamp) {
  return ['XSALPHA_PAIR_V1', String(code || ''), String(deviceName || ''), String(timestamp || '')].join('\n');
}

function canonicalStepUp(challengeId, challenge, action, targetDeviceIds) {
  const targets = [...new Set((targetDeviceIds || []).map(Number))].sort((a, b) => a - b).join(',');
  return ['XSALPHA_STEP_UP_V1', challengeId, challenge, action, targets].join('\n');
}

module.exports = {
  base64Url,
  decodeBase64Url,
  sha256,
  randomToken,
  tokenHash,
  bodyHash,
  importEcPublicKey,
  verifyEcSignature,
  canonicalRequest,
  canonicalPairing,
  canonicalStepUp,
};

