const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  email TEXT UNIQUE,
  password TEXT,
  role TEXT DEFAULT 'operator',
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  token_hash TEXT UNIQUE,
  last_used_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS device_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  description TEXT,
  max_devices INTEGER,
  paused_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  serial_number TEXT UNIQUE NOT NULL,
  adb_serial TEXT,
  transport TEXT DEFAULT 'agent',
  model TEXT,
  android_version TEXT,
  status TEXT DEFAULT 'offline',
  assigned_group_id INTEGER,
  current_task_id INTEGER,
  last_seen TEXT,
  proxy_host TEXT,
  proxy_port INTEGER,
  proxy_user TEXT,
  proxy_pass TEXT,
  proxy_enabled INTEGER DEFAULT 0,
  last_ip TEXT,
  last_ip_at TEXT,
  flagged INTEGER DEFAULT 0,
  flag_reason TEXT,
  flag_category TEXT,
  flagged_at TEXT,
  battery_level INTEGER,
  temperature_c REAL,
  storage_free_mb INTEGER,
  charging INTEGER,
  health_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS proxy_rotations (
  device_serial TEXT PRIMARY KEY,
  rotation_url TEXT NOT NULL,
  method TEXT DEFAULT 'GET',
  headers TEXT,
  body TEXT,
  timeout_ms INTEGER DEFAULT 10000,
  wait_secs INTEGER DEFAULT 30,
  cooldown_secs INTEGER DEFAULT 30,
  last_status INTEGER DEFAULT 0,
  last_message TEXT,
  last_rotated_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  steps TEXT,
  allowed_package TEXT,
  parameter_schema TEXT DEFAULT '[]',
  execution_options TEXT DEFAULT '{}',
  status TEXT DEFAULT 'draft',
  created_by INTEGER,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS workflow_device_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(workflow_id, device_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT UNIQUE,
  workflow_id INTEGER,
  params TEXT,
  status TEXT DEFAULT 'scheduled',
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS task_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  device_id INTEGER,
  external_task_id TEXT,
  device_serial TEXT,
  status TEXT DEFAULT 'assigned',
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS execution_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  device_serial TEXT,
  command_type TEXT,
  success INTEGER,
  message TEXT,
  result_data TEXT,
  timestamp TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_serial TEXT,
  image_data TEXT,
  timestamp TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  message TEXT,
  data TEXT,
  read INTEGER DEFAULT 0,
  sent_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  workflow_id INTEGER,
  group_id INTEGER,
  mode TEXT DEFAULT 'loop',
  times TEXT,
  window_start TEXT,
  window_end TEXT,
  loop_gap_seconds INTEGER DEFAULT 0,
  days_of_week TEXT,
  is_active INTEGER DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT,
  username TEXT,
  password_enc TEXT,
  email TEXT,
  totp_enc TEXT,
  notes TEXT,
  status TEXT DEFAULT 'unused',
  device_id INTEGER,
  active INTEGER DEFAULT 0,
  cooldown_until TEXT,
  last_used_at TEXT,
  verification_state TEXT DEFAULT 'unknown',
  last_verified_at TEXT,
  last_seen_on_device_at TEXT,
  last_verification_message TEXT,
  consecutive_missing INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  protocol TEXT DEFAULT 'http',
  username TEXT,
  password_enc TEXT,
  country TEXT,
  tags TEXT,
  status TEXT DEFAULT 'active',
  max_devices INTEGER DEFAULT 1,
  failure_count INTEGER DEFAULT 0,
  last_used_at TEXT,
  last_checked_at TEXT,
  last_error TEXT,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(host, port, username)
);

CREATE TABLE IF NOT EXISTS proxy_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proxy_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  active INTEGER DEFAULT 1,
  reason TEXT,
  assigned_at TEXT,
  released_at TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY(proxy_id) REFERENCES proxies(id),
  FOREIGN KEY(device_id) REFERENCES devices(id)
);

