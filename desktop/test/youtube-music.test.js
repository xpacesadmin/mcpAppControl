const assert = require('node:assert/strict');
const test = require('node:test');

const K = require('../adb/ui-kit');
const mediaSession = require('../adb/media_session');
const ytmusic = require('../adb/ytmusic');

function node(text, desc, cy, { clickable = false } = {}) {
  return {
    text: text || '', desc: desc || '', clickable,
    clase: 'android.widget.TextView',
    bounds: { x1: 0, y1: cy - 20, x2: 500, y2: cy + 20 },
    cx: 250, cy,
  };
}

test('YT Music validates ordered artist/title pairs and optional canonical URLs', () => {
  const tracks = ytmusic.parseTracks([
    { artist: 'Beyoncé', title: 'Déjà Vu' },
    { artist: 'AC/DC', title: 'Hells Bells', url: 'https://music.youtube.com/watch?v=abc123' },
  ]);
  assert.deepEqual(tracks, [
    { artist: 'Beyoncé', title: 'Déjà Vu' },
    { artist: 'AC/DC', title: 'Hells Bells', url: 'https://music.youtube.com/watch?v=abc123' },
  ]);
  assert.throws(() => ytmusic.parseTracks([{ artist: 'Only artist', title: '' }]), /artista y título/i);
  assert.throws(() => ytmusic.parseTracks([
    { artist: 'Artist', title: 'Song' },
    { artist: 'artist', title: 'song' },
  ]), /duplicada/i);
  assert.throws(() => ytmusic.parseTracks([
    { artist: 'Artist', title: 'Song', url: 'https://example.com/watch?v=x' },
  ]), /music\.youtube\.com/i);
});

test('YT Music exact matcher requires both title and artist and fails ambiguous rows closed', () => {
  const rows = [
    node('Halo', '', 200), node('Beyoncé', '', 210), node('', 'More options', 205, { clickable: true }),
    node('Halo', '', 500), node('Machine Head', '', 510), node('', 'More options', 505, { clickable: true }),
  ];
  const exact = ytmusic.exactTrackRows(rows, { artist: 'Beyoncé', title: 'Halo' });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].titleNode.cy, 200);
  assert.equal(ytmusic.exactTrackRows(rows, { artist: 'Unknown', title: 'Halo' }).length, 0);

  const ambiguous = rows.concat([
    node('Halo', '', 800), node('Beyoncé', '', 810), node('', 'More options', 805, { clickable: true }),
  ]);
  assert.equal(ytmusic.exactTrackRows(ambiguous, { artist: 'Beyoncé', title: 'Halo' }).length, 2);
});

function foregroundDump(packageName) {
  return `topResumedActivity=ActivityRecord{ u0 ${packageName}/.MainActivity t1 }`;
}

function mediaDump(packageName, state, metadata = 'private title') {
  return [
    `Media button session is ${packageName}/session (userId=0)`,
    `  package=${packageName}`,
    `  state=PlaybackState {state=${state}, position=123}`,
    `  metadata: title=${metadata}`,
  ].join('\n');
}

function playbackContext(options) {
  const { foreground, owner = foreground, states = [3] } = options;
  const foregrounds = options.foregrounds || [foreground];
  const owners = options.owners || [owner];
  const calls = [];
  let foregroundRead = 0;
  let sessionRead = 0;
  return {
    calls,
    ctx: {
      shell: async (_serial, args) => {
        calls.push(args);
        if (args[0] === 'dumpsys' && args[1] === 'activity') {
          const packageName = foregrounds[Math.min(foregroundRead++, foregrounds.length - 1)];
          return foregroundDump(packageName);
        }
        if (args[0] === 'dumpsys' && args[1] === 'media_session') {
          const index = sessionRead++;
          const state = states[Math.min(index, states.length - 1)];
          const packageName = owners[Math.min(index, owners.length - 1)];
          return mediaDump(packageName, state);
        }
        return '';
      },
      sleep: async () => {},
    },
  };
}

test('MEDIA_RESUME_IF_PAUSED is a no-op while already playing', async () => {
  const fixture = playbackContext({ foreground: 'com.google.android.apps.youtube.music', states: [3] });
  const result = await mediaSession.run(fixture.ctx, 'device-1', 'MEDIA_RESUME_IF_PAUSED');
  assert.equal(result.success, true);
  assert.equal(result.data.handled, false);
  assert.equal(result.data.reason, 'already_playing');
  assert.equal(fixture.calls.some(args => args.join(' ') === 'cmd media_session dispatch play'), false);
});

