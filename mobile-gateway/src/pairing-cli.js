'use strict';

const { loadConfig } = require('./config');
const { MobileStore } = require('./store');

function main(argv = process.argv.slice(2)) {
  process.umask?.(0o077);
  const config = loadConfig(process.env);
  const store = new MobileStore(config.databaseFile);
  try {
    const command = argv[0];
    if (command === 'create') {
      const role = argv[1] || 'viewer';
      const ttlSeconds = argv[2] ? Number(argv[2]) : 300;
      const result = store.createPairingCode({ role, ttlSeconds });
      console.log('Single-use pairing code (do not paste into chat or logs):');
      console.log(result.code);
      console.log(`Role: ${result.role}`);
      console.log(`Expires: ${result.expires_at}`);
      return;
    }
    if (command === 'revoke-all') {
      const count = store.revokeAllSessions('local_administrator_revoke_all');
      store.audit({ role: 'administrator', operation: 'session.revoke_all', result: 'ok', metadata: { count } });
      console.log(`Revoked ${count} active mobile session(s).`);
      return;
    }
    throw new Error('Usage: node src/pairing-cli.js create [viewer|operator|administrator] [ttlSeconds] | revoke-all');
  } finally {
    store.close();
  }
}

if (require.main === module) {
  try { main(); }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { main };

