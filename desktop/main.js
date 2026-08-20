// Bsolutions Control App — proceso principal de Electron.
// Orquesta: backend Node.js (SQLite sql.js) + Command Router (WebSocket) + ADB + Dashboard.

const { app, BrowserWindow, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dbServer = require('./server/db');
const logic = require('./server/logic');
const appServer = require('./server/app');
const alerts = require('./server/alerts');
const monitor = require('./server/monitor');
const accounts = require('./server/accounts');
const proxies = require('./server/proxies');
const hermes = require('./server/hermes');
const settings = require('./server/settings');
const views = require('./server/views');
const labControl = require('./server/lab_control');
const router = require('./router');
const adb = require('./adb');
const mirror = require('./adb/mirror');

const HTTP_PORT = 8733;      // puerto local del backend Express embebido
const WS_PORT = 6011;        // puerto del Command Router (WebSocket)

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return /^(1|true|yes)$/i.test(String(value));
}

// Carpeta de datos fijada explícitamente.
//
// Por defecto Electron la deriva de productName, así que renombrar el producto
// movería la ruta y la app arrancaría contra una base vacía: se perderían de
// vista los dispositivos, las rutinas y el token. Anclándola aquí, el nombre
// comercial puede cambiar sin tocar dónde viven los datos.
const CARPETA_DATOS = 'MCP Control Bsolutions V2';
app.setPath('userData', path.join(app.getPath('appData'), CARPETA_DATOS));

let win = null;
let apiToken = '';
let scheduleInterval = null;
let pruneInterval = null;
let monitorInterval = null;
let database = null;
let httpServer = null;

function userFile(name) {
  return path.join(app.getPath('userData'), name);
}

function dbPath() {
  return userFile('appcontrol.sqlite');
}

function loadApiToken() {
  const tokenFile = userFile('api-token.txt');
  try {
    const stored = fs.readFileSync(tokenFile, 'utf8').trim();
    if (stored.length >= 32) return stored;
  } catch (_) {}

  const generated = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, generated, { encoding: 'utf8', mode: 0o600 });
  return generated;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860,
    title: 'Bsolutions Control App',
    backgroundColor: '#0f1117',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Elimina cualquier Service Worker/caché heredado de la versión PWA anterior
  // que interceptaba las llamadas a la API (dejaba la lista de dispositivos vacía).
  session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] })
    .catch(() => {})
    .finally(() => win.loadURL(`http://127.0.0.1:${HTTP_PORT}/`));

  // Inyecta el token y la config local para que el dashboard funcione sin
  // que el usuario pegue nada.
  win.webContents.on('did-finish-load', async () => {
    const js = `(() => {
      const t = ${JSON.stringify(apiToken)};
      let changed = localStorage.getItem('mcp_api_token') !== t;
      localStorage.setItem('mcp_api_token', t);
      localStorage.setItem('mcp_api_base', location.origin);
      localStorage.setItem('mcp_ws_host', '127.0.0.1:${WS_PORT}');
      if (changed) location.reload();
    })();`;
    try { await win.webContents.executeJavaScript(js); } catch (_) {}
  });

  win.on('closed', () => { win = null; });
}

// Muestra la ventana existente o la vuelve a crear. Sin la rama de recreación,
// un proceso que se quedó vivo pero sin ventana (backend levantado, ventana
// cerrada o fallida) retenía el lock de instancia única y todos los arranques
// posteriores morían en silencio: la app "no arrancaba" hasta reiniciar el PC.
function showOrCreateWindow() {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  createWindow();
}

// Una sola instancia: evita que un segundo arranque intente enlazar el puerto
// 8733 (fallaría y dejaría la app sin backend / sin dispositivos).
// El proceso secundario sale con app.quit() y NO con process.exit(0): la salida
// abrupta cortaba el aviso 'second-instance' antes de que llegara al primario,
// de modo que volver a abrir la app no mostraba ninguna ventana.
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
}

app.on('second-instance', () => { showOrCreateWindow(); });
app.on('activate', () => { showOrCreateWindow(); });

