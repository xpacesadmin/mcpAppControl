'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const androidRoot = path.join(repositoryRoot, 'mobile-console');

function read(relativePath) {
  return fs.readFileSync(path.join(androidRoot, relativePath), 'utf8');
}

function allSource() {
  const root = path.join(androidRoot, 'app', 'src', 'main');
  const files = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return files.join('\n');
}

test('Android manifest has only network permissions and disables cleartext and backup', () => {
  const manifest = read('app/src/main/AndroidManifest.xml');
  const permissions = [...manifest.matchAll(/uses-permission android:name="([^"]+)"/g)].map(match => match[1]).sort();
  assert.deepEqual(permissions, [
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.INTERNET',
  ]);
  assert.match(manifest, /android:usesCleartextTraffic="false"/);
  assert.match(manifest, /android:allowBackup="false"/);
  for (const forbidden of ['BIND_ACCESSIBILITY_SERVICE', 'FOREGROUND_SERVICE', 'READ_CONTACTS', 'READ_SMS', 'WRITE_SETTINGS', 'USB_PERMISSION']) {
    assert.equal(manifest.includes(forbidden), false);
  }
});

test('Android source has no embedded endpoint, desktop token, ADB, or Hermes integration', () => {
  const source = allSource();
  for (const forbidden of [
    '127.0.0.1:8733',
    ':6011',
    ':5555',
    '0.0.0.0',
    'MCP_HERMES',
    'desktop bearer',
    'proxy password',
  ]) {
    assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, `Android source contains forbidden value: ${forbidden}`);
  }
});

test('Android requests require an active VPN and sensitive windows block capture', () => {
  const gate = read('app/src/main/java/com/xsalpha/fleetconsole/network/VpnNetworkGate.kt');
  const api = read('app/src/main/java/com/xsalpha/fleetconsole/network/GatewayApi.kt');
  const activity = read('app/src/main/java/com/xsalpha/fleetconsole/MainActivity.kt');
  assert.match(gate, /TRANSPORT_VPN/);
  assert.match(gate, /NET_CAPABILITY_INTERNET/);
  assert.match(api, /requirePrivateVpn\(\)/);
  assert.match(activity, /FLAG_SECURE/);
});

test('mobile command map excludes engagement and arbitrary execution primitives', () => {
  const service = fs.readFileSync(path.join(repositoryRoot, 'mobile-gateway', 'src', 'service.js'), 'utf8');
  for (const forbidden of ['like', 'comment', 'follow', 'tap_xy', 'swipe', 'type_text', 'shell', 'raw_adb', 'workflow_json']) {
    assert.equal(new RegExp(`['\"]${forbidden}['\"]`, 'i').test(service), false, `command map contains ${forbidden}`);
  }
});