CREATE TABLE IF NOT EXISTS lab_control_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  lab_mode_enabled INTEGER NOT NULL DEFAULT 1,
  halted INTEGER NOT NULL DEFAULT 0,
  canary_device_id INTEGER,
  hermes_enabled INTEGER NOT NULL DEFAULT 0,
  halt_reason TEXT,
  updated_at TEXT,
  FOREIGN KEY(canary_device_id) REFERENCES devices(id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  actor TEXT,
  device_id INTEGER,
  route_id TEXT,
  idempotency_key TEXT UNIQUE,
  result TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_routes (
  route_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  internal_host TEXT NOT NULL,
  internal_port INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  country TEXT,
  region TEXT,
  city TEXT,
  classification TEXT NOT NULL DEFAULT 'dedicated_static',
  expected_public_ip TEXT,
  assigned_device_id INTEGER,
  assigned_fleet_vlan INTEGER,
  health_state TEXT NOT NULL DEFAULT 'unverified',
  observed_public_ip TEXT,
  last_verification_time TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(assigned_device_id) REFERENCES devices(id)
);

CREATE TABLE IF NOT EXISTS proxy_route_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id TEXT NOT NULL,
  device_id INTEGER NOT NULL,
  previous_route_id TEXT,
  previous_proxy_state TEXT,
  state TEXT NOT NULL DEFAULT 'pending_apply',
  active INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT UNIQUE,
  assigned_at TEXT NOT NULL,
  released_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(route_id) REFERENCES proxy_routes(route_id),
  FOREIGN KEY(device_id) REFERENCES devices(id)
);

CREATE TABLE IF NOT EXISTS anti_idle_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  device_ids TEXT NOT NULL DEFAULT '[]',
  package_names TEXT NOT NULL DEFAULT '[]',
  package_cursor INTEGER NOT NULL DEFAULT 0,
  interval_seconds INTEGER NOT NULL DEFAULT 480,
  action_duration_seconds INTEGER NOT NULL DEFAULT 45,
  gesture_interval_seconds INTEGER NOT NULL DEFAULT 4,
  scrolls_before_dwell INTEGER NOT NULL DEFAULT 3,
  video_dwell_seconds INTEGER NOT NULL DEFAULT 180,
  natural_scrolls_enabled INTEGER NOT NULL DEFAULT 1,
  active_run_id TEXT,
  last_run_at TEXT,
  next_run_at TEXT,
  last_result TEXT,
  last_error TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS view_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  device_count INTEGER DEFAULT 0,
  config TEXT,
  status TEXT DEFAULT 'scheduled',
  mode TEXT DEFAULT 'one_shot',
  content_urls TEXT,
  target_view_count INTEGER DEFAULT 0,
  current_view_count INTEGER DEFAULT 0,
  accounts_ids TEXT,
  device_group_id INTEGER,
  views_delivered INTEGER DEFAULT 0,
  views_failed INTEGER DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  start_time TEXT,
  end_time TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS proxy_orch_lanes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane_id TEXT UNIQUE NOT NULL,
  purpose TEXT NOT NULL,
  proxy_orch_ip TEXT NOT NULL,
  proxy_orch_port INTEGER NOT NULL,
  provider_class TEXT NOT NULL,
  auto_fallback INTEGER DEFAULT 0,
  residential_quota_gb INTEGER,
  residential_warn_pct INTEGER DEFAULT 70,
  residential_block_pct INTEGER DEFAULT 85,
  residential_hard_pct INTEGER DEFAULT 95,
  residential_max_pct INTEGER DEFAULT 100,
  active INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS device_lane_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_serial TEXT NOT NULL,
  lane_id TEXT NOT NULL,
  assigned_at TEXT,
  assigned_by TEXT NOT NULL,
  approved_hash TEXT NOT NULL,
  approved_at TEXT,
  approved_by TEXT,
  approved_ttl INTEGER,
  assigned_source TEXT,
  last_success TEXT,
  last_failure TEXT,
  failure_count INTEGER DEFAULT 0,
  bytes_sent INTEGER DEFAULT 0,
  bytes_received INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  UNIQUE(lane_id, device_serial)
);

CREATE TABLE IF NOT EXISTS health_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_serial TEXT NOT NULL,
  check_level INTEGER NOT NULL,
  check_type TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms REAL,
  loss_pct REAL,
  exit_identity TEXT,
  details TEXT,
  timestamp TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_serial TEXT NOT NULL,
  event_type TEXT NOT NULL,
  state_before TEXT,
  state_after TEXT,
  desired_hash TEXT NOT NULL,
  actual_hash TEXT,
  approval_id TEXT,
  approved_by TEXT NOT NULL,
  approved_at TEXT,
  applied_at TEXT,
  rollback_hash TEXT,
  rollback_result TEXT,
  timestamp TEXT
);