app.whenReady().then(async () => {
  // Instancia secundaria: app.quit() no cancela este arranque, así que sin este
  // corte el segundo proceso abría una SEGUNDA conexión al mismo SQLite, volvía a
  // enlazar 8733 (en Windows el bind duplicado se acepta y roba tráfico al
  // primario), lanzaba otro sondeo ADB y terminaba en un diálogo "Error" al
  // chocar con el puerto 6011. De ahí venían los arranques rotos.
  if (!hasLock) return;

  try {
    apiToken = loadApiToken();

    // 1. Abrir base de datos SQLite (motor nativo better-sqlite3; fallback a sql.js)
    const db = await dbServer.open(dbPath());
    database = db;
    console.log(`[db] motor de almacenamiento: ${db.engine || 'sql.js'}`);

    // 1b. Recuperación de estados colgados de una sesión anterior (crash/cierre a
    // mitad de rutina): sin esto, dispositivos quedaban 'busy' y tareas 'running'
    // para siempre. Se resetean al arrancar.
    try {
      const ts = dbServer.now();
      const dev = db.run("UPDATE devices SET status='online', current_task_id=NULL WHERE status='busy'").changes;
      db.run("UPDATE tasks SET status='failed', error_message='Interrumpida por reinicio de la app', completed_at=?, updated_at=? WHERE status='running'", [ts, ts]);
      db.run("UPDATE task_assignments SET status='failed', completed_at=?, updated_at=? WHERE status IN ('running','assigned')", [ts, ts]);
      try { db.run("UPDATE view_sessions SET status='failed', updated_at=? WHERE status='running'", [ts]); } catch (_) {}
      try { db.run("UPDATE view_campaigns SET status='failed', updated_at=? WHERE status='running'", [ts]); } catch (_) {}
      if (dev) console.log(`[recover] ${dev} dispositivos liberados de estado 'busy' tras reinicio`);
    } catch (e) { console.error('[recover]', e.message); }

    // 2. Inicializar lógica de negocio y despacho
    logic.init(db, WS_PORT);
    alerts.init(db);
    accounts.init(db);
    proxies.init(db, {
      encrypt: accounts._enc,
      decrypt: accounts._dec,
      dispatch: logic.routerDispatch,
    });
    const hermesRuntimeEnabled = envFlag('MCP_HERMES_ENABLED', false) && !envFlag('MCP_LAB_MODE', true);
    if (hermesRuntimeEnabled) {
      hermes.init({
        nodeRuntimePath: app.isPackaged
          ? path.join(process.resourcesPath, 'node-runtime', 'node.exe')
          : path.resolve(__dirname, 'node_modules', 'node', 'bin', 'node.exe'),
        mcpServerPath: app.isPackaged
          ? path.join(process.resourcesPath, 'mcp-server', 'appcontrol-mcp.cjs')
          : path.resolve(__dirname, '..', 'mcp-server', 'bundle', 'appcontrol-mcp.cjs'),
        tokenFile: userFile('api-token.txt'),
        backendUrl: 'http://127.0.0.1:' + HTTP_PORT + '/api/v1',
      });
    } else {
      console.log('[hermes] connector disabled by startup configuration');
    }
    settings.init(db);
    monitor.init(db, { dispatch: logic.routerDispatch });
    views.init(db);

    // 3. Arrancar servidor Express (API REST /api/v1 + UI Dashboard)
    const serverApp = appServer.createServer(db, WS_PORT, apiToken);
    await new Promise((resolve, reject) => {
      httpServer = serverApp.listen(HTTP_PORT, '127.0.0.1', () => {
        console.log(`[backend] Servidor Express corriendo en http://127.0.0.1:${HTTP_PORT}`);
        resolve();
      });
      httpServer.on('error', reject);
    });

    // 3b. Espejo scrcpy sobre el mismo servidor (ws /mirror). Sustituye al visor
    // por capturas: el teléfono codifica H.264 por hardware y los toques viajan
    // por el socket de control ya abierto.
    mirror.init({
      httpServer,
      adbResolver: adb.resolveAdb,
      token: apiToken,
      authorizeSerial: serial => {
        const device = db.get('SELECT id FROM devices WHERE adb_serial=? OR serial_number=?', [serial, serial]);
        if (!device) return false;
        try { labControl.assertDeviceInScope(device.id); return true; } catch (_) { return false; }
      },
      config: { maxSize: 1024, maxFps: 30, bitRate: 4000000 },
    });

    // 4. Iniciar runner de horarios (cron tick cada 30 segundos)
    scheduleInterval = setInterval(() => {
      try { logic.scheduleTick(); } catch (e) { console.error('[scheduleTick]', e.message); }
    }, 30000);

    // 4b. Poda de logs antiguos (> 7 días): al arrancar y cada 6 horas, para que
    // la BD no crezca sin límite y cada guardado sea rápido.
    const prune = () => { try { const n = dbServer.pruneLogs(db, 7); if (n) console.log(`[prune] ${n} logs antiguos eliminados`); } catch (e) { console.error('[prune]', e.message); } };
    prune();
    pruneInterval = setInterval(prune, 6 * 3600 * 1000);

    // 4c. Monitor de baneo/captcha (opt-in): revisa la pantalla de cada dispositivo
    // según el intervalo configurado en alerts-config.json (monitor_enabled).
    monitorInterval = setInterval(() => {
      // A lab session is canary-scoped. Never fan out background work to
      // devices persisted in an older local database.
      if (labControl.state().lab_mode_enabled) return;
      try {
        const cfg = alerts.raw();
        if (!cfg.monitor_enabled) return;
        if (!monitorInterval._nextTs || Date.now() >= monitorInterval._nextTs) {
          monitorInterval._nextTs = Date.now() + Math.max(30, cfg.monitor_interval_sec || 120) * 1000;
          monitor.tick();
        }
      } catch (e) { console.error('[monitor]', e.message); }
      // Salud de hardware (batería/temp/almacenamiento) según su propio intervalo.
      try {
        const s = settings.get();
        if (s.hw_enabled && (!monitorInterval._hwTs || Date.now() >= monitorInterval._hwTs)) {
          monitorInterval._hwTs = Date.now() + Math.max(60, s.hw_interval_sec || 300) * 1000;
          monitor.healthTick();
        }
      } catch (e) { console.error('[healthTick]', e.message); }
    }, 15000);

    // 5. Command Router: puente con agentes (WebSocket)
    const backendApi = `http://127.0.0.1:${HTTP_PORT}/api/v1`;
    router.start({
      wsPort: WS_PORT,
      backendUrl: backendApi,
      backendToken: apiToken,
      wsAuthToken: '',
    });

    // 6. Transporte ADB: detecta teléfonos por USB y los controla directamente.
    //    frameMaxWidth/frameQuality = streaming ligero del muro (JPEG reescalado).
    adb.start({
      backendUrl: backendApi, backendToken: apiToken,
      db,                                        // handle abierto de SQLite: comandos como TIKTOK_ROTATE_PROXY leen su config de la BD
      autoInstallAgent: envFlag('MCP_AUTO_INSTALL_AGENT', !labControl.state().lab_mode_enabled),
      wsPort: WS_PORT,                           // para abrir el túnel `adb reverse` que deja al agente alcanzar el router
      frameMaxWidth: 0, frameQuality: 55,        // visor enfocado: resolución NATIVA (para que el toque caiga donde se hace clic) + JPEG
      thumbMaxWidth: 240, thumbQuality: 40, thumbTtlMs: 1500,  // miniaturas del muro (ligeras, escala 40+)
      allowedSerials: String(process.env.MCP_ADB_ALLOWLIST || '').split(',').map(s => s.trim()).filter(Boolean),
      requireAllowlist: labControl.state().lab_mode_enabled,
      suppressStartupWrites: labControl.state().lab_mode_enabled,
      allowNetworkScan: false,
    });
    router.setAdbTransport(adb);

    // 7. Crear ventana principal
    createWindow();
  } catch (err) {
    dialog.showErrorBox('Bsolutions Control App', 'No se pudo iniciar la aplicación:\n' + err.message);
    app.quit();
  }
});

