const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const dbServer = require('../server/db');
const labControl = require('../server/lab_control');
const reviewQueue = require('../server/youtube_music_review_queue');

async function fixture(random = () => 0) {
  const db = await dbServer.open(':memory:');
  labControl.init(db);
  labControl.configure({
    confirm: true,
    lab_mode_enabled: false,
    hermes_enabled: false,
    idempotency_key: `review-test-lab-${Math.random()}`,
  });
  const stamp = dbServer.now();
  db.run(
    `INSERT INTO devices(name,serial_number,adb_serial,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?)`,
    ['Fleet 1', 'FLEET_01', '192.168.60.199:5555', 'online', stamp, stamp],
  );
  reviewQueue.init(db, { random });
  return db;
}

function addDevice(db, id, name) {
  const stamp = dbServer.now();
  db.run(
    `INSERT INTO devices(id,name,serial_number,adb_serial,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)`,
    [id, name, `FLEET_${String(id).padStart(2, '0')}`, `192.168.60.${198 + id}:5555`, 'online', stamp, stamp],
  );
}

test('YT Music review queue generates suggestions without any execution path and requires explicit approval', async t => {
  const db = await fixture(() => 0);
  t.after(() => db.close());

  const configured = reviewQueue.configure({
    device_ids: [1],
    like_candidate_probability: 1,
    comment_candidate_probability: 1,
    cooldown_seconds: 60,
    comment_drafts: ['Thoughtful draft'],
    confirm: true,
    idempotency_key: 'review-config-1',
  });
  assert.equal(configured.safety_mode, 'manual_review_only');
  assert.equal(configured.device_actions_enabled, false);

  const observed = reviewQueue.observe({
    device_id: 1,
    track_artist: 'Artist',
    track_title: 'Song',
    observation_key: 'observation-1',
    source: 'test-observer',
  });
  assert.deepEqual(observed.candidates.map(item => item.candidate_type).sort(), ['comment', 'like']);
  assert.ok(observed.candidates.every(item => item.manual_action_only));
  assert.equal(db.get('SELECT COUNT(*) AS count FROM youtube_music_review_candidates').count, 2);

  const replay = reviewQueue.observe({
    device_id: 1,
    track_artist: 'Changed artist must not resample',
    observation_key: 'observation-1',
  });
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.candidates.length, 2);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM youtube_music_review_candidates').count, 2);

  const like = observed.candidates.find(item => item.candidate_type === 'like');
  assert.throws(() => reviewQueue.approve(like.id, {}), /confirm=true/);
  const approved = reviewQueue.approve(like.id, {
    confirm: true,
    actor: 'test-operator',
    review_note: 'Reviewed for manual handling',
    idempotency_key: 'review-approve-1',
  });
  assert.equal(approved.status, 'approved_manual');
  assert.equal(approved.reviewed_by, 'test-operator');
  assert.throws(
    () => reviewQueue.approve(like.id, { confirm: true, idempotency_key: 'review-approve-2' }),
    /ya fue revisado/,
  );

  const audit = db.get(
    "SELECT details FROM audit_events WHERE operation='youtube_music.review_queue.approve' ORDER BY id DESC LIMIT 1",
  );
  assert.equal(JSON.parse(audit.details).device_command_dispatched, false);
  assert.equal(reviewQueue.exportApproved().items.length, 1);
});