CREATE TABLE IF NOT EXISTS device_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evidence_id TEXT UNIQUE NOT NULL,
  device_serial TEXT NOT NULL,
  approved_label TEXT NOT NULL,
  binding_redacted TEXT NOT NULL,
  vlan INTEGER DEFAULT 60,
  group_id TEXT,
  lane_id TEXT,
  dns_policy TEXT DEFAULT 'strict',
  state TEXT DEFAULT 'registered',
  last_success TEXT,
  quarantine_reason TEXT,
  quarantine_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS view_sessions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT,
  account_id INTEGER,
  device_serial TEXT,
  platform TEXT NOT NULL,
  content_url TEXT,
  content_title TEXT,
  view_type TEXT DEFAULT 'organic',
  duration_seconds INTEGER DEFAULT 15,
  status TEXT DEFAULT 'scheduled',
  view_count INTEGER DEFAULT 0,
  successful_steps INTEGER DEFAULT 0,
  failed_steps INTEGER DEFAULT 0,
  logs TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS view_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT UNIQUE NOT NULL,
  package_name TEXT,
  default_duration_seconds INTEGER DEFAULT 30,
  max_concurrent_views INTEGER DEFAULT 5,
  like_probability REAL DEFAULT 0.2,
  comment_probability REAL DEFAULT 0.05,
  follow_probability REAL DEFAULT 0.03,
  loop_enabled INTEGER DEFAULT 1,
  loop_count INTEGER DEFAULT 1,
  cooldown_minutes INTEGER DEFAULT 2,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS engagement_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  view_session_id TEXT,
  platform TEXT NOT NULL,
  content_url TEXT,
  views_generated INTEGER DEFAULT 0,
  watch_time_seconds INTEGER DEFAULT 0,
  completion_rate REAL DEFAULT 0,
  likes_given INTEGER DEFAULT 0,
  comments_given INTEGER DEFAULT 0,
  shares_given INTEGER DEFAULT 0,
  follows_given INTEGER DEFAULT 0,
  organic_views_1h INTEGER DEFAULT 0,
  organic_views_24h INTEGER DEFAULT 0,
  organic_likes_24h INTEGER DEFAULT 0,
  organic_comments_24h INTEGER DEFAULT 0,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS account_rotation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  device_serial TEXT,
  action TEXT,
  reason TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS ban_recovery_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_serial TEXT,
  detection_type TEXT,
  recovery_action TEXT,
  attempts INTEGER DEFAULT 1,
  success INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_devices_status ON devices(status);