test('MEDIA_RESUME_IF_PAUSED targets Spotify without touching a different visible app', async () => {
  const fixture = playbackContext({ foreground: 'com.google.android.apps.youtube.music', states: [2] });
  const result = await mediaSession.run(fixture.ctx, 'device-1', 'MEDIA_RESUME_IF_PAUSED', {
    target_package: 'com.spotify.music',
  });
  assert.equal(result.data.reason, 'target_not_foreground');
  assert.equal(fixture.calls.some(args => args[0] === 'cmd' || args[0] === 'input'), false);

  const spotify = playbackContext({ foreground: 'com.spotify.music', states: [2, 3] });
  const played = await mediaSession.run(spotify.ctx, 'device-2', 'MEDIA_RESUME_IF_PAUSED', {
    target_package: 'com.spotify.music',
  });
  assert.equal(played.success, true);
  assert.equal(played.data.verified_playback_state, 3);
});

test('MEDIA_RESUME_IF_PAUSED resumes only paused allowlisted owner and verifies playing without metadata', async () => {
  const fixture = playbackContext({ foreground: 'com.google.android.youtube', states: [2, 3] });
  const result = await mediaSession.run(fixture.ctx, 'device-1', 'MEDIA_RESUME_IF_PAUSED');
  assert.equal(result.success, true);
  assert.equal(result.data.handled, true);
  assert.equal(result.data.playback_state, 2);
  assert.equal(result.data.verified_playback_state, 3);
  assert.equal(result.data.method, 'cmd_media_session_play');
  assert.equal(fixture.calls.filter(args => args.join(' ') === 'cmd media_session dispatch play').length, 1);
  assert.equal(JSON.stringify(result).includes('private title'), false);
});

test('MEDIA_RESUME_IF_PAUSED uses KEYCODE_MEDIA_PLAY only when cmd leaves the same session paused', async () => {
  const fixture = playbackContext({ foreground: 'com.google.android.apps.youtube.music', states: [2, 2, 3] });
  const result = await mediaSession.run(fixture.ctx, 'device-1', 'MEDIA_RESUME_IF_PAUSED');
  assert.equal(result.success, true);
  assert.equal(result.data.handled, true);
  assert.equal(result.data.method, 'keycode_media_play');
  assert.deepEqual(result.data.attempted_methods, ['cmd_media_session_play', 'keycode_media_play']);
  assert.equal(fixture.calls.filter(args => args.join(' ') === 'cmd media_session dispatch play').length, 1);
  assert.equal(fixture.calls.filter(args => args.join(' ') === 'input keyevent 126').length, 1);
  assert.equal(fixture.calls.some(args => args.includes('85') || args.includes('87')), false);
});

test('MEDIA_RESUME_IF_PAUSED fails closed without key fallback when owner or state changes', async t => {
  await t.test('owner changes', async () => {
    const fixture = playbackContext({
      foreground: 'com.google.android.apps.youtube.music',
      owners: ['com.google.android.apps.youtube.music', 'com.google.android.youtube'],
      states: [2, 2],
    });
    const result = await mediaSession.run(fixture.ctx, 'device-1', 'MEDIA_RESUME_IF_PAUSED');
    assert.equal(result.success, false);
    assert.equal(result.data.reason, 'resume_context_changed');
    assert.equal(fixture.calls.some(args => args.join(' ') === 'input keyevent 126'), false);
  });
  await t.test('state is no longer paused', async () => {
    const fixture = playbackContext({ foreground: 'com.google.android.apps.youtube.music', states: [2, 1] });
    const result = await mediaSession.run(fixture.ctx, 'device-1', 'MEDIA_RESUME_IF_PAUSED');
    assert.equal(result.success, false);
    assert.equal(result.data.reason, 'resume_not_verified');
    assert.equal(fixture.calls.some(args => args.join(' ') === 'input keyevent 126'), false);
  });
});