// Cierre ordenado. Cada paso va aislado: antes, si uno lanzaba (adb, router, el
// cierre del servidor o el de la BD), app.quit() nunca llegaba a ejecutarse y el
// proceso quedaba vivo sin ventana, reteniendo los puertos 8733/6011 y el lock de
// instancia única. Ese zombi era la causa de que la app dejara de arrancar.
app.on('window-all-closed', () => {
  const safe = (etiqueta, fn) => {
    try { fn(); } catch (e) { console.error(`[cierre] ${etiqueta}:`, e.message); }
  };

  safe('intervalos', () => {
    if (scheduleInterval) clearInterval(scheduleInterval);
    if (pruneInterval) clearInterval(pruneInterval);
    if (monitorInterval) clearInterval(monitorInterval);
  });
  safe('espejo', () => mirror.stopAll());
  safe('adb', () => adb.stop());
  safe('router', () => router.stop());
  safe('http', () => { if (httpServer) httpServer.close(); });
  safe('db', () => { if (database) database.close(); });

  app.quit();
  // Red de seguridad: si algo mantiene vivo el bucle de eventos y quit() no
  // termina, forzamos la salida para no dejar otro zombi bloqueando el arranque.
  const t = setTimeout(() => process.exit(0), 3000);
  if (t.unref) t.unref();
});