CREATE INDEX IF NOT EXISTS idx_devices_adb_serial ON devices(adb_serial);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON execution_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_view_sessions_campaign ON view_sessions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_view_sessions_status ON view_sessions(status);
CREATE INDEX IF NOT EXISTS idx_view_sessions_platform ON view_sessions(platform);
CREATE INDEX IF NOT EXISTS idx_proxies_status ON proxies(status);
CREATE INDEX IF NOT EXISTS idx_proxy_assignments_proxy_active ON proxy_assignments(proxy_id, active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proxy_assignments_device_active
  ON proxy_assignments(device_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_audit_events_operation ON audit_events(operation, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proxy_routes_internal_listener
  ON proxy_routes(internal_host, internal_port);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proxy_route_assignments_device_active
  ON proxy_route_assignments(device_id) WHERE active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_proxy_route_assignments_route_active
  ON proxy_route_assignments(route_id) WHERE active = 1;
`;

const DEVICE_COLUMNS = {
  proxy_host: 'TEXT',
  proxy_port: 'INTEGER',
  proxy_user: 'TEXT',
  proxy_pass: 'TEXT',
  proxy_enabled: 'INTEGER DEFAULT 0',
  last_ip: 'TEXT',
  last_ip_at: 'TEXT',
  flagged: 'INTEGER DEFAULT 0',
  flag_reason: 'TEXT',
  flag_category: 'TEXT',
  flagged_at: 'TEXT',
  battery_level: 'INTEGER',
  temperature_c: 'REAL',
  storage_free_mb: 'INTEGER',
  charging: 'INTEGER',
  health_at: 'TEXT',
  timezone: 'TEXT',
  time_synced_at: 'TEXT',
};

const ACCOUNT_COLUMNS = {
  secret_ref: 'TEXT',
  verification_state: "TEXT DEFAULT 'unknown'",
  last_verified_at: 'TEXT',
  last_seen_on_device_at: 'TEXT',
  last_verification_message: 'TEXT',
  consecutive_missing: 'INTEGER DEFAULT 0',
};

const ANTI_IDLE_COLUMNS = {
  natural_scrolls_enabled: 'INTEGER NOT NULL DEFAULT 1',
  package_cursor: 'INTEGER NOT NULL DEFAULT 0',
  scrolls_before_dwell: 'INTEGER NOT NULL DEFAULT 3',
  video_dwell_seconds: 'INTEGER NOT NULL DEFAULT 180',
};

const WORKFLOW_COLUMNS = {
  parameter_schema: "TEXT DEFAULT '[]'",
  execution_options: "TEXT DEFAULT '{}'",
};

function now() {
  return new Date().toISOString();
}

function normalizeParams(params) {
  if (!Array.isArray(params)) return params || {};
  return params.map(value => {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    return value;
  });
}

function getRows(nativeDb, sql, params = []) {
  const statement = nativeDb.prepare(sql);
  try {
    statement.bind(normalizeParams(params));
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

// Los comandos de la suite de TikTok se llamaban TIKMATRIX_* por la app que se
// tomó de referencia. Al pasar a TIKTOK_*, las rutinas ya guardadas seguirían
// apuntando al nombre viejo y fallarían al ejecutarse, así que se reescriben una
// sola vez. Es idempotente: si no queda ninguna, no hace nada.
function migrarNombresDeComando(ejecutar) {
  const cambios = [
    ["UPDATE workflows SET steps = REPLACE(steps, 'TIKMATRIX_', 'TIKTOK_') WHERE steps LIKE '%TIKMATRIX\\_%' ESCAPE '\\'", 'rutinas'],
    ["UPDATE tasks SET params = REPLACE(params, 'TIKMATRIX_', 'TIKTOK_') WHERE params LIKE '%TIKMATRIX\\_%' ESCAPE '\\'", 'tareas'],
    ["UPDATE execution_logs SET command_type = REPLACE(command_type, 'TIKMATRIX_', 'TIKTOK_') WHERE command_type LIKE 'TIKMATRIX\\_%' ESCAPE '\\'", 'registros'],
  ];
  const hechos = [];
  for (const [sql, etiqueta] of cambios) {
    try {
      const n = ejecutar(sql);
      if (n) hechos.push(`${n} ${etiqueta}`);
    } catch (_) { /* tabla ausente en bases antiguas: no es un fallo */ }
  }
  if (hechos.length) console.log(`[migración] comandos TIKMATRIX_* renombrados a TIKTOK_* en ${hechos.join(', ')}`);
  return hechos;
}

function ensureColumns(nativeDb, table, columns) {
  const existing = new Set(getRows(nativeDb, `PRAGMA table_info(${table})`).map(column => column.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) nativeDb.run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

function persist(db) {
  if (!db || db.file === ':memory:' || db.closed) return;
  if (db._saveTimer) { clearTimeout(db._saveTimer); db._saveTimer = null; }
  db._firstDirty = 0;
  fs.writeFileSync(db.file, Buffer.from(db.native.export()));
}

// Guardado diferido: sql.js reescribe TODA la BD en cada export(). Hacerlo en cada
// db.run() no escala (con 40 dispositivos habría cientos de escrituras/seg). Coalescemos:
// se guarda tras 1s de inactividad, y como muy tarde cada 5s bajo escritura continua.
function scheduleSave(db) {
  if (!db || db.file === ':memory:' || db.closed) return;
  const t = Date.now();
  if (!db._firstDirty) db._firstDirty = t;
  if (t - db._firstDirty >= 5000) { persist(db); return; }   // techo: no acumular >5s
  if (db._saveTimer) clearTimeout(db._saveTimer);
  db._saveTimer = setTimeout(() => { db._saveTimer = null; persist(db); }, 1000);
}

// Motor de almacenamiento preferido: SQLite NATIVO (better-sqlite3). Escribe solo las
// páginas modificadas (no reserializa toda la BD como sql.js), imprescindible para 40+
// dispositivos. Si el módulo nativo no carga (p. ej. binario incompatible), cae a sql.js.
let BetterSqlite3 = null;
try { BetterSqlite3 = require('better-sqlite3'); } catch (_) { BetterSqlite3 = null; }

async function open(file = ':memory:') {
  if (BetterSqlite3) {
    try { return openNative(file); }
    catch (e) { console.error('[db] better-sqlite3 no disponible, usando sql.js:', e.message); }
  }
  return openSqlJs(file);
}

function openNative(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const native = new BetterSqlite3(file);
  native.pragma('journal_mode = WAL');   // concurrencia lectura/escritura
  native.pragma('synchronous = NORMAL'); // rápido y seguro con WAL
  native.pragma('busy_timeout = 5000');
  native.exec(SCHEMA);
  // ensureColumns nativo (equivalente a la versión sql.js)
  const cols = new Set(native.prepare('PRAGMA table_info(devices)').all().map(c => c.name));
  for (const [name, def] of Object.entries(DEVICE_COLUMNS)) {
    if (!cols.has(name)) native.exec(`ALTER TABLE devices ADD COLUMN ${name} ${def}`);
  }
  const accountCols = new Set(native.prepare('PRAGMA table_info(accounts)').all().map(c => c.name));
  for (const [name, def] of Object.entries(ACCOUNT_COLUMNS)) {
    if (!accountCols.has(name)) native.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${def}`);
  }
  const antiIdleCols = new Set(native.prepare('PRAGMA table_info(anti_idle_state)').all().map(c => c.name));
  for (const [name, def] of Object.entries(ANTI_IDLE_COLUMNS)) {
    if (!antiIdleCols.has(name)) native.exec(`ALTER TABLE anti_idle_state ADD COLUMN ${name} ${def}`);
  }
const workflowCols = new Set(native.prepare('PRAGMA table_info(workflows)').all().map(c => c.name));
  for (const [name, def] of Object.entries(WORKFLOW_COLUMNS)) {
    if (!workflowCols.has(name)) native.exec(`ALTER TABLE workflows ADD COLUMN ${name} ${def}`);
  }
  migrarNombresDeComando(sql => native.prepare(sql).run().changes);
  return {
    file, native, closed: false, engine: 'better-sqlite3',
    run(sql, params = []) {
      if (this.closed) throw new Error('La base de datos está cerrada');
      const info = native.prepare(sql).run(...normalizeParams(params));
      return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
    },
    get(sql, params = []) {
      if (this.closed) throw new Error('La base de datos está cerrada');
      return native.prepare(sql).get(...normalizeParams(params));
    },
    all(sql, params = []) {
      if (this.closed) throw new Error('La base de datos está cerrada');
      return native.prepare(sql).all(...normalizeParams(params));
    },
    exec(sql) {
      if (this.closed) throw new Error('La base de datos está cerrada');
      native.exec(sql);
    },
    flush() { /* nativo: ya está en disco */ },
    close() { if (this.closed) return; try { native.close(); } catch (_) {} this.closed = true; },
  };
}