test('MEDIA_RESUME_IF_PAUSED rejects owner mismatch and disallowed foreground without action', async t => {
  await t.test('owner mismatch', async () => {
    const fixture = playbackContext({
      foreground: 'com.google.android.apps.youtube.music',
      owner: 'com.google.android.youtube',
      states: [2],
    });
    const result = await mediaSession.run(fixture.ctx, 'device-1', 'MEDIA_RESUME_IF_PAUSED');
    assert.equal(result.data.reason, 'session_owner_mismatch');
    assert.equal(fixture.calls.some(args => args[0] === 'cmd'), false);
  });
  await t.test('disallowed foreground', async () => {
    const fixture = playbackContext({ foreground: 'com.android.chrome', states: [2] });
    const result = await mediaSession.run(fixture.ctx, 'device-1', 'MEDIA_RESUME_IF_PAUSED');
    assert.equal(result.data.reason, 'foreground_not_allowlisted');
    assert.equal(fixture.calls.some(args => args[0] === 'cmd'), false);
  });
});

test('YT Music inactivity handler ignores generic Yes outside the exact prompt', async t => {
  const original = K.makeUi;
  K.makeUi = () => ({
    dump: async () => [node('Would you like updates?', '', 200), node('Yes', '', 300, { clickable: true })],
  });
  t.after(() => { K.makeUi = original; });
  const fixture = playbackContext({ foreground: 'com.google.android.apps.youtube.music', states: [3] });
  const result = await ytmusic.run(fixture.ctx, 'device-1', 'YTMUSIC_HANDLE_INACTIVITY_PROMPT', {});
  assert.equal(result.success, true);
  assert.equal(result.data.handled, false);
  assert.equal(result.data.reason, 'prompt_absent');
  assert.equal(result.data.prompt_detected, false);
});

test('YT Music inactivity handler preserves exact prompt detection but sends Play and never Next', async t => {
  const original = K.makeUi;
  const taps = [];
  K.makeUi = () => ({
    dump: async () => [
      node('Video paused. Continue watching?', '', 200),
      node('Yes', '', 300, { clickable: true }),
    ],
    tapXY: async (...args) => taps.push(args),
  });
  t.after(() => { K.makeUi = original; });
  const fixture = playbackContext({ foreground: 'com.google.android.apps.youtube.music', states: [2, 3] });
  const result = await ytmusic.run(fixture.ctx, 'device-1', 'YTMUSIC_HANDLE_INACTIVITY_PROMPT', {});
  assert.equal(result.success, true);
  assert.equal(result.data.handled, true);
  assert.equal(result.data.prompt_detected, true);
  assert.equal(result.data.prompt_tapped, true);
  assert.equal(result.data.ui_status, 'prompt_detected');
  assert.equal(taps.length, 1);
  assert.equal(fixture.calls.filter(args => args.join(' ') === 'cmd media_session dispatch play').length, 1);
  assert.equal(fixture.calls.some(args => args.includes('87') || args.includes('MEDIA_NEXT')), false);
});

test('YT Music inactivity handler counts prompt tap as handled when it restores playing before dispatch', async t => {
  const original = K.makeUi;
  const taps = [];
  K.makeUi = () => ({
    dump: async () => [
      node('Video paused. Continue watching?', '', 200),
      node('Yes', '', 300, { clickable: true }),
    ],
    tapXY: async (...args) => taps.push(args),
  });
  t.after(() => { K.makeUi = original; });
  const fixture = playbackContext({ foreground: 'com.google.android.apps.youtube.music', states: [3] });
  const result = await ytmusic.run(fixture.ctx, 'device-1', 'YTMUSIC_HANDLE_INACTIVITY_PROMPT', {});
  assert.equal(result.success, true);
  assert.equal(result.data.handled, true);
  assert.equal(result.data.detected, true);
  assert.equal(result.data.reason, 'prompt_handled');
  assert.equal(result.data.media_reason, 'already_playing');
  assert.equal(taps.length, 1);
  assert.equal(fixture.calls.some(args => args.join(' ') === 'cmd media_session dispatch play'), false);
});

test('YT Music inactivity handler falls back to media session when UI is unavailable', async t => {
  const original = K.makeUi;
  K.makeUi = () => ({ dump: async () => [] });
  t.after(() => { K.makeUi = original; });
  const fixture = playbackContext({ foreground: 'com.google.android.apps.youtube.music', states: [2, 3] });
  const result = await ytmusic.run(fixture.ctx, 'device-1', 'YTMUSIC_HANDLE_INACTIVITY_PROMPT', {});
  assert.equal(result.success, true);
  assert.equal(result.data.handled, true);
  assert.equal(result.data.ui_status, 'ui_unavailable');
  assert.equal(result.data.prompt_detected, false);
  assert.equal(fixture.calls.filter(args => args.join(' ') === 'cmd media_session dispatch play').length, 1);
});
