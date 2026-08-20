const assert = require('node:assert/strict');
const test = require('node:test');

const proxyOrchControl = require('../server/proxy_orch_control');

test('Proxy Orch control adapter accepts only private endpoints and a local token-file reference', () => {
  const config = proxyOrchControl.configuration({
    MCP_PROXY_ORCH_CONTROL_URL: 'http://192.168.50.10:9000',
    MCP_PROXY_ORCH_CONTROL_TOKEN_FILE: 'C:\\restricted\\proxy-orch-control.token',
  });
  assert.equal(config.baseUrl.hostname, '192.168.50.10');
  assert.equal(config.tokenFile, 'C:\\restricted\\proxy-orch-control.token');

  assert.throws(() => proxyOrchControl.configuration({
    MCP_PROXY_ORCH_CONTROL_URL: 'https://example.com',
    MCP_PROXY_ORCH_CONTROL_TOKEN_FILE: 'C:\\restricted\\proxy-orch-control.token',
  }), /private or loopback/);
  assert.throws(() => proxyOrchControl.configuration({
    MCP_PROXY_ORCH_CONTROL_URL: 'http://127.0.0.1:9000',
  }), /TOKEN_FILE/);
});