async function openSqlJs(file = ':memory:') {
  let wasmBinary = undefined;
  try {
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    if (fs.existsSync(wasmPath)) {
      wasmBinary = fs.readFileSync(wasmPath);
    }
  } catch (_) {}

  const SQL = await initSqlJs({
    locateFile: filename => require.resolve(`sql.js/dist/${filename}`),
    wasmBinary,
  });

  let native;
  if (file !== ':memory:' && fs.existsSync(file)) {
    native = new SQL.Database(fs.readFileSync(file));
  } else {
    native = new SQL.Database();
  }

  native.run(SCHEMA);
  ensureColumns(native, 'devices', DEVICE_COLUMNS);
  ensureColumns(native, 'accounts', ACCOUNT_COLUMNS);
  ensureColumns(native, 'anti_idle_state', ANTI_IDLE_COLUMNS);
  ensureColumns(native, 'workflows', WORKFLOW_COLUMNS);
  migrarNombresDeComando(sql => { native.run(sql); return native.getRowsModified(); });

  const db = {
    file,
    native,
    closed: false,
    run(sql, params = []) {
      if (this.closed) throw new Error('La base de datos está cerrada');
      const statement = native.prepare(sql);
      try {
        statement.bind(normalizeParams(params));
        statement.step();
      } finally {
        statement.free();
      }
      const changes = native.getRowsModified();
      const row = getRows(native, 'SELECT last_insert_rowid() AS id')[0];
      scheduleSave(this);
      return { changes, lastInsertRowid: row ? row.id : 0 };
    },
    get(sql, params = []) {
      if (this.closed) throw new Error('La base de datos está cerrada');
      return getRows(native, sql, params)[0];
    },
    all(sql, params = []) {
      if (this.closed) throw new Error('La base de datos está cerrada');
      return getRows(native, sql, params);
    },
    exec(sql) {
      if (this.closed) throw new Error('La base de datos está cerrada');
      native.run(sql);
      scheduleSave(this);
    },
    flush() {
      persist(this);
    },
    _saveTimer: null,
    _firstDirty: 0,
    close() {
      if (this.closed) return;
      persist(this);
      native.close();
      this.closed = true;
    },
  };

  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    persist(db);
  }

  return db;
}

function pruneLogs(db, retentionDays = 7) {
  const days = Number.isFinite(Number(retentionDays)) ? Math.max(1, Number(retentionDays)) : 7;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return db.run('DELETE FROM execution_logs WHERE timestamp < ?', [cutoff]).changes;
}

module.exports = { open, now, pruneLogs };
