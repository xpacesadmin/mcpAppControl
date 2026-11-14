'use strict';

const { ipInAnyCidr, stripAddressDecorations } = require('./cidr');
const { ApiError } = require('./service');
const { UpstreamError } = require('./upstream');

function sendJson(res, status, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Strict-Transport-Security': 'max-age=31536000',
    ...headers,
  });
  res.end(body);
}

async function readBody(req, maximumBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maximumBytes) throw new ApiError(413, 'body_too_large', 'Request body exceeds the gateway limit');
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);
  if (!rawBody.length) return { rawBody, body: {} };
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new ApiError(415, 'json_required', 'Content-Type application/json is required');
  try { return { rawBody, body: JSON.parse(rawBody.toString('utf8')) }; }
  catch (_) { throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON'); }
}

function queryObject(url) {
  const result = {};
  for (const [key, value] of url.searchParams) {
    if (!(key in result)) result[key] = value;
  }
  return result;
}

function createHandler({ service, config, logger = console }) {
  return async function handle(req, res) {
    const peerAddress = stripAddressDecorations(req.socket.remoteAddress || '');
    if (!peerAddress || !ipInAnyCidr(peerAddress, config.vpnCidrs)) {
      req.socket.destroy();
      return;
    }

    let url;
    try { url = new URL(req.url, 'https://mobile-gateway.invalid'); }
    catch (_) { return sendJson(res, 400, { error: { code: 'invalid_url', message: 'Request URL is invalid' } }); }
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') return sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Browser CORS access is not supported' } });

    try {
      const parsed = await readBody(req, config.maxBodyBytes);
      if ((method === 'GET' || method === 'HEAD') && parsed.rawBody.length) {
        throw new ApiError(400, 'body_not_allowed', 'Read requests must not include a body');
      }
      const request = {
        method,
        pathWithQuery: req.url,
        path: url.pathname,
        query: queryObject(url),
        headers: req.headers,
        peerAddress,
        rawBody: parsed.rawBody,
        body: parsed.body,
      };

      if (method === 'GET' && url.pathname === '/up') {
        return sendJson(res, 200, { status: 'ok', service: 'xsalpha-mobile-gateway', mode: config.writesEnabled ? 'scoped-writes' : 'read-only' });
      }
      if (!url.pathname.startsWith('/mobile/v1/')) throw new ApiError(404, 'not_found', 'Route was not found');

      if (method === 'POST' && url.pathname === '/mobile/v1/pair/complete') {
        return sendJson(res, 201, service.pairComplete(request));
      }
      if (method === 'POST' && url.pathname === '/mobile/v1/session/refresh') {
        return sendJson(res, 200, service.refresh(request));
      }

      const identity = service.authenticate(request);
      if (method === 'POST' && url.pathname === '/mobile/v1/session/logout') {
        return sendJson(res, 200, service.logout(identity));
      }
      if (method === 'GET' && url.pathname === '/mobile/v1/me') {
        return sendJson(res, 200, service.me(identity));
      }
      if (method === 'GET' && url.pathname === '/mobile/v1/fleet/summary') {
        return sendJson(res, 200, await service.fleetSummary());
      }
      if (method === 'GET' && url.pathname === '/mobile/v1/devices') {
        return sendJson(res, 200, await service.devices(request.query));
      }
      const deviceMatch = url.pathname.match(/^\/mobile\/v1\/devices\/(\d+)$/);
      if (method === 'GET' && deviceMatch) {
        return sendJson(res, 200, await service.device(Number(deviceMatch[1])));
      }
      const accountMatch = url.pathname.match(/^\/mobile\/v1\/devices\/(\d+)\/account-health$/);
      if (method === 'GET' && accountMatch) {
        return sendJson(res, 200, await service.accountHealth(Number(accountMatch[1])));
      }
      if (method === 'GET' && url.pathname === '/mobile/v1/routes') {
        return sendJson(res, 200, await service.routes(request.query));
      }
      if (method === 'GET' && url.pathname === '/mobile/v1/automations') {
        return sendJson(res, 200, await service.automations());
      }
      if (method === 'GET' && url.pathname === '/mobile/v1/activity') {
        return sendJson(res, 200, await service.activity(request.query));
      }
      if (method === 'GET' && url.pathname === '/mobile/v1/alerts') {
        return sendJson(res, 200, await service.alerts(request.query));
      }
      if (method === 'GET' && url.pathname === '/mobile/v1/audit') {
        return sendJson(res, 200, await service.audit(request.query));
      }
      if (method === 'POST' && url.pathname === '/mobile/v1/session/step-up/challenge') {
        return sendJson(res, 201, service.createStepUpChallenge(identity, request.body));
      }
      if (method === 'POST' && url.pathname === '/mobile/v1/session/step-up/complete') {
        return sendJson(res, 200, service.completeStepUp(identity, request.body));
      }
      if (method === 'POST' && url.pathname === '/mobile/v1/commands') {
        return sendJson(res, 202, await service.submitCommand(identity, request.body, request.headers));
      }
      const operationMatch = url.pathname.match(/^\/mobile\/v1\/operations\/([0-9a-f-]{36})$/i);
      if (method === 'GET' && operationMatch) {
        return sendJson(res, 200, service.operation(identity, operationMatch[1]));
      }
      if (method === 'POST' && url.pathname === '/mobile/v1/emergency-stop') {
        return sendJson(res, 202, await service.emergencyStop(identity, request.body, request.headers));
      }
      if (method === 'POST' && url.pathname === '/mobile/v1/resume') {
        return sendJson(res, 202, await service.resume(identity, request.body, request.headers));
      }
      if (method === 'POST' && /^\/mobile\/v1\/devices\/\d+\/stream-ticket$/.test(url.pathname)) {
        throw new ApiError(423, 'phase_not_enabled', 'Live view is not enabled in the read-only canary build');
      }
      throw new ApiError(404, 'not_found', 'Route was not found');
    } catch (error) {
      const known = error instanceof ApiError || error instanceof UpstreamError;
      const status = known ? Number(error.status || 500) : 500;
      const code = known ? error.code : 'internal_error';
      const message = known ? error.message : 'The gateway could not complete the request';
      if (!known) logger.error?.('[mobile-gateway] request failed', { code: error?.code || error?.name || 'Error' });
      const extraHeaders = error?.details?.retry_after_seconds
        ? { 'Retry-After': String(error.details.retry_after_seconds) }
        : {};
      return sendJson(res, status, {
        error: {
          code,
          message,
          ...(error?.details ? { details: error.details } : {}),
        },
        server_time: new Date().toISOString(),
      }, extraHeaders);
    }
  };
}

module.exports = { createHandler, readBody, sendJson };
