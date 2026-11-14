'use strict';

const fs = require('node:fs');
const https = require('node:https');
const { loadConfig } = require('./config');
const { MobileStore } = require('./store');
const { DesktopClient, tokenFromFile } = require('./upstream');
const { GatewayService } = require('./service');
const { createHandler } = require('./http');

function main() {
  process.umask?.(0o077);
  const config = loadConfig(process.env);
  const store = new MobileStore(config.databaseFile);
  const upstream = new DesktopClient({
    baseUrl: config.desktopBaseUrl,
    tokenProvider: tokenFromFile(config.desktopTokenFile),
    timeoutMs: config.upstreamTimeoutMs,
  });
  const service = new GatewayService({ config, store, upstream });
  const server = https.createServer({
    cert: fs.readFileSync(config.tlsCertFile),
    key: fs.readFileSync(config.tlsKeyFile),
    minVersion: 'TLSv1.3',
  }, createHandler({ service, config }));

  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.listen(config.port, config.bindHost, () => {
    console.log(`[mobile-gateway] listening on approved VPN interface ${config.bindHost}:${config.port} (${config.writesEnabled ? 'scoped writes' : 'read-only'})`);
  });

  const shutdown = signal => {
    console.log(`[mobile-gateway] ${signal}; closing`);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(`[mobile-gateway] startup refused: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main };