test('YT Music review queue supports draft editing, dismissal, cooldown, and idempotent probability misses', async t => {
  const db = await fixture(() => 0);
  t.after(() => db.close());

  reviewQueue.configure({
    device_ids: [1],
    like_candidate_probability: 0,
    comment_candidate_probability: 1,
    cooldown_seconds: 600,
    comment_drafts: ['Initial draft'],
    confirm: true,
    idempotency_key: 'review-config-2',
  });
  const first = reviewQueue.observe({
    device_id: 1,
    track_title: 'First song',
    observation_key: 'observation-2',
  });
  assert.equal(first.candidates.length, 1);
  const edited = reviewQueue.editDraft(first.candidates[0].id, {
    confirm: true,
    comment_draft: 'Edited, still manual',
    idempotency_key: 'review-edit-1',
  });
  assert.equal(edited.comment_draft, 'Edited, still manual');
  const dismissed = reviewQueue.dismiss(edited.id, {
    confirm: true,
    actor: 'test-operator',
    idempotency_key: 'review-dismiss-1',
  });
  assert.equal(dismissed.status, 'dismissed');

  const cooldown = reviewQueue.observe({
    device_id: 1,
    track_title: 'Second song',
    observation_key: 'observation-3',
  });
  assert.equal(cooldown.candidates.length, 0);
  assert.ok(cooldown.skipped.some(item => item.type === 'comment' && item.reason === 'cooldown'));

  reviewQueue.configure({
    device_ids: [1],
    like_candidate_probability: 0,
    comment_candidate_probability: 0,
    cooldown_seconds: 60,
    comment_drafts: [],
    confirm: true,
    idempotency_key: 'review-config-3',
  });
  const miss = reviewQueue.observe({
    device_id: 1,
    track_title: 'No candidate song',
    observation_key: 'observation-miss',
  });
  assert.equal(miss.candidates.length, 0);

  reviewQueue.configure({
    device_ids: [1],
    like_candidate_probability: 1,
    comment_candidate_probability: 0,
    cooldown_seconds: 60,
    comment_drafts: [],
    confirm: true,
    idempotency_key: 'review-config-4',
  });
  const missReplay = reviewQueue.observe({
    device_id: 1,
    track_title: 'Retry must not resample',
    observation_key: 'observation-miss',
  });
  assert.equal(missReplay.idempotent_replay, true);
  assert.equal(missReplay.candidates.length, 0);
});

test('observation replay is keyed by device and scope is checked before replay', async t => {
  const db = await fixture(() => 0);
  t.after(() => db.close());
  addDevice(db, 2, 'Fleet 2');

  reviewQueue.configure({
    device_ids: [1, 2],
    like_candidate_probability: 1,
    comment_candidate_probability: 0,
    cooldown_seconds: 60,
    comment_drafts: [],
    confirm: true,
    idempotency_key: 'review-config-cross-device',
  });
  const first = reviewQueue.observe({
    device_id: 1,
    track_title: 'Song on Fleet 1',
    observation_key: 'shared-observation-key',
  });
  const second = reviewQueue.observe({
    device_id: 2,
    track_title: 'Song on Fleet 2',
    observation_key: 'shared-observation-key',
  });
  assert.equal(first.idempotent_replay, false);
  assert.equal(second.idempotent_replay, false);
  assert.equal(first.candidates[0].device_id, 1);
  assert.equal(second.candidates[0].device_id, 2);
  assert.equal(
    db.get("SELECT COUNT(*) AS count FROM youtube_music_review_observations WHERE observation_key='shared-observation-key'").count,
    2,
  );

  labControl.configure({
    confirm: true,
    lab_mode_enabled: true,
    canary_device_id: 1,
    hermes_enabled: false,
    idempotency_key: 'review-test-canary-scope',
  });
  assert.throws(
    () => reviewQueue.observe({
      device_id: 2,
      track_title: 'Must not replay outside scope',
      observation_key: 'shared-observation-key',
    }),
    /outside the canary device/,
  );
});

test('dashboard review cards do not embed comment drafts in inline handlers', () => {
  const source = fs.readFileSync(path.join(__dirname, '../dashboard/js/scripts-ui.js'), 'utf8');
  assert.match(source, /data-yt-review-action="edit"/);
  assert.doesNotMatch(source, /onclick="editYtMusicReviewDraft/);
  assert.doesNotMatch(source, /encodeURIComponent\(candidate\.comment_draft/);
});
