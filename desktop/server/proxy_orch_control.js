const fs = require('fs');
const path = require('path');

const PRIVATE_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[?::1\]?)$/i;

function configuration(env = process.env) {
  const baseUrl = String(env.MCP_PROXY_ORCH_CONTROL_URL || '').trim();
  const tokenFile = String(env.MCP_PROXY_ORCH_CONTROL_TOKEN_FILE || '').trim();
  if (!baseUrl) throw new Error('MCP_PROXY_ORCH_CONTROL_URL is not configured');
  if (!tokenFile) throw new Error('MCP_PROXY_ORCH_CONTROL_TOKEN_FILE is not configured');
  if (!path.isAbsolute(tokenFile)) throw new Error('Proxy Orch control token file must be an absolute path');
  const parsed = new URL(baseUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Proxy Orch control URL must use HTTP or HTTPS');
  if (!PRIVATE_HOST_RE.test(parsed.hostname)) throw new Error('Proxy Orch control URL must target a private or loopback host');
  return { baseUrl: parsed, tokenFile };
}

function readControlToken(tokenFile) {
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!token) throw new Error('Proxy Orch control token file is empty');
  return token;
}

async function requestRotation(input = {}, env = process.env) {
  const routeId = String(input.route_id || '').trim();
  const deviceId = Number(input.device_id);
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(routeId)) throw new Error('Invalid route_id');
  if (!Number.isInteger(deviceId) || deviceId <= 0) throw new Error('Invalid device_id');

  const { baseUrl, tokenFile } = configuration(env);
  const endpoint = new URL(`/api/v1/proxy-routes/${encodeURIComponent(routeId)}/rotate`, baseUrl);
  const token = readControlToken(tokenFile);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-idempotency-key': String(input.idempotency_key || ''),
    },
    body: JSON.stringify({ device_id: deviceId, request_id: input.idempotency_key || null }),
    signal: AbortSignal.timeout(Math.min(30000, Math.max(1000, Number(input.timeout_ms) || 10000))),
  });
  if (!response.ok) throw new Error(`Proxy Orch rotation request failed (HTTP ${response.status})`);

  let payload = {};
  try { payload = await response.json(); } catch (_) {}
  return {
    accepted: true,
    status: response.status,
    request_id: payload.request_id || input.idempotency_key || null,
  };
}

module.exports = { configuration, requestRotation };
