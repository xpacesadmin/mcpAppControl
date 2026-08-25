// Módulo ADB — control directo de teléfonos por USB, sin agente ni accesibilidad.
// - Detecta dispositivos conectados y los registra en el backend (transport='adb').
// - Traduce los mismos comandos de las rutinas a `adb shell` (tap, texto, captura…).
// Reproduce lo que el AccessibilityService del agente hace, pero desde el PC.

const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const maintenance = require('./maintenance');
const tiktok = require('./tiktok');
const agent = require('./agent');
const spotify = require('./spotify');
const twitch = require('./twitch');
let settings = null; try { settings = require('../server/settings'); } catch (_) {}
const HJ = (x, y) => settings ? settings.jitterXY(x, y) : { x, y };
const HD = (ms) => settings ? settings.varyDuration(ms) : ms;

let CONFIG = {
  backendUrl: 'http://127.0.0.1:8733/api/v1', backendToken: '', adbPath: null,
  db: null, wsPort: 6011, autoInstallAgent: true,
  allowedSerials: [],
  requireAllowlist: false,
  suppressStartupWrites: false,
  allowNetworkScan: false,
};

// Mapeo de plataforma a package name para LOGIN_GENERIC, BAN_RECOVERY, etc.
const PLATFORM_PACKAGES = {
  tiktok: 'com.zhiliaoapp.musically',
  youtube: 'com.google.android.youtube',
  instagram: 'com.instagram.android',
  twitter: 'com.twitter.android',
  general: null,
};
const live = new Map();       // adbSerial -> { serial, model, release, size:{w,h} }
const knownTcp = new Map();   // dirección WiFi (ip:puerto) -> ts del último intento de reconexión
let pollTimer = null;
let needsInitialReconciliation = true;

// Ruta a un recurso empaquetado (resources/<...>) o su equivalente en desarrollo.
function app_ruta_recurso(...partes) {
  return process.resourcesPath ? path.join(process.resourcesPath, ...partes) : null;
}

function isAllowedSerial(serial) {
  const allowlist = Array.isArray(CONFIG.allowedSerials) ? CONFIG.allowedSerials : [];
  if (!CONFIG.requireAllowlist && allowlist.length === 0) return true;
  return allowlist.includes(String(serial || '').trim());
}

// ---------- localizar adb.exe ----------
function resolveAdb() {
  if (CONFIG.adbPath && fs.existsSync(CONFIG.adbPath)) return CONFIG.adbPath;
  const candidates = [
    process.env.ADB_PATH,
    process.resourcesPath && path.join(process.resourcesPath, 'platform-tools', 'adb.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe'),
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return 'adb'; // en PATH
}

// ---------- cola de concurrencia ADB ----------
// Cap de procesos adb.exe simultáneos: con 40+ dispositivos, lanzar decenas de
// spawns a la vez satura CPU/USB y bloquea el servidor adb. Las peticiones exceso
// esperan en cola. Prioridad: comandos interactivos > capturas de pantalla del muro.
const MAX_ADB = 14;
let activeAdb = 0;
const adbQueue = [];
function _execAdbRaw(args, { binary = false, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(resolveAdb(), args, { timeout, encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => err ? reject(err) : resolve(stdout));
  });
}
function _pumpAdb() {
  while (activeAdb < MAX_ADB && adbQueue.length) {
    const job = adbQueue.shift();
    activeAdb++;
    _execAdbRaw(job.args, job.opts).then(
      (r) => { activeAdb--; job.resolve(r); _pumpAdb(); },
      (e) => { activeAdb--; job.reject(e); _pumpAdb(); },
    );
  }
}
function adb(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const job = { args, opts, resolve, reject };
    if (opts.lowPriority) adbQueue.push(job); else adbQueue.unshift(job);
    _pumpAdb();
  });
}
function adbStats() { return { active: activeAdb, queued: adbQueue.length, max: MAX_ADB }; }
function shell(serial, cmd, opts) { return adb(['-s', serial, 'shell', ...cmd], opts); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Long-running app scripts execute inside this process. Closing the target app
// alone is not enough to stop them: a warm-up can wake after its current sleep
// and continue tapping. Keep abort controllers per ADB serial so Stop Task can
// cancel only the selected device without disturbing the rest of the fleet.
const activeScriptControllers = new Map();

function cancelledError(serial) {
  const error = new Error(`Automation cancelled for ${serial}`);
  error.code = 'AUTOMATION_CANCELLED';
  return error;
}

function createScriptContext(serial) {
  const controller = new AbortController();
  let controllers = activeScriptControllers.get(serial);
  if (!controllers) {
    controllers = new Set();
    activeScriptControllers.set(serial, controllers);
  }
  controllers.add(controller);

  const ensureActive = () => {
    if (controller.signal.aborted) throw cancelledError(serial);
  };
  const cancellableSleep = ms => new Promise((resolve, reject) => {
    ensureActive();
    const timer = setTimeout(() => {
      controller.signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, Number(ms) || 0));
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError(serial));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const cancellableShell = async (target, args, opts) => {
    ensureActive();
    const result = await shell(target, args, opts);
    ensureActive();
    return result;
  };
  const finish = () => {
    controllers.delete(controller);
    if (!controllers.size) activeScriptControllers.delete(serial);
  };

  return {
    ctx: { shell: cancellableShell, adb, sleep: cancellableSleep, dumpUi, live, HJ, HD, CONFIG, execute },
    finish,
  };
}

function cancel(serial) {
  const controllers = activeScriptControllers.get(String(serial || '').trim());
  if (!controllers) return 0;
  const count = controllers.size;
  for (const controller of controllers) controller.abort();
  return count;
}

async function backendPost(endpoint, data) {
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.backendToken) headers['Authorization'] = `Bearer ${CONFIG.backendToken}`;
  try { await fetch(CONFIG.backendUrl + endpoint, { method: 'POST', headers, body: JSON.stringify(data) }); }
  catch (e) { console.error('[adb] backend', endpoint, e.message); }
}

async function backendGet(endpoint) {
  const headers = {};
  if (CONFIG.backendToken) headers['Authorization'] = `Bearer ${CONFIG.backendToken}`;
  try { const r = await fetch(CONFIG.backendUrl + endpoint, { headers }); return await r.json(); }
  catch (e) { return null; }
}

// Reaplica el proxy guardado del dispositivo (si está activo) tras (re)conectarse,
// para que la IP de salida se mantenga entre reinicios/desconexiones.
async function reapplyProxy(serial) {
  try {
    const res = await backendGet(`/devices/${encodeURIComponent(serial)}`);
    const dev = res && res.data && (res.data.device || res.data);
    if (dev && dev.proxy_enabled && dev.proxy_host && dev.proxy_port) {
      await execute(serial, 'SET_PROXY', { host: dev.proxy_host, port: dev.proxy_port, user: dev.proxy_user });
      console.log(`[adb] proxy reaplicado a ${serial}: ${dev.proxy_host}:${dev.proxy_port}`);
    }
  } catch (_) {}
}

async function screenSize(serial) {
  const dev = live.get(serial);
  if (dev?.size) return dev.size;
  try {
    const out = await shell(serial, ['wm', 'size']);
    const m = out.match(/(\d+)x(\d+)/);
    const size = m ? { w: +m[1], h: +m[2] } : { w: 1080, h: 1920 };
    if (dev) dev.size = size;
    return size;
  } catch { return { w: 1080, h: 1920 }; }
}

// ---------- detección / registro ----------
async function listDevices() {
  const out = await adb(['devices']).catch(() => '');
  return out.split(/\r?\n/).slice(1)
    .map(l => l.trim()).filter(Boolean)
    .map(l => l.split(/\s+/))
    .filter(p => p[1] === 'device')      // ignora unauthorized/offline
    .map(p => p[0])
    .filter(isAllowedSerial);
}

async function registerDevice(serial) {
  let model = 'USB device', release = 'unknown';
  if (!isAllowedSerial(serial)) return;
  try { model = (await shell(serial, ['getprop', 'ro.product.model'])).trim() || model; } catch (_) {}
  try { release = (await shell(serial, ['getprop', 'ro.build.version.release'])).trim() || release; } catch (_) {}
  live.set(serial, { serial, model, release, size: null });
  await backendPost('/devices', {
    serial_number: serial, adb_serial: serial, transport: 'adb',
    name: `${model} (USB)`, model, android_version: release, status: 'online',
  });
  console.log(`[adb] dispositivo USB registrado: ${serial} (${model})`);
  try { const router = require('../router'); router.broadcast('device_connected', { serial_number: serial, name: model }); } catch (_) {}
  abrirTunelDelRouter(serial);
  asegurarAgente(serial);
  if (CONFIG.suppressStartupWrites) {
    console.log(`[adb] lab: registro sin proxy/estabilización automática para ${serial}`);
  } else {
    reapplyProxy(serial);
    applyStability(serial);   // estabilidad inmediata al conectar
    applyTimeConfig(serial);  // hora/fecha estable al conectar
  }
  if (serial.includes(':') && !knownTcp.has(serial)) knownTcp.set(serial, 0); // vigilar para reconexión
}

// Da al teléfono una ruta hasta el Command Router.
//
// El router se ata a 127.0.0.1 a propósito: acepta órdenes que controlan el
// dispositivo y hoy va sin token, así que abrirlo a la red del local sería dejar
// un mando a distancia sin llave. Con `adb reverse`, el propio teléfono ve el
// puerto en SU localhost y nadie más lo alcanza.
//
// Sin esto el agente no podía conectar nunca: apuntara a donde apuntara, el
// router rechaza cualquier conexión que no venga del propio PC.
async function abrirTunelDelRouter(serial) {
  const puerto = CONFIG.wsPort;
  if (!puerto) return;
  try {
    await adb(['-s', serial, 'reverse', `tcp:${puerto}`, `tcp:${puerto}`], { timeout: 10000 });
  } catch (e) {
    console.error(`[adb] no se pudo abrir el túnel al router en ${serial}: ${e.message}`);
  }
  limpiarTunelesHuerfanos(serial);
}

// Comprueba si el teléfono trae el Agente Bsolutions y lo instala si le falta.
//
// Sin agente no se puede leer la pantalla, y sin eso ningún script encuentra sus
// controles: es la diferencia entre un teléfono operativo y uno inerte. Por eso se
// revisa en cuanto aparece el dispositivo, sin esperar a que alguien se acuerde.
//
// Lo que NO se puede automatizar es el permiso de accesibilidad: Android exige que
// lo conceda una persona en Ajustes, y con razón. Se informa de que falta.
async function asegurarAgente(serial) {
  if (CONFIG.autoInstallAgent === false) return;
  try {
    const r = await agent.instalarSiFalta(serial);
    switch (r.accion) {
      case 'instalado':
        console.log(`[agente] instalado en ${serial} (${r.paquete} ${r.version || ''})` +
          (r.accesibilidad ? '' : ' — falta activar su servicio de accesibilidad en Ajustes'));
        break;
      case 'ya_instalado':
        if (!r.accesibilidad) {
          console.log(`[agente] ${serial} tiene el agente (${r.version || 'versión desconocida'}) pero su servicio de accesibilidad está desactivado`);
        }
        break;
      case 'fallo':
        console.error(`[agente] no se pudo instalar en ${serial}: ${r.motivo}`);
        break;
      case 'sin_apk':
        console.error(`[agente] ${r.motivo}`);
        break;
    }
  } catch (e) {
    console.error(`[agente] revisión fallida en ${serial}: ${e.message}`);
  }
}

// Los túneles del espejo se retiran al cerrar sesión, pero si el proceso muere de
// golpe quedan colgados en el dispositivo y se van acumulando entre reinicios.
// Al conectar se barren los que ya no corresponden a ninguna sesión viva.
async function limpiarTunelesHuerfanos(serial) {
  try {
    const salida = String(await adb(['-s', serial, 'reverse', '--list'], { timeout: 10000 }));
    const viejos = salida.split(/\r?\n/)
      .map(l => (l.match(/(localabstract:scrcpy_[0-9a-f]+)/) || [])[1])
      .filter(Boolean);
    if (!viejos.length) return;
    for (const t of viejos) {
      await adb(['-s', serial, 'reverse', '--remove', t], { timeout: 8000 }).catch(() => {});
    }
    console.log(`[adb] ${viejos.length} túneles de espejo huérfanos retirados de ${serial}`);
  } catch (_) { /* no es crítico */ }
}

// Aplica al instante la base de estabilidad: mantener el teléfono despierto mientras
// carga (evita que se duerma/desconecte durante la operación de granja).
async function applyStability(serial) {
  try {
    await shell(serial, ['settings', 'put', 'global', 'stay_on_while_plugged_in', '7']); // AC+USB+Wireless
    await shell(serial, ['svc', 'power', 'stayon', 'true']).catch(() => {});
    console.log(`[adb] estabilidad aplicada a ${serial} (mantener despierto)`);
  } catch (_) {}
}

// Estabiliza hora/fecha al conectar. Si el dispositivo tiene una zona horaria fija
// guardada (para cuadrar con su proxy), la aplica; si no, activa hora+zona automáticas.
async function applyTimeConfig(serial) {
  try {
    const res = await backendGet(`/devices/${encodeURIComponent(serial)}`);
    const dev = res && res.data && (res.data.device || res.data);
    if (dev && dev.timezone) {
      await execute(serial, 'SET_TIMEZONE', { timezone: dev.timezone });
      console.log(`[adb] zona horaria aplicada a ${serial}: ${dev.timezone}`);
    } else {
      await execute(serial, 'SET_TIME_AUTO', { enabled: true });
      console.log(`[adb] hora automática activada en ${serial}`);
    }
  } catch (_) {}
}

async function poll() {
  let serials = [];
  try { serials = await listDevices(); } catch (_) {}
  // nuevos
  for (const s of serials) if (!live.has(s)) await registerDevice(s);
  // Al arrancar, la memoria `live` está vacía. Sin esta reconciliación, los
  // dispositivos ADB desconectados conservarían indefinidamente el estado
  // online persistido por la sesión anterior.
  if (needsInitialReconciliation) {
    const response = await backendGet('/devices?per_page=200');
    const persisted = response?.data?.data || (Array.isArray(response?.data) ? response.data : null);
    if (Array.isArray(persisted)) {
      for (const device of persisted) {
        const addr = device.adb_serial || device.serial_number;
        if (device.transport === 'adb' && isAllowedSerial(addr) && !serials.includes(addr)) {
          await backendPost('/devices/heartbeat', {
            serial_number: device.serial_number,
            status: 'offline',
          });
        }
        // `knownTcp` vive en RAM: al reiniciar la app se perdería y los teléfonos
        // WiFi caídos no se reintentarían nunca más. La tabla `devices` ya guarda
        // la dirección (el serial de un dispositivo TCP es "ip:puerto"), así que
        // la usamos como origen de verdad para repoblar la lista de vigilancia.
        if (isAllowedSerial(addr) && String(addr || '').includes(':')) knownTcp.set(addr, 0);
      }
      if (knownTcp.size) console.log(`[adb] ${knownTcp.size} direcciones WiFi recuperadas de la BD para reconexión automática`);
      needsInitialReconciliation = false;
    }
  }
  // desconectados
  for (const s of [...live.keys()]) {
    if (!serials.includes(s)) {
      live.delete(s);
      await backendPost('/devices/heartbeat', { serial_number: s, status: 'offline' });
      console.log(`[adb] dispositivo USB desconectado: ${s}`);
      try { const router = require('../router'); router.broadcast('device_offline', { serial_number: s }); } catch (_) {}
    }
  }
  // reconexión automática de dispositivos WiFi/TCP caídos
  await tryReconnectTcp(serials);
}

// Reintenta `adb connect` para las direcciones WiFi conocidas que ya no aparecen
// conectadas (throttle de 12s por dirección para no saturar).
async function tryReconnectTcp(currentSerials) {
  const nowT = Date.now();
  for (const [addr, lastTs] of knownTcp) {
    if (currentSerials.includes(addr)) { knownTcp.set(addr, 0); continue; }
    if (nowT - lastTs < 12000) continue;
    knownTcp.set(addr, nowT);
    try {
      const out = await adb(['connect', addr], { timeout: 8000, lowPriority: true });
      if (/connected/i.test(out || '')) console.log(`[adb] reconectado WiFi ${addr}`);
    } catch (_) {}
  }
}

// ---------- instalación de APK ----------
// Formatos de bundle que en realidad son un ZIP con el APK base + sus splits.
const BUNDLE_EXT = /\.(xapk|apks|apkm)$/i;

// Traduce los INSTALL_FAILED_* de adb a algo accionable. El texto crudo de adb
// no le dice nada a quien opera la granja.
function explainInstallError(raw) {
  const t = String(raw || '');
  const table = [
    [/INSTALL_FAILED_ALREADY_EXISTS/i, 'ya está instalada (usa Desinstalar app primero)'],
    [/INSTALL_FAILED_VERSION_DOWNGRADE|INSTALL_FAILED_UPDATE_INCOMPATIBLE/i, 'la versión instalada es más nueva o está firmada por otro autor; desinstálala antes'],
    [/INSTALL_FAILED_INSUFFICIENT_STORAGE/i, 'no hay espacio suficiente en el teléfono'],
    [/INSTALL_FAILED_MISSING_SPLIT/i, 'faltan los splits del bundle; instala el .xapk/.apks completo, no solo el APK base'],
    [/INSTALL_FAILED_NO_MATCHING_ABIS/i, 'el APK no es compatible con la arquitectura del teléfono'],
    [/INSTALL_FAILED_OLDER_SDK|INSTALL_FAILED_DEPRECATED_SDK_VERSION/i, 'el APK exige una versión de Android superior a la del teléfono'],
    [/INSTALL_FAILED_USER_RESTRICTED/i, 'el teléfono bloquea la instalación por USB; activa "Instalar vía USB" en Opciones de desarrollador'],
    [/INSTALL_FAILED_INVALID_APK|Invalid APK file/i, 'el archivo no es un APK válido o está corrupto'],
    [/device .* not found|device offline/i, 'el dispositivo no está accesible por ADB'],
    [/INSTALL_FAILED_VERIFICATION_FAILURE|verification/i, 'Play Protect bloqueó la instalación; desactiva la verificación de apps'],
  ];
  for (const [re, msg] of table) if (re.test(t)) return msg;
  const line = t.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || 'error desconocido';
  return line.slice(0, 160);
}

// Lector ZIP mínimo (solo lo que necesitamos: localizar los .apk de un bundle y
// extraerlos). Recorre el directorio central; admite entradas guardadas (0) y
// deflate (8), que es todo lo que usan los .xapk/.apks reales.
function extractApksFromZip(zipFile, outDir) {
  const zlib = require('zlib');
  const buf = fs.readFileSync(zipFile);
  // Fin del directorio central (EOCD): firma 0x06054b50, buscada desde el final
  // porque puede llevar comentario detrás.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('El archivo no es un ZIP válido (no se encontró el índice)');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const written = [];

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break; // fin del directorio central
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    // Solo APKs de la raíz del bundle; nada de rutas con ../ ni subcarpetas
    // (obb/, icon.png…), que no se instalan y evitan escrituras fuera de outDir.
    if (!/^[^/\\]+\.apk$/i.test(name)) continue;

    // La cabecera local repite los tamaños de nombre/extra, que pueden diferir
    // de los del directorio central: hay que leerlos de ahí.
    const lnameLen = buf.readUInt16LE(localOff + 26);
    const lextraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lnameLen + lextraLen;
    const raw = buf.subarray(start, start + compSize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);

    const dest = path.join(outDir, path.basename(name));
    fs.writeFileSync(dest, data);
    written.push(dest);
  }
  if (!written.length) throw new Error('El bundle no contiene ningún .apk en su raíz');
  return written;
}

// Normaliza lo que teclea el usuario y devuelve la lista de APK a instalar.
// Acepta: un .apk, una carpeta con base+splits, o un bundle .xapk/.apks/.apkm.
function resolveApkTarget(input) {
  // "Copiar como ruta de acceso" de Windows envuelve la ruta en comillas: si no
  // se quitan, adb busca un fichero cuyo nombre empieza literalmente por comilla.
  let apkPath = String(input ?? '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (!apkPath) throw new Error('No indicaste ninguna ruta de APK');
  if (!path.isAbsolute(apkPath)) throw new Error(`La ruta debe ser absoluta: "${apkPath}"`);
  if (!fs.existsSync(apkPath)) throw new Error(`No existe el archivo: "${apkPath}"`);

  const stat = fs.statSync(apkPath);

  if (stat.isDirectory()) {
    const files = fs.readdirSync(apkPath).filter(f => /\.apk$/i.test(f)).map(f => path.join(apkPath, f));
    if (!files.length) throw new Error(`La carpeta no contiene ningún .apk: "${apkPath}"`);
    return { files, label: `${path.basename(apkPath)} (${files.length} APK)`, cleanup: null };
  }

  if (BUNDLE_EXT.test(apkPath)) {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mcp-apk-'));
    let files;
    try { files = extractApksFromZip(apkPath, tmp); }
    catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error(`${path.basename(apkPath)}: ${e.message}`); }
    return {
      files,
      label: `${path.basename(apkPath)} (${files.length} APK)`,
      // Solo borra el temporal que acabamos de crear, nunca la ruta del usuario.
      cleanup: () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} },
    };
  }

  if (!/\.apk$/i.test(apkPath)) throw new Error(`Formato no soportado: "${path.basename(apkPath)}". Usa .apk, .xapk, .apks, .apkm o una carpeta con los APK.`);
  return { files: [apkPath], label: path.basename(apkPath), cleanup: null };
}

// ---------- traductor de comandos ----------
// Lee la jerarquía de la pantalla. Primero por el agente del dispositivo, que es
// el único camino fiable: `uiautomator dump` se ejecuta desde el PC y en estos
// teléfonos lo mata el sistema ("Killed", sin escribir el XML), sobre todo con
// TikTok delante, donde además el feed nunca queda "idle".
async function dumpUi(serial) {
  try {
    const xml = await agent.dump(serial);
    if (xml && xml.length > 100) return xml;
  } catch (_) { /* sin agente: se intenta el volcado clásico */ }

  await shell(serial, ['uiautomator', 'dump', '/sdcard/mcp_ui.xml']).catch(() => {});
  return shell(serial, ['cat', '/sdcard/mcp_ui.xml']).catch(() => '');
}

function findBoundsBy(xml, attr, value) {
  // busca el primer nodo cuyo attr contiene value y devuelve el centro de sus bounds
  const re = new RegExp(`<node[^>]*\\b${attr}="[^"]*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`, 'i');
  const m = xml.match(re);
  if (!m) return null;
  return { x: Math.round((+m[1] + +m[3]) / 2), y: Math.round((+m[2] + +m[4]) / 2) };
}

function findFirstActionableBounds(xml, { minY = 250, maxY = 100000, excludeText = '' } = {}) {
  const excluded = String(excludeText || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const nodes = String(xml || '').match(/<node\b[^>]*>/gi) || [];
  for (const node of nodes) {
    if (!/clickable="true"/i.test(node) || /enabled="false"/i.test(node)) continue;
    const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
    if (!bounds) continue;
    const x = Math.round((Number(bounds[1]) + Number(bounds[3])) / 2);
    const y = Math.round((Number(bounds[2]) + Number(bounds[4])) / 2);
    if (y < Number(minY) || y > Number(maxY)) continue;
    const text = ['text', 'content-desc'].map(attr => {
      const match = node.match(new RegExp(`${attr}="([^"]*)"`, 'i'));
      return match ? match[1] : '';
    }).join(' ').trim();
    if (!text || excluded.some(term => text.toLowerCase().includes(term))) continue;
    return { x, y, text };
  }
  return null;
}

async function tapText(serial, text) {
  const xml = await dumpUi(serial);
  const b = findBoundsBy(xml, 'text', text) || findBoundsBy(xml, 'content-desc', text);
  if (!b) return { success: false, message: `No encontrado por texto: ${text}` };
  const j = HJ(b.x, b.y);
  await shell(serial, ['input', 'tap', String(j.x), String(j.y)]);
  return { success: true, message: `Tap en '${text}'` };
}
async function tapId(serial, id) {
  const xml = await dumpUi(serial);
  const b = findBoundsBy(xml, 'resource-id', id);
  if (!b) return { success: false, message: `No encontrado por id: ${id}` };
  const j = HJ(b.x, b.y);
  await shell(serial, ['input', 'tap', String(j.x), String(j.y)]);
  return { success: true, message: `Tap en id '${id}'` };
}

// Contexto que reutilizan las suites de scripts: misma cola de concurrencia ADB,
// mismo jitter humano y mismo dump de UI que el resto del módulo.
async function execute(serial, command, params) {
  if (!isAllowedSerial(serial)) {
    return { success: false, message: `ADB serial fuera del alcance aprobado: ${serial}` };
  }
  const p = params || {};

  // Compatibilidad con el nombre anterior de la suite de TikTok. La migración de
  // la base de datos reescribe las rutinas guardadas, pero una petición externa
  // (el MCP, un script del usuario, una integración) puede seguir mandando el
  // nombre viejo; aquí se traduce en vez de fallar.
  if (typeof command === 'string' && command.startsWith('TIKMATRIX_')) {
    command = 'TIKTOK_' + command.slice('TIKMATRIX_'.length);
  }

  // Los scripts largos (warmup, campañas, boost lives…) viven en sus módulos:
  // son bucles con estado, no comandos de una línea como el resto del switch.
  if (tiktok.handles(command)) {
    const script = createScriptContext(serial);
    try {
      return await tiktok.run(script.ctx, serial, command, p);
    } catch (e) {
      return { success: false, message: `${command}: ${e.message}` };
    } finally {
      script.finish();
    }
  }

  if (spotify.handles(command)) {
    const script = createScriptContext(serial);
    try {
      return await spotify.run(script.ctx, serial, command, p);
    } catch (e) {
      return { success: false, message: `${command}: ${e.message}` };
    } finally {
      script.finish();
    }
  }

  if (twitch.handles(command)) {
    const script = createScriptContext(serial);
    try {
      return await twitch.run(script.ctx, serial, command, p);
    } catch (e) {
      return { success: false, message: `${command}: ${e.message}` };
    } finally {
      script.finish();
    }
  }

  try {
    switch (command) {
      // Acepta package_name y packageName: las rutinas usan una forma y el panel
      // la otra. Antes, quien pasara solo packageName mandaba `undefined` a monkey.
      case 'OPEN_APP': {
        const pkg = String(p.packageName || p.package_name || '').trim();
        if (!pkg) return { success: false, message: 'Falta el nombre de paquete' };
        await shell(serial, ['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
        await sleep(2000);
        return { success: true, message: `App abierta: ${pkg}` };
      }

      case 'GOTO_URL':
        await shell(serial, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', String(p.url ?? '')]);
        await sleep(2000);
        return { success: true, message: `URL abierta: ${p.url}` };

      case 'GET_FOREGROUND_APP': {
        const activities = String(await shell(serial, ['dumpsys', 'activity', 'activities']));
        let match = activities.match(/(?:topResumedActivity|mResumedActivity)[^\n]*?\s([A-Za-z0-9._]+)\/[A-Za-z0-9.$_]+/);
        if (!match) {
          const windows = String(await shell(serial, ['dumpsys', 'window', 'windows']));
          match = windows.match(/mCurrentFocus[^\n]*?\s([A-Za-z0-9._]+)\/[A-Za-z0-9.$_]+/);
        }
        const packageName = match && match[1];
        return packageName
          ? { success: true, message: `App visible: ${packageName}`, data: { package_name: packageName } }
          : { success: false, message: 'No se pudo identificar la app visible' };
      }

      case 'CLICK_BY_TEXT':
        return await tapText(serial, String(p.text ?? ''));

      case 'CLICK_BY_ID':
        return await tapId(serial, String(p.resource_id ?? ''));

      case 'CLICK_FIRST_ACTIONABLE': {
        const xml = await dumpUi(serial);
        const match = findFirstActionableBounds(xml, {
          minY: Number(p.min_y ?? 250),
          maxY: Number(p.max_y ?? 100000),
          excludeText: p.exclude_text || '',
        });
        if (!match) return { success: false, message: 'No actionable UI element matched the configured region' };
        const point = HJ(match.x, match.y);
        await shell(serial, ['input', 'tap', String(point.x), String(point.y)]);
        return { success: true, message: `First actionable item tapped: ${match.text}`, data: { text: match.text, x: match.x, y: match.y } };
      }

      case 'SET_TEXT': {
        if (p.resource_id) { const t = await tapId(serial, String(p.resource_id)); if (!t.success) return t; }
        await sleep(300);
        const value = String(p.value ?? '').replace(/ /g, '%s');
        await shell(serial, ['input', 'text', value]);
        return { success: true, message: 'Texto escrito' };
      }

      case 'SCROLL': {
        const s = await screenSize(serial);
        const cxj = HJ(Math.round(s.w / 2), 0).x;
        const down = (p.direction || 'down') !== 'up';
        const y1 = down ? Math.round(s.h * 0.7) : Math.round(s.h * 0.3);
        const y2 = down ? Math.round(s.h * 0.3) : Math.round(s.h * 0.7);
        await shell(serial, ['input', 'swipe', String(cxj), String(y1), String(cxj), String(y2), String(HD(300))]);
        return { success: true, message: `Scroll ${p.direction || 'down'}` };
      }

      case 'SWIPE':
        await shell(serial, ['input', 'swipe', String(p.start_x ?? 300), String(p.start_y ?? 1000), String(p.end_x ?? 300), String(p.end_y ?? 400), String(HD(300))]);
        return { success: true, message: 'Swipe' };

      case 'PRESS_BACK':
        await shell(serial, ['input', 'keyevent', '4']); return { success: true, message: 'Back' };
      case 'PRESS_HOME':
        await shell(serial, ['input', 'keyevent', '3']); return { success: true, message: 'Home' };

      case 'PLAY_MEDIA':
        await sleep((p.duration_seconds ?? 30) * 1000);
        return { success: true, message: `Reproducido ${p.duration_seconds ?? 30}s` };

      case 'PAUSE_MEDIA': {
        const s = await screenSize(serial);
        await shell(serial, ['input', 'tap', String(Math.round(s.w / 2)), String(Math.round(s.h / 2))]);
        return { success: true, message: 'Pausa (tap central)' };
      }

      case 'WAIT':
      case 'TYPING_DELAY':
        await sleep(Math.min(p.duration ?? 1000, 60000));
        return { success: true, message: `Espera ${p.duration ?? 1000}ms` };

      case 'WAIT_FOR_ELEMENT': {
        const timeout = (p.timeout_ms ?? 10000);
        const start = Date.now();
        const needleText = p.text, needleId = p.resource_id;
        while (Date.now() - start < timeout) {
          const xml = await dumpUi(serial);
          if ((needleText && (findBoundsBy(xml, 'text', String(needleText)) || findBoundsBy(xml, 'content-desc', String(needleText)))) ||
              (needleId && findBoundsBy(xml, 'resource-id', String(needleId)))) {
            return { success: true, message: 'Elemento encontrado' };
          }
          await sleep(500);
        }
        return { success: false, message: 'Timeout esperando elemento' };
      }

      case 'CAPTURE_SCREEN': {
        const png = await adb(['-s', serial, 'exec-out', 'screencap', '-p'], { binary: true });
        const b64 = Buffer.from(png).toString('base64');
        await backendPost(`/devices/${serial}/screenshot`, { image_data: b64 });
        return { success: true, message: 'Captura tomada', data: { image: b64, bytes: png.length } };
      }

      case 'REPORT_RESULT':
        return { success: true, message: 'Resultado reportado' };

      case 'KEEP_AWAKE':
        await applyStability(serial);
        return { success: true, message: 'Mantener despierto activado' };

      case 'SET_TIME_AUTO': {
        // Hora/fecha automática por red (evita relojes desfasados que rompen HTTPS/logins).
        const on = p.enabled === false ? '0' : '1';
        await shell(serial, ['settings', 'put', 'global', 'auto_time', on]);
        await shell(serial, ['settings', 'put', 'global', 'auto_time_zone', on]);
        return { success: true, message: on === '1' ? 'Hora automática activada' : 'Hora automática desactivada' };
      }

      case 'SET_TIMEZONE': {
        // Zona horaria fija (para cuadrar con la IP/proxy). Desactiva auto_time_zone
        // para que la red no la sobrescriba, pero deja auto_time (reloj correcto).
        const tz = String(p.timezone || p.tz || '').trim();
        if (!tz) return { success: false, message: 'Zona horaria requerida' };
        await shell(serial, ['settings', 'put', 'global', 'auto_time', '1']);
        await shell(serial, ['settings', 'put', 'global', 'auto_time_zone', '0']);
        // Varias vías según versión/permisos de Android:
        await shell(serial, ['service', 'call', 'alarm', '3', 's16', tz]).catch(() => {});
        await shell(serial, ['cmd', 'time_zone_detector', 'set_time_zone_state_for_tests', tz, 'true']).catch(() => {});
        await shell(serial, ['setprop', 'persist.sys.timezone', tz]).catch(() => {});
        const cur = (await shell(serial, ['getprop', 'persist.sys.timezone']).catch(() => '')).trim();
        const ok = cur === tz;
        return { success: true, message: ok ? `Zona horaria: ${tz}` : `Zona horaria solicitada: ${tz} (actual: ${cur || 'desconocida'})`, data: { timezone: cur || tz, applied: ok } };
      }

      case 'GET_TIME': {
        const date = (await shell(serial, ['date'])).trim();
        const tz = (await shell(serial, ['getprop', 'persist.sys.timezone']).catch(() => '')).trim();
        return { success: true, message: `Hora: ${date}`, data: { date, timezone: tz } };
      }

      // ---- Proxy / IP de salida por dispositivo ----
      case 'SET_PROXY': {
        if (p.user || p.username || p.password) {
          return { success: false, message: 'Android por ADB no admite autenticación en el proxy HTTP global' };
        }
        return maintenance.setProxy(serial, p, shell);
      }

      case 'TEST_HTTP_PROXY': {
        const proxy = maintenance.normalizeProxyParams(p);
        const timeoutMs = Math.min(Math.max(Number(p.timeout_ms) || 10000, 1000), 30000);
        const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
        const started = Date.now();
        let observed;
        try {
          observed = String(await shell(serial, [
            'curl', '-fsS', '--connect-timeout', String(Math.min(timeoutSeconds, 10)),
            '--max-time', String(timeoutSeconds), '--proxy', `http://${proxy.value}`,
            'https://api.ipify.org',
          ], { timeout: timeoutMs + 3000 })).trim();
        } catch (error) {
          return { success: false, message: `No se pudo probar ${proxy.value}: ${error.message}` };
        }
        const validIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(observed);
        const expected = String(p.expected_public_ip || '').trim() || null;
        const matches = validIp && (!expected || observed === expected);
        return {
          success: matches,
          message: matches ? `Ruta ${proxy.value} verificada` : `IP inesperada a través de ${proxy.value}`,
          data: {
            proxy: proxy.value,
            external_ip: validIp ? observed : null,
            expected_public_ip: expected,
            matches,
            latency_ms: Date.now() - started,
          },
        };
      }

      case 'CLEAR_PROXY':
        return maintenance.clearProxy(serial, shell);

      case 'GET_PROXY':
      case 'DEVICE_NETWORK_STATUS':
        return maintenance.getNetworkStatus(serial, shell);

      case 'DEVICE_STABILIZE':
        return maintenance.stabilizeDevice(serial, p, shell);

      // ---- Cuentas Google: solo UI nativa y conteo sanitizado ----
      case 'GET_GOOGLE_ACCOUNTS': {
        const dump = await shell(serial, ['dumpsys', 'account']);
        const matches = String(dump).match(/Account\s*\{[^}]*type=com\.google[^}]*\}/g) || [];
        return {
          success: true,
          message: `${matches.length} cuenta(s) Google detectada(s)`,
          data: { account_count: matches.length, identifiers_exposed: false },
        };
      }

      case 'OPEN_GOOGLE_ACCOUNT_ENROLLMENT': {
        await shell(serial, [
          'am', 'start', '-a', 'android.settings.ADD_ACCOUNT_SETTINGS',
          '--esa', 'account_types', 'com.google',
        ]);
        return {
          success: true,
          message: 'Pantalla nativa para agregar una cuenta Google abierta',
          data: { provider: 'google', credentials_captured: false },
        };
      }

      case 'OPEN_GOOGLE_ACCOUNT_SETTINGS': {
        await shell(serial, [
          'am', 'start', '-a', 'android.settings.SYNC_SETTINGS',
          '--esa', 'account_types', 'com.google',
        ]);
        return {
          success: true,
          message: 'Pantalla nativa de cuentas Google abierta',
          data: { provider: 'google', credentials_captured: false },
        };
      }

      case 'DEVICE_HEALTH': {
        // Batería, temperatura, carga y almacenamiento libre.
        let battery = null, tempC = null, charging = null, freeMb = null;
        try {
          const bat = await shell(serial, ['dumpsys', 'battery']);
          const lvl = bat.match(/level:\s*(\d+)/); if (lvl) battery = +lvl[1];
          const tmp = bat.match(/temperature:\s*(\d+)/); if (tmp) tempC = +tmp[1] / 10; // décimas de grado
          const st = bat.match(/status:\s*(\d+)/); if (st) charging = (st[1] === '2' || st[1] === '5') ? 1 : 0; // 2=charging,5=full
        } catch (_) {}
        try {
          const df = await shell(serial, ['df', '/data']);
          const line = df.trim().split(/\r?\n/).pop();
          const cols = line.trim().split(/\s+/);
          // "Available" suele ser la 4ª columna en KB (o con sufijo). Buscamos un valor con K/M/G.
          const avail = cols.find(c => /^[\d.]+[KMG]?$/.test(c) && cols.indexOf(c) >= 3);
          if (avail) {
            const num = parseFloat(avail);
            freeMb = /G$/.test(avail) ? Math.round(num * 1024) : /K$/.test(avail) ? Math.round(num / 1024) : /M$/.test(avail) ? Math.round(num) : Math.round(num / 1024);
          }
        } catch (_) {}
        return { success: true, message: `Batería ${battery}% · ${tempC}°C`, data: { battery, temperature_c: tempC, charging, storage_free_mb: freeMb } };
      }

      case 'READ_SCREEN_TEXT': {
        // Devuelve todo el texto visible (text= y content-desc=) del volcado de UI,
        // para que el monitor busque señales de baneo/captcha/verificación.
        const xml = await dumpUi(serial);
        const texts = [];
        const re = /(?:text|content-desc)="([^"]*)"/g; let m;
        while ((m = re.exec(xml))) { const s = m[1].trim(); if (s) texts.push(s); }
        const uniq = [...new Set(texts)];
        return { success: true, message: `Texto leído (${uniq.length} elementos)`, data: { text: uniq.join(' | '), items: uniq } };
      }

      case 'CHECK_IP': {
        // Intenta la IP externa desde el propio dispositivo (a través de su proxy si lo tiene).
        let ip = '', method = '';
        const proxy = (await shell(serial, ['settings', 'get', 'global', 'http_proxy']).catch(() => '')).trim();
        const proxyActive = !!(proxy && proxy !== ':0' && proxy !== 'null');
        const curlArgs = ['curl', '-s', '--max-time', '8'];
        if (proxyActive) curlArgs.push('--proxy', `http://${proxy}`);
        curlArgs.push('https://api.ipify.org');
        try { ip = (await shell(serial, curlArgs, { timeout: 12000 })).trim(); method = proxyActive ? 'curl+global-proxy' : 'curl'; } catch (_) {}
        if (!proxyActive && !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
          try { ip = (await shell(serial, ['toybox', 'wget', '-qO-', 'http://api.ipify.org'], { timeout: 12000 })).trim(); method = 'toybox'; } catch (_) {}
        }
        let localIp = '';
        try { const m = (await shell(serial, ['ip', 'route'])).match(/src (\d+\.\d+\.\d+\.\d+)/); localIp = m ? m[1] : ''; } catch (_) {}
        const ok = /^\d+\.\d+\.\d+\.\d+$/.test(ip);
        return {
          success: ok,
          message: ok ? `IP externa: ${ip}` : (localIp ? `IP local: ${localIp} (externa no disponible; falta curl/wget)` : 'No se pudo obtener IP'),
          data: { external_ip: ok ? ip : null, local_ip: localIp || null, proxy: proxyActive ? proxy : null, method },
        };
      }

      // ---- Utilidades ADB (catálogo de herramientas para granja de teléfonos) ----
      case 'TAP_XY': {
        const j = HJ(Number(p.x ?? 0), Number(p.y ?? 0));
        await shell(serial, ['input', 'tap', String(j.x), String(j.y)]);
        return { success: true, message: `Tap en (${j.x},${j.y})` };
      }

      case 'INPUT_KEYEVENT':
        await shell(serial, ['input', 'keyevent', String(p.keycode ?? '4')]);
        return { success: true, message: `Keyevent ${p.keycode}` };

      case 'TYPE_TEXT':
        await shell(serial, ['input', 'text', String(p.value ?? '').replace(/ /g, '%s')]);
        return { success: true, message: 'Texto escrito' };

      // ---- AGENTE BSOLUTIONS EN EL DISPOSITIVO ----
      // Instala el agente propio del proyecto (android-agent -> dev.mcp.agent) y,
      // si hay alguno compatible con uiautomator2 disponible en el equipo, también,
      // porque hoy es el único que sabe devolver la jerarquía completa de la
      // pantalla. Sin esa lectura los scripts no encuentran los controles.
      case 'INSTALL_AGENT':
      case 'TIKTOK_INSTALL_AGENT': {          // nombre antiguo: rutinas guardadas
        const instalados = [];
        const fallos = [];

        const instalar = async (ruta, etiqueta, paquete) => {
          if (!fs.existsSync(ruta)) return false;
          let out = String(await adb(['-s', serial, 'install', '-r', '-g', ruta], { timeout: 180000 })
            .catch(e => e.message || ''));

          // Firma distinta a la del APK ya instalado: Android no deja actualizar
          // encima. Hay que desinstalar, y eso revoca el permiso de accesibilidad,
          // así que se avisa en el resultado para que el operador lo reactive.
          if (/signatures do not match|INSTALL_FAILED_UPDATE_INCOMPATIBLE/i.test(out) && paquete) {
            await adb(['-s', serial, 'uninstall', paquete], { timeout: 60000 }).catch(() => {});
            out = String(await adb(['-s', serial, 'install', '-r', '-g', ruta], { timeout: 180000 })
              .catch(e => e.message || ''));
            if (/Success/i.test(out)) {
              instalados.push(`${etiqueta} (reinstalado: reactiva su permiso de accesibilidad)`);
              return true;
            }
          }

          if (/Success/i.test(out)) { instalados.push(etiqueta); return true; }
          fallos.push(`${etiqueta}: ${explainInstallError(out)}`);
          return false;
        };

        // 1. Agente Bsolutions (el de este repositorio).
        const propio = [
          CONFIG.agentApkPath,
          app_ruta_recurso('agent', 'mcp-agent.apk'),
          path.resolve(__dirname, '..', '..', 'android-agent', 'mcp-agent-debug.apk'),
        ].filter(Boolean).find(r => { try { return fs.existsSync(r); } catch (_) { return false; } });

        if (propio) {
          // El paquete lleva sufijo .debug en la compilación de depuración; se
          // intenta desinstalar el que corresponda si hubiera choque de firmas.
          const yaInstalados = String(await shell(serial, ['pm', 'list', 'packages']).catch(() => ''));
          const paqueteExistente = ['dev.mcp.agent.debug', 'dev.mcp.agent']
            .find(pk => yaInstalados.includes(`package:${pk}`)) || 'dev.mcp.agent.debug';
          await instalar(propio, 'Agente Bsolutions', paqueteExistente);
        } else {
          fallos.push('no se encontró el APK del Agente Bsolutions');
        }

        // 2. Lector de UI compatible con uiautomator2, si está disponible.
        const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
        for (const [archivo, etiqueta] of [
          ['com.github.tikmatrix.apk', 'lector de UI'],
          ['com.github.tikmatrix.test.apk', 'lector de UI (instrumentación)'],
        ]) {
          await instalar(path.join(appData, 'com.tikmatrix', 'bin', archivo), etiqueta);
        }

        // Teclado rápido: escribe sin abrir el teclado del sistema.
        await shell(serial, ['ime', 'enable', 'com.github.tikmatrix/.FastInputIME']).catch(() => {});
        await shell(serial, ['ime', 'set', 'com.github.tikmatrix/.FastInputIME']).catch(() => {});

        return {
          success: instalados.length > 0,
          message: instalados.length
            ? `Instalado en el dispositivo: ${instalados.join(', ')}${fallos.length ? ` · pendiente: ${fallos.join('; ')}` : ''}`
            : `No se pudo instalar ningún agente. ${fallos.join('; ')}`,
          data: { instalados, fallos },
        };
      }

      // Estado del agente en el teléfono: si está, con qué versión, y si su
      // servicio de accesibilidad está activo (que es lo único que no se puede
      // automatizar y suele ser lo que falta).
      case 'AGENT_STATUS': {
        const e = await agent.estadoEnDispositivo(serial);
        const partes = [];
        if (!e.instalado) partes.push('agente NO instalado');
        else {
          partes.push(`agente ${e.version || 'instalado'} (${e.paquete})`);
          partes.push(e.accesibilidad ? 'accesibilidad activa' : 'accesibilidad DESACTIVADA');
        }
        return {
          success: !!e.instalado && e.accesibilidad,
          message: partes.join(' · '),
          data: e,
        };
      }

      case 'TIKTOK_SET_TEXT': {
        const val = String(p.value ?? p.text ?? '');
        await shell(serial, ['am', 'broadcast', '-a', 'ADB_SET_TEXT', '--es', 'text', val]);
        return { success: true, message: `Texto enviado al dispositivo: "${val.slice(0, 20)}..."` };
      }

      case 'TIKTOK_CLEAR_TEXT':
        await shell(serial, ['am', 'broadcast', '-a', 'ADB_CLEAR_TEXT']);
        return { success: true, message: 'Campo de texto limpiado' };

      case 'TIKTOK_SIMULATE_TYPING': {
        const val = String(p.value ?? p.text ?? '');
        await shell(serial, ['am', 'broadcast', '-a', 'ADB_SIMULATE_TYPING', '--es', 'text', val]);
        return { success: true, message: `Tipeo simulado enviado` };
      }

      case 'TIKTOK_CLEAR_DCIM': {
        await shell(serial, ['rm', '-f', '/storage/emulated/0/DCIM/*.mp4', '/storage/emulated/0/DCIM/*.jpg', '/storage/emulated/0/DCIM/*.png']).catch(() => {});
        await shell(serial, ['rm', '-f', '/storage/emulated/0/DCIM/Camera/*.mp4', '/storage/emulated/0/DCIM/Camera/*.jpg', '/storage/emulated/0/DCIM/Camera/*.png']).catch(() => {});
        await shell(serial, ['rm', '-f', '/sdcard/*.mp4', '/sdcard/*.jpg', '/sdcard/*.png']).catch(() => {});
        return { success: true, message: 'Galería DCIM / sdcard limpiada correctamente' };
      }

      case 'TIKTOK_OPEN_TIKTOK': {
        await shell(serial, ['am', 'start', '-n', 'com.zhiliaoapp.musically/com.ss.android.ugc.aweme.splash.SplashActivity']);
        return { success: true, message: 'TikTok abierto en el dispositivo' };
      }

      // --- TIKMATRIX FULL SCRIPTS SUITE REPLICATION ---
      case 'TIKTOK_BROWSE_FEED': {
        // Navega orgánicamente por el feed deslicando hacia arriba
        const dev = live.get(serial);
        const w = dev?.size?.w || 1080, h = dev?.size?.h || 2400;
        const startY = Math.round(h * 0.75), endY = Math.round(h * 0.25), x = Math.round(w * 0.5);
        const count = Number(p.count || p.video_count || 5);
        for (let i = 0; i < count; i++) {
          const swipeDuration = Math.floor(Math.random() * 150) + 200;
          await shell(serial, ['input', 'swipe', String(x), String(startY), String(x), String(endY), String(swipeDuration)]);
          const watchTimeSec = Math.floor(Math.random() * 7) + 5;
          await sleep(watchTimeSec * 1000);
        }
        return { success: true, message: `Navegación orgánica de feed completada (${count} videos)` };
      }

      case 'TIKTOK_LIKE_FEED': {
        // Da Me Gusta al vídeo actual (doble tap o clic en botón Me Gusta)
        const dev = live.get(serial);
        const w = dev?.size?.w || 1080, h = dev?.size?.h || 2400;
        const x = Math.round(w * 0.5), y = Math.round(h * 0.5);
        await shell(serial, ['input', 'tap', String(x), String(y)]);
        await sleep(100);
        await shell(serial, ['input', 'tap', String(x), String(y)]);
        return { success: true, message: 'Me Gusta (Like) enviado a la publicación' };
      }

      case 'TIKTOK_FAVORITE_VIDEO': {
        // Guarda en favoritos (doble tap o intento en barra lateral derecha)
        const dev = live.get(serial);
        const w = dev?.size?.w || 1080, h = dev?.size?.h || 2400;
        const favX = Math.round(w * 0.92), favY = Math.round(h * 0.62);
        await shell(serial, ['input', 'tap', String(favX), String(favY)]);
        return { success: true, message: 'Publicación guardada en Favoritos' };
      }

      case 'TIKTOK_COMMENT_FEED': {
        // Comenta la publicación activa con el texto o lista proporcionada
        const commentText = String(p.comment || p.text || p.caption || 'Awesome! 🔥').trim();
        const dev = live.get(serial);
        const w = dev?.size?.w || 1080, h = dev?.size?.h || 2400;
        const btnX = Math.round(w * 0.92), btnY = Math.round(h * 0.54);
        await shell(serial, ['input', 'tap', String(btnX), String(btnY)]); // Abrir comentarios
        await sleep(1500);
        await shell(serial, ['am', 'broadcast', '-a', 'ADB_SET_TEXT', '--es', 'text', commentText]).catch(async () => {
          await shell(serial, ['input', 'text', commentText.replace(/ /g, '%s')]);
        });
        await sleep(800);
        await shell(serial, ['input', 'keyevent', '66']); // Enter / Send
        await sleep(1000);
        await shell(serial, ['input', 'keyevent', '4']);  // Back
        return { success: true, message: `Comentario publicado: "${commentText.slice(0, 20)}..."` };
      }

      case 'TIKTOK_FOLLOW_USER': {
        // Busca usuario por username y pulsa Seguir
        const target = String(p.username || p.target || '').replace(/^@/, '').trim();
        if (!target) return { success: false, message: 'Falta nombre de usuario (target)' };
        await shell(serial, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', `snssdk1128://user/profile/${target}`]).catch(async () => {
          await shell(serial, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', `https://www.tiktok.com/@${target}`]);
        });
        await sleep(2500);
        const dev = live.get(serial);
        const w = dev?.size?.w || 1080, h = dev?.size?.h || 2400;
        const followX = Math.round(w * 0.5), followY = Math.round(h * 0.28);
        await shell(serial, ['input', 'tap', String(followX), String(followY)]);
        return { success: true, message: `Seguir enviado a @${target}` };
      }

      case 'TIKTOK_UNFOLLOW_ALL': {
        // Descorrido masivo en la lista de seguidos
        const limit = Number(p.limit || 10);
        const dev = live.get(serial);
        const w = dev?.size?.w || 1080, h = dev?.size?.h || 2400;
        const btnX = Math.round(w * 0.85);
        for (let i = 0; i < limit; i++) {
          const btnY = Math.round(h * (0.2 + (i % 5) * 0.08));
          await shell(serial, ['input', 'tap', String(btnX), String(btnY)]);
          await sleep(600);
        }
        return { success: true, message: `Dejar de seguir procesado (${limit} perfiles)` };
      }

      case 'TIKTOK_SEND_DM': {
        // Envío de mensaje privado directo (DM)
        const target = String(p.username || p.target || '').replace(/^@/, '').trim();
        const msg = String(p.message || p.text || 'Hola! 👋').trim();
        if (!target) return { success: false, message: 'Falta username de destino' };
        await shell(serial, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', `https://www.tiktok.com/@${target}`]);
        await sleep(2500);
        await shell(serial, ['am', 'broadcast', '-a', 'ADB_SET_TEXT', '--es', 'text', msg]);
        await sleep(800);
        await shell(serial, ['input', 'keyevent', '66']);
        return { success: true, message: `Mensaje directo enviado a @${target}` };
      }

      case 'TIKTOK_POST_VIDEO': {
        // Carga y publicación de video con pie de foto
        const caption = String(p.caption || p.postCaption || 'Check this out! #fyp #viral').trim();
        const dev = live.get(serial);
        const w = dev?.size?.w || 1080, h = dev?.size?.h || 2400;
        const plusX = Math.round(w * 0.5), plusY = Math.round(h * 0.95);
        await shell(serial, ['input', 'tap', String(plusX), String(plusY)]); // Clic en Botón +
        await sleep(2000);
        const nextX = Math.round(w * 0.85), nextY = Math.round(h * 0.93);
        await shell(serial, ['input', 'tap', String(nextX), String(nextY)]); // Siguiente
        await sleep(1500);
        await shell(serial, ['am', 'broadcast', '-a', 'ADB_SET_TEXT', '--es', 'text', caption]);
        await sleep(1000);
        await shell(serial, ['input', 'tap', String(nextX), String(nextY)]); // Publicar
        return { success: true, message: `Publicación iniciada con pie de foto: "${caption.slice(0, 20)}..."` };
      }

      case 'TIKTOK_WATCHER_TICK': {
        // Detector de diálogos/popups (dialog_watcher): cierra popups molestos automáticamente
        const xml = await dumpUi(serial).catch(() => '');
        const autoDismiss = ['Permitir', 'Allow', 'Entendido', 'Got it', 'Ahora no', 'Not now', 'Cancelar', 'Cancel', 'Aceptar', 'OK', 'Continuar'];
        let matched = null;
        for (const label of autoDismiss) {
          if (xml.includes(label)) {
            matched = label;
            break;
          }
        }
        if (matched) {
          await shell(serial, ['am', 'broadcast', '-a', 'ADB_SET_TEXT', '--es', 'text', '']).catch(() => {});
          await shell(serial, ['input', 'keyevent', '4']).catch(() => {}); // Clic en Back para cerrar popup
          return { success: true, message: `Popup detectado ("${matched}") y cerrado automáticamente`, data: { dismissed: matched } };
        }
        return { success: true, message: 'No se detectaron popups molestos en pantalla', data: { dismissed: null } };
      }

      case 'TIKTOK_SCRAPE_ACCOUNT': {
        // Scrapeo de analíticas y seguidores visibles de la cuenta
        const xml = await dumpUi(serial).catch(() => '');
        const reNumbers = /(\d+(?:\.\d+)?[KMB]?)\s*(?:Followers|Seguidores|Likes|Me gusta|Following|Siguiendo)/gi;
        const metrics = [];
        let match;
        while ((match = reNumbers.exec(xml)) !== null) {
          metrics.push(match[0]);
        }
        return {
          success: true,
          message: metrics.length ? `Métricas extraídas: ${metrics.join(' | ')}` : 'No se encontraron métricas visibles en pantalla',
          data: { metrics, raw_len: xml.length }
        };
      }

      case 'TIKTOK_ROTATE_PROXY': {
        // Rotación de IP de proxy dinámico/móvil vía URL de refresco.
        // El handle abierto llega por adb.start({ db }) desde main.js. Requerir
        // '../server/db' aquí devolvía el MÓDULO (solo exporta open/now/pruneLogs),
        // así que db.get no existía y el comando fallaba siempre.
        const db = CONFIG.db;
        if (!db) return { success: false, message: 'Base de datos no disponible en el transporte ADB' };
        const row = db.get(`SELECT * FROM proxy_rotations WHERE device_serial = ?`, [serial]);
        if (!row || !row.rotation_url) {
          return { success: false, message: 'Dispositivo sin URL de rotación de proxy configurada' };
        }

        // Verificar período de enfriamiento (cooldown)
        const now = Date.now();
        if (row.last_rotated_at && row.cooldown_secs > 0) {
          const lastTs = new Date(row.last_rotated_at).getTime();
          if (now - lastTs < row.cooldown_secs * 1000) {
            return { success: true, message: `Rotación omitida por enfriamiento (cooldown ${row.cooldown_secs}s)` };
          }
        }

        let ok = false, msg = '', statusCode = 0;
        try {
          const url = row.rotation_url;
          const method = (row.method || 'GET').toUpperCase();
          const headers = row.headers ? JSON.parse(row.headers) : {};
          // fetch() ignora la clave `timeout`: sin AbortSignal, un proveedor que
          // no responde dejaba la rotación colgada indefinidamente.
          const opts = { method, headers, signal: AbortSignal.timeout(row.timeout_ms || 10000) };
          if (row.body && method !== 'GET') opts.body = row.body;

          const res = await fetch(url, opts);
          statusCode = res.status;
          const bodyText = await res.text();
          ok = res.ok;
          msg = `HTTP ${res.status}: ${bodyText.slice(0, 80)}`;
        } catch (e) {
          ok = false;
          msg = `Error de conexión: ${e.message}`;
        }

        const isoNow = new Date().toISOString();
        if (db) {
          db.run(`UPDATE proxy_rotations SET last_status = ?, last_message = ?, last_rotated_at = ?, updated_at = ? WHERE device_serial = ?`,
            [ok ? 1 : 0, msg, isoNow, isoNow, serial]);
        }

        if (ok && row.wait_secs > 0) {
          await sleep(row.wait_secs * 1000);
        }

        return {
          success: ok,
          message: ok ? `Rotación de IP solicitada correctamente (${msg}). Esperando ${row.wait_secs}s` : `Fallo al rotar IP: ${msg}`,
          data: { status: statusCode, message: msg, rotated_at: isoNow }
        };
      }

      // OPEN_APP y GOTO_URL se atienden más arriba; este bloque duplicado era
      // código muerto (un switch solo entra en el primer case que coincide).

      case 'START_ACTIVITY':
        await shell(serial, ['am', 'start', '-n', String(p.component ?? '')]);
        await sleep(1500);
        return { success: true, message: `Actividad ${p.component}` };

      case 'FORCE_STOP':
        await shell(serial, ['am', 'force-stop', String(p.package_name ?? '')]);
        return { success: true, message: `Detenida ${p.package_name}` };

      case 'CLEAR_APP':
        await shell(serial, ['pm', 'clear', String(p.package_name ?? '')]);
        return { success: true, message: `Datos borrados ${p.package_name}` };

      case 'UNINSTALL_APP': {
        const pkg = String(p.package_name ?? '').trim();
        if (!pkg) return { success: false, message: 'Falta package_name' };
        // `pm uninstall` sale con código 0 aunque falle: escribe "Failure [...]"
        // en stdout. Sin mirar la salida, desinstalar una app ausente se
        // reportaba como éxito.
        const out = String(await shell(serial, ['pm', 'uninstall', pkg]).catch(e => e.message || ''));
        if (/Success/i.test(out)) return { success: true, message: `Desinstalada ${pkg}` };
        if (/DELETE_FAILED_INTERNAL_ERROR|Unknown package|not installed/i.test(out)) {
          return { success: false, message: `${pkg} no estaba instalada en este dispositivo` };
        }
        if (/DELETE_FAILED_DEVICE_POLICY_MANAGER/i.test(out)) {
          return { success: false, message: `${pkg} está protegida por política del dispositivo` };
        }
        return { success: false, message: `No se pudo desinstalar ${pkg}: ${out.trim().split(/\r?\n/).pop() || 'motivo desconocido'}` };
      }

      case 'INSTALL_APK': {
        let target;
        try { target = resolveApkTarget(p.apk_path); }
        catch (e) { return { success: false, message: e.message }; }

        // Los bundles (varios APK: base + splits) exigen `install-multiple`;
        // `install` a secas falla con INSTALL_FAILED_MISSING_SPLIT.
        const args = target.files.length > 1
          ? ['-s', serial, 'install-multiple', '-r', ...(p.downgrade ? ['-d'] : []), ...target.files]
          : ['-s', serial, 'install', '-r', ...(p.downgrade ? ['-d'] : []), target.files[0]];

        let out = '';
        try {
          out = await adb(args, { timeout: 600000 });
        } catch (e) {
          // adb escribe los INSTALL_FAILED_* en stderr y sale con código != 0,
          // así que execFile rechaza y el motivo real viaja dentro del error.
          out = `${e.stderr || ''}${e.message || ''}`;
        } finally {
          if (target.cleanup) target.cleanup();
        }

        const ok = /Success/i.test(out);
        return { success: ok, message: ok ? `Instalado ${target.label}` : `Fallo al instalar ${target.label}: ${explainInstallError(out)}` };
      }

      // Abre la ficha de la app en la tienda del teléfono (origen oficial).
      case 'OPEN_STORE': {
        const pkg = String(p.package_name ?? '').trim();
        if (!pkg) return { success: false, message: 'Falta package_name' };
        await shell(serial, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', `market://details?id=${pkg}`]);
        return { success: true, message: `Ficha de ${pkg} abierta en la tienda` };
      }

      // Comprueba cuáles de los paquetes indicados están instalados.
      case 'LIST_PACKAGES': {
        const wanted = Array.isArray(p.packages) ? p.packages.map(String) : [];
        const out = await shell(serial, ['pm', 'list', 'packages']);
        const present = new Set(String(out).split(/\r?\n/).map(l => l.replace(/^package:/, '').trim()).filter(Boolean));
        const installed = wanted.filter(pkg => present.has(pkg));
        return {
          success: true,
          message: `${installed.length}/${wanted.length} instaladas`,
          data: { installed, missing: wanted.filter(pkg => !present.has(pkg)) },
        };
      }

      // Lee las cuentas reales del teléfono, agrupadas por tipo (com.google, …).
      // El endpoint /verify-accounts espera exactamente data.by_type.
      case 'CHECK_ACCOUNTS': {
        const out = String(await shell(serial, ['dumpsys', 'account']) || '');
        const by_type = {};
        // Formato de dumpsys: "Account {name=correo@gmail.com, type=com.google}"
        const re = /Account\s*\{\s*name=([^,}]+?)\s*,\s*type=([^,}]+?)\s*\}/g;
        let m;
        while ((m = re.exec(out))) {
          const email = m[1].trim();
          const type = m[2].trim();
          if (!email) continue;
          (by_type[type] = by_type[type] || []).push({ email });
        }
        // Quita duplicados: dumpsys repite la misma cuenta en varias secciones.
        let total = 0;
        for (const type of Object.keys(by_type)) {
          const seen = new Set();
          by_type[type] = by_type[type].filter(a => !seen.has(a.email) && seen.add(a.email));
          total += by_type[type].length;
        }
        return { success: true, message: `${total} cuentas en el dispositivo`, data: { by_type, total } };
      }

      // Asistente de alta: abre "Añadir cuenta" y deja escrito el correo. La
      // contraseña y la verificación en dos pasos las hace el operador en el
      // teléfono: Google no permite automatizarlas.
      case 'OPEN_ADD_ACCOUNT': {
        const email = String(p.email ?? '').trim();
        if (!email) return { success: false, message: 'Falta el correo' };
        const accountType = String(p.platform || 'com.google').trim();
        try {
          await shell(serial, ['am', 'start', '-a', 'android.settings.ADD_ACCOUNT_SETTINGS', '-e', 'account_types', accountType]);
        } catch (_) {
          await shell(serial, ['am', 'start', '-a', 'android.settings.SYNC_SETTINGS']).catch(() => {});
        }
        await sleep(2500);
        // `input text` no admite espacios sin escapar; un correo no debería
        // llevarlos, pero lo normalizamos por si acaso.
        await shell(serial, ['input', 'text', email.replace(/ /g, '%s')]).catch(() => {});
        return {
          success: true,
          message: `Pantalla de alta abierta con ${email} escrito. Introduce la contraseña en el teléfono.`,
          data: { email, account_type: accountType, manual_step: 'contraseña + verificación en dos pasos' },
        };
      }

      case 'GRANT_PERMISSION':
        await shell(serial, ['pm', 'grant', String(p.package_name ?? ''), String(p.permission ?? '')]);
        return { success: true, message: `Permiso concedido: ${p.permission}` };

      case 'SETTINGS_PUT':
        await shell(serial, ['settings', 'put', String(p.namespace ?? 'system'), String(p.key ?? ''), String(p.value ?? '')]);
        return { success: true, message: `settings ${p.namespace}.${p.key}=${p.value}` };

      case 'SETTINGS_GET': {
        const val = (await shell(serial, ['settings', 'get', String(p.namespace ?? 'system'), String(p.key ?? '')])).trim();
        return { success: true, message: `${p.key}=${val}`, data: { value: val } };
      }

      case 'SCREEN_ON':
        await shell(serial, ['input', 'keyevent', '224']); // WAKEUP
        return { success: true, message: 'Pantalla encendida' };

      case 'SCREEN_OFF':
        await shell(serial, ['input', 'keyevent', '223']); // SLEEP
        return { success: true, message: 'Pantalla apagada' };

      // PRESS_HOME y PRESS_BACK se atienden más arriba (mismo keyevent); este
      // bloque duplicado nunca se ejecutaba.

      case 'UNLOCK':
        await shell(serial, ['input', 'keyevent', '224']);
        await sleep(300);
        await shell(serial, ['input', 'keyevent', '82']); // MENU (desbloqueo simple sin PIN)
        return { success: true, message: 'Desbloqueo intentado' };

      case 'REBOOT':
        await adb(['-s', serial, 'reboot']);
        return { success: true, message: 'Reiniciando dispositivo' };

      case 'MONKEY': {
        const args = ['monkey', '-p', String(p.package_name ?? '')];
        if (p.throttle) args.push('--throttle', String(p.throttle));
        args.push('-v', String(p.events ?? 200));
        await shell(serial, args, { timeout: 120000 });
        return { success: true, message: `Monkey ${p.events ?? 200} eventos en ${p.package_name}` };
      }

      case 'PUSH_FILE':
        await adb(['-s', serial, 'push', String(p.local ?? ''), String(p.remote ?? '')], { timeout: 180000 });
        return { success: true, message: `Enviado ${p.local} → ${p.remote}` };

      case 'PULL_FILE':
        await adb(['-s', serial, 'pull', String(p.remote ?? ''), String(p.local ?? '')], { timeout: 180000 });
        return { success: true, message: `Descargado ${p.remote} → ${p.local}` };



      // ---------- Login genérico (detecta campos email/password, escribe, pulsa login) ----------
      case 'LOGIN_GENERIC': {
        const platform = p.platform || 'general';
        const email = p.email || '';
        const password = p.password || '';
        const totp_secret = p.totp_secret || '';
        const pkg = PLATFORM_PACKAGES[platform] || p.package_name;
        if (pkg) {
          await shell(serial, ['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
          await sleep(3000);
        }
        const ui = await dumpUi(serial);
        const alreadyLogged = /home|feed|explorar|discover|para ti|for you|Inicio|Explorar/i.test(ui);
        if (alreadyLogged) return { success: true, message: 'Ya logueado en la app', data: { already_logged: true } };
        const loginBtn = findBoundsBy(xml = ui, 'text', 'Iniciar sesión') || findBoundsBy(xml = ui, 'text', 'Log in') || findBoundsBy(xml = ui, 'text', 'Sign in') || findBoundsBy(xml = ui, 'text', 'Ingresar') || findBoundsBy(xml = ui, 'text', 'Entrar');
        if (loginBtn) { await shell(serial, ['input', 'tap', String(loginBtn.x), String(loginBtn.y)]); await sleep(2000); }
        if (email) {
          const emailField = findBoundsBy(xml = ui, 'resource-id', 'email') || findBoundsBy(xml = ui, 'resource-id', 'edit_text') || findBoundsBy(xml = ui, 'text', 'Email') || findBoundsBy(xml = ui, 'text', 'Correo');
          if (emailField) {
            await shell(serial, ['input', 'tap', String(emailField.x), String(emailField.y)]);
            await sleep(500);
            await shell(serial, ['input', 'text', email.replace(/ /g, '%s')]);
            await sleep(1500);
            await shell(serial, ['input', 'keyevent', '66']);
            await sleep(2000);
          }
        }
        if (password) {
          const passField = findBoundsBy(xml = ui, 'resource-id', 'password') || findBoundsBy(xml = ui, 'resource-id', 'edit_text') || findBoundsBy(xml = ui, 'text', 'Contraseña') || findBoundsBy(xml = ui, 'text', 'Password');
          if (passField) {
            await shell(serial, ['input', 'tap', String(passField.x), String(passField.y)]);
            await sleep(500);
            await shell(serial, ['input', 'text', password.replace(/ /g, '%s')]);
            await sleep(1500);
          }
        }
        const nextBtn = findBoundsBy(xml = ui, 'text', 'Siguiente') || findBoundsBy(xml = ui, 'text', 'Next') || findBoundsBy(xml = ui, 'text', 'Continuar') || findBoundsBy(xml = ui, 'text', 'Sign in') || findBoundsBy(xml = ui, 'text', 'Log in');
        if (nextBtn) { await shell(serial, ['input', 'tap', String(nextBtn.x), String(nextBtn.y)]); await sleep(3000); }
        if (totp_secret) {
          const totp = require('../server/accounts').totp(require('../server/accounts')._dec(totp_secret));
          if (totp) {
            const codeField = findBoundsBy(xml = ui, 'resource-id', 'code') || findBoundsBy(xml = ui, 'text', 'Código');
            if (codeField) {
              await shell(serial, ['input', 'tap', String(codeField.x), String(codeField.y)]);
              await sleep(500);
              for (const ch of totp) { await shell(serial, ['input', 'text', ch]); await sleep(150); }
              await sleep(2000);
              const verifyBtn = findBoundsBy(xml = ui, 'text', 'Verify') || findBoundsBy(xml = ui, 'text', 'Verificar');
              if (verifyBtn) { await shell(serial, ['input', 'tap', String(verifyBtn.x), String(verifyBtn.y)]); await sleep(3000); }
            }
          }
        }
        const finalUi = await dumpUi(serial);
        const success = /home|feed|explorar|discover|para ti|for you|Inicio|Explorar/i.test(finalUi);
        return { success, message: success ? 'Login exitoso' : 'Login fallido', data: { success, already_logged: alreadyLogged, platform, email } };
      }

      // ---------- Detectar si ya está logueado ----------
      case 'DETECT_LOGGED_IN': {
        const ui = await dumpUi(serial);
        const logged = /home|feed|explorar|discover|para ti|for you|Inicio|Explorar/i.test(ui);
        const needsLogin = /log ?in|inicia sesi[oó]n|sign ?in|registr|crear cuenta/i.test(ui) && !logged;
        return { success: true, data: { logged_in: logged, needs_login: needsLogin }, message: logged ? 'Ya logueado' : (needsLogin ? 'Necesita login' : 'Estado desconocido') };
      }

      // ---------- Detectar fin de video/reel ----------
      case 'DETECT_VIDEO_END': {
        const ui = await dumpUi(serial);
        const endPatterns = [/reproducir de nuevo|play again|tap to restart|ver siguiente|next video|siguiente video|ver m[aá]s|watch more|play next|next clip|siguiente clip|otro video|\\bnext\\b.*\\bvideo/i, /watch again|replay|ver de nuevo|play again|restart video/i];
        let matched = null;
        for (const re of endPatterns) { const m = ui.match(re); if (m) { matched = m[0]; break; } }
        const playBtn = findBoundsBy(xml = ui, 'text', '▶') || findBoundsBy(xml = ui, 'text', 'Play');
        return { success: true, data: { video_ended: !!matched, video_paused: !!playBtn, matched_text: matched }, message: matched ? `Fin detectado: "${matched}"` : (playBtn ? 'Video pausado' : 'Video activo') };
      }

      // ---------- Scroll al siguiente video ----------
      case 'SCROLL_NEXT': {
        const s = await screenSize(serial);
        const jitter = HJ(s.w / 2, s.h * 0.3);
        await shell(serial, ['input', 'swipe', String(jitter.x), String(s.h * 0.8), String(jitter.x), String(s.h * 0.2), String(HD(400))]);
        await sleep(2000);
        return { success: true, message: 'Scroll al siguiente video' };
      }

      // ---------- Reproducir video (tap play) ----------
      case 'PLAY_VIDEO': {
        const s = await screenSize(serial);
        await shell(serial, ['input', 'tap', String(Math.round(s.w / 2)), String(Math.round(s.h / 2))]);
        await sleep(2000);
        return { success: true, message: 'Tap play/pause' };
      }

      // ---------- Like ----------
      case 'LIKE': {
        const s = await screenSize(serial);
        await shell(serial, ['input', 'tap', String(Math.round(s.w * 0.75)), String(Math.round(s.h * 0.65))]);
        await sleep(500);
        return { success: true, message: 'Like dado' };
      }

      // ---------- Comentar ----------
      case 'COMMENT': {
        const comment = String(p.text || '');
        if (!comment) return { success: false, message: 'Falta texto del comentario' };
        const xml = await dumpUi(serial);
        const commentField = findBoundsBy(xml, 'resource-id', 'comment') || findBoundsBy(xml, 'resource-id', 'caption') || findBoundsBy(xml, 'resource-id', 'edit_text') || findBoundsBy(xml, 'text', 'A[dñ]dir comentario') || findBoundsBy(xml, 'text', 'Add comment');
        if (commentField) {
          await shell(serial, ['input', 'tap', String(commentField.x), String(commentField.y)]);
          await sleep(500);
          await shell(serial, ['input', 'text', comment.replace(/ /g, '%s')]);
          await sleep(1500);
          const sendBtn = findBoundsBy(xml, 'text', 'Enviar') || findBoundsBy(xml, 'text', 'Send') || findBoundsBy(xml, 'text', 'Publicar');
          if (sendBtn) { await shell(serial, ['input', 'tap', String(sendBtn.x), String(sendBtn.y)]); await sleep(2000); }
          return { success: true, message: `Comentario: "${comment}"` };
        }
        return { success: false, message: 'Campo de comentario no encontrado' };
      }

      // ---------- Seguir ----------
      case 'FOLLOW': {
        const s = await screenSize(serial);
        await shell(serial, ['input', 'tap', String(Math.round(s.w * 0.85)), String(Math.round(s.h * 0.15))]);
        await sleep(1000);
        return { success: true, message: 'Seguir pulsado' };
      }

      // ---------- Buscar contenido ----------
      case 'SEARCH_CONTENT': {
        const query = String(p.query || p.search || '');
        if (!query) return { success: false, message: 'Falta query' };
        const xml = await dumpUi(serial);
        const searchIcon = findBoundsBy(xml, 'resource-id', 'search') || findBoundsBy(xml, 'resource-id', 'search_button') || findBoundsBy(xml, 'text', 'Buscar') || findBoundsBy(xml, 'text', 'Search');
        if (searchIcon) {
          await shell(serial, ['input', 'tap', String(searchIcon.x), String(searchIcon.y)]);
          await sleep(1500);
          await shell(serial, ['input', 'text', query.replace(/ /g, '%s')]);
          await sleep(1500);
          await shell(serial, ['input', 'keyevent', '66']);
          await sleep(3000);
          return { success: true, message: `Búsqueda: "${query}"` };
        }
        return { success: false, message: 'Icono de búsqueda no encontrado' };
      }

      // ---------- Compartir ----------
      case 'SHARE': {
        const s = await screenSize(serial);
        await shell(serial, ['input', 'tap', String(Math.round(s.w * 0.8)), String(Math.round(s.h * 0.6))]);
        await sleep(1500);
        return { success: true, message: 'Compartir pulsado' };
      }

      // ---------- Guardar ----------
      case 'SAVE': {
        const s = await screenSize(serial);
        await shell(serial, ['input', 'tap', String(Math.round(s.w * 0.75)), String(Math.round(s.h * 0.65))]);
        await sleep(1000);
        return { success: true, message: 'Contenido guardado' };
      }

      // ---------- Watch video (duración) ----------
      case 'WATCH_VIDEO': {
        const duration = p.duration_seconds || 30;
        await sleep(duration * 1000);
        return { success: true, message: `Vista de ${duration}s completada` };
      }

      // ---------- Watch loop (N vistas) ----------
      case 'WATCH_LOOP': {
        const count = p.count || 1;
        const duration = p.duration_seconds || 30;
        const scrollBetween = p.scroll_between !== false;
        const likeChance = p.like_chance || 0;
        const commentText = p.comment_text || '';
        let successCount = 0;
        for (let i = 0; i < count; i++) {
          await sleep(duration * 1000);
          successCount++;
          if (likeChance > 0 && Math.random() < likeChance) { await execute(serial, 'LIKE', {}); await sleep(500); }
          if (commentText && i === count - 1) { await execute(serial, 'COMMENT', { text: commentText }); await sleep(500); }
          if (scrollBetween && i < count - 1) { await execute(serial, 'SCROLL_NEXT', {}); await sleep(2000); }
        }
        return { success: true, message: `Loop: ${successCount}/${count} vistas`, data: { completed: successCount, total: count } };
      }

      // ---------- Ban recovery ----------
      case 'BAN_RECOVERY': {
        const platform = p.platform || 'general';
        const changeProxy = p.change_proxy !== false;
        const clearData = p.clear_data !== false;
        const doLogin = p.login !== false;
        const email = p.email || '';
        const password = p.password || '';
        const totp_secret = p.totp_secret || '';
        await shell(serial, ['input', 'keyevent', '3']); // Home
        await sleep(2000);
        if (changeProxy && p.proxy_host && p.proxy_port) {
          await execute(serial, 'SET_PROXY', { host: p.proxy_host, port: p.proxy_port });
          await sleep(3000);
        }
        if (clearData) {
          const pkg = PLATFORM_PACKAGES[platform] || p.package_name;
          if (pkg) { await shell(serial, ['pm', 'clear', pkg]); await sleep(3000); }
        }
        if (doLogin) {
          await execute(serial, 'LOGIN_GENERIC', { platform, email, password, totp_secret, package_name: PLATFORM_PACKAGES[platform] || p.package_name });
        }
        return { success: true, message: 'Recuperación de baneo completada' };
      }

      // ---------- Account reset ----------
      case 'ACCOUNT_RESET': {
        const platform = p.platform || 'general';
        const deviceId = p.device_id;
        const accounts = require('../server/accounts');
        const db = require('../server/db');
        const sql = deviceId
          ? "SELECT * FROM accounts WHERE status NOT IN ('banned') AND (device_id IS NULL OR device_id=?) AND (cooldown_until IS NULL OR cooldown_until < ?) AND platform=? ORDER BY last_used_at IS NULL DESC, last_used_at ASC LIMIT 1"
          : "SELECT * FROM accounts WHERE status NOT IN ('banned') AND (device_id IS NULL OR device_id=?) AND (cooldown_until IS NULL OR cooldown_until < ?) AND platform=? ORDER BY last_used_at IS NULL DESC, last_used_at ASC LIMIT 1";
        const params = deviceId ? [deviceId, new Date().toISOString(), platform] : [deviceId, new Date().toISOString(), platform];
        const next = db.all(sql, params)[0];
        if (!next) return { success: false, message: 'No hay cuentas disponibles', data: { remaining: 0 } };
        accounts.assign(next.id, deviceId);
        return { success: true, message: `Cuenta reseteada: ${next.email}`, data: { account_id: next.id, email: next.email, platform } };
      }

      // READ_SCREEN_TEXT se atiende más arriba con idéntica implementación;
      // este bloque duplicado era código muerto.

      case 'SCREEN_RECORD': {
        const secs = Math.min(p.duration_seconds ?? 10, 180);
        const remote = '/sdcard/mcp_rec.mp4';
        await shell(serial, ['screenrecord', '--time-limit', String(secs), remote], { timeout: (secs + 20) * 1000 });
        const dir = path.join(require('os').tmpdir(), 'mcp-recordings');
        fs.mkdirSync(dir, { recursive: true });
        const local = path.join(dir, `${serial}_${Date.now()}.mp4`);
        await adb(['-s', serial, 'pull', remote, local], { timeout: 60000 });
        return { success: true, message: `Grabación ${secs}s`, data: { file: local } };
      }

      default:
        return { success: false, message: `Comando no soportado por ADB: ${command}` };
    }
  } catch (e) {
    return { success: false, message: `ADB error en ${command}: ${e.message}` };
  }
}

const frameCache = new Map();

// Comprime el frame del muro: reescala a un ancho máximo y lo pasa a JPEG con
// nativeImage de Electron (sin dependencias nativas). Un PNG de pantalla completa
// (2-8 MB) baja a ~30-80 KB de JPEG, aliviando CPU/USB con muchos dispositivos.
// Si nativeImage no está disponible (o falla), devuelve el PNG original.
function compressFrame(png, maxW, quality) {
  try {
    const { nativeImage } = require('electron');
    let img = nativeImage.createFromBuffer(png);
    const size = img.getSize();
    if (size.width > maxW) img = img.resize({ width: maxW, quality: 'good' });
    const jpeg = img.toJPEG(quality);
    if (jpeg && jpeg.length > 0 && jpeg.length < png.length) {
      return { buf: jpeg, mime: 'image/jpeg' };
    }
  } catch (_) {}
  return { buf: png, mime: 'image/png' };
}

// opts.thumb = true → miniatura para el muro (más pequeña/ligera). Sin thumb =
// calidad alta para el teléfono enfocado. Se cachea por (serial, modo).
async function captureFrame(device, opts = {}) {
  const serial = device.adb_serial || device.serial_number;
  const thumb = !!opts.thumb;
  const maxW = thumb ? (CONFIG.thumbMaxWidth || 240) : (CONFIG.frameMaxWidth || 480);
  const quality = thumb ? (CONFIG.thumbQuality || 40) : (CONFIG.frameQuality || 60);
  const key = serial + (thumb ? ':t' : ':f');
  const cached = frameCache.get(key);
  const now = Date.now();
  // caché más largo para miniaturas del muro (menos refrescos con 40 dispositivos)
  const ttl = thumb ? (CONFIG.thumbTtlMs || 1500) : 300;
  if (cached && (now - cached.ts < ttl)) {
    return { success: true, image: cached.image, mime: cached.mime, source: cached.source, cached: true };
  }
  try {
    // Solo las miniaturas del muro van en baja prioridad. El teléfono enfocado
    // debe adelantarlas: si no, su captura espera detrás de hasta 13 capturas del
    // muro en la cola ADB y el visor se siente pegajoso al cambiar de dispositivo.
    const png = await adb(['-s', serial, 'exec-out', 'screencap', '-p'], { binary: true, timeout: 15000, lowPriority: thumb });
    if (!png || png.length < 100) {
      if (cached) return { success: true, image: cached.image, mime: cached.mime, source: cached.source };
      return { success: false, message: 'Captura ADB vacía' };
    }
    const { buf, mime } = compressFrame(Buffer.from(png), maxW, quality);
    const b64 = Buffer.from(buf).toString('base64');
    frameCache.set(key, { image: b64, mime, source: 'adb', ts: now });
    return { success: true, image: b64, mime, source: 'adb' };
  } catch (e) {
    if (cached) return { success: true, image: cached.image, mime: cached.mime, source: cached.source };
    return { success: false, message: `Error de pantalla ADB: ${e.message}` };
  }
}

async function _adbConnect(target, lowPriority = false, timeout = 15000) {
  try {
    const out = await adb(['connect', target], { timeout, lowPriority });
    // "connected to X" y "already connected to X" cuentan como éxito; "failed to
    // connect"/"cannot connect" no contienen "connected", así que no falsean.
    const ok = /connected/i.test(out || '');
    if (ok) knownTcp.set(target, 0); // vigilar para reconexión automática
    return { success: ok, message: ok ? `Dispositivo TCP conectado exitosamente: ${target}` : `ADB: ${String(out || '').trim() || 'sin respuesta'}` };
  } catch (e) {
    return { success: false, message: `Error conectando TCP: ${e.message}` };
  }
}

async function connectTcp(address) {
  let target = String(address || '').trim();
  if (!target) return { success: false, message: 'Dirección TCP requerida' };
  if (!target.includes(':')) target += ':5555';
  if (!isAllowedSerial(target)) {
    return { success: false, message: `ADB serial fuera del alcance aprobado: ${target}` };
  }
  const result = await _adbConnect(target);
  poll();
  return result;
}

// ---------- escaneo de rango IP ----------
// Un `adb connect` contra una IP muerta tarda segundos y ocupa un hueco de la cola
// ADB; un socket TCP crudo falla en milisegundos. Por eso sondeamos primero el
// puerto y solo gastamos `adb connect` en las IPs que responden.
function probeTcp(ip, port, timeout = 400) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const finish = (ok) => { if (settled) return; settled = true; sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, ip);
  });
}

const MAX_PROBES = 64;        // sondas TCP simultáneas (baratas, no tocan adb.exe)
// Un host con el puerto abierto que NO sea un adbd (impresora, NAS, contenedor…)
// deja `adb connect` colgado hasta su timeout, ocupando un hueco de la cola ADB.
// Limitamos cuántos puede haber a la vez para no dejar sin huecos a los comandos
// interactivos, y acortamos su timeout: un teléfono sano responde en decenas de ms.
const MAX_SCAN_CONNECTS = 6;
const SCAN_CONNECT_TIMEOUT = 8000;

// Ejecuta `worker` sobre `items` con como mucho `limit` en vuelo, conservando el
// orden de entrada en el resultado.
async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

// Escanea `prefix`.from … `prefix`.to en el puerto dado y conecta lo que responda.
// Devuelve una fila por IP viva: { ip, address, ok, message }.
async function scanRange({ prefix, from = 0, to = 254, port = 5555, probeTimeout = 400 } = {}) {
  if (!CONFIG.allowNetworkScan) {
    return { success: false, message: 'El escaneo de red está desactivado; registra seriales ADB aprobados de forma explícita' };
  }
  const base = String(prefix || '').trim().replace(/\.+$/, '');
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(base) || base.split('.').some(o => Number(o) > 255)) {
    return { success: false, message: 'Prefijo IP inválido; se espera "a.b.c" (ej. 192.168.60)' };
  }
  const p = Math.max(1, Math.min(65535, Number(port) || 5555));
  let lo = Math.max(0, Math.min(255, Number(from) || 0));
  let hi = Math.max(0, Math.min(255, Number.isFinite(Number(to)) ? Number(to) : 254));
  if (hi < lo) [lo, hi] = [hi, lo];
  const timeout = Math.max(100, Math.min(5000, Number(probeTimeout) || 400));

  const hosts = [];
  for (let i = lo; i <= hi; i++) hosts.push(`${base}.${i}`);

  const results = [];
  for (let i = 0; i < hosts.length; i += MAX_PROBES) {
    const chunk = hosts.slice(i, i + MAX_PROBES);
    const alive = (await Promise.all(
      chunk.map(async ip => (await probeTcp(ip, p, timeout)) ? ip : null)
    )).filter(Boolean);
    // En paralelo (con tope), no encadenados: un host que cuelgue no debe retrasar
    // a los demás. lowPriority mantiene el escaneo detrás de los comandos interactivos.
    results.push(...await mapLimit(alive, MAX_SCAN_CONNECTS, async (ip) => {
      const address = `${ip}:${p}`;
      const r = await _adbConnect(address, true, SCAN_CONNECT_TIMEOUT);
      return { ip, address, ok: r.success, message: r.message };
    }));
  }

  if (results.some(r => r.ok)) poll();
  return {
    success: true,
    scanned: hosts.length,
    found: results.length,
    connected: results.filter(r => r.ok).length,
    results,
  };
}

// ---------- API pública para el router ----------
function has(serial) { return live.has(serial); }

function start(config) {
  CONFIG = Object.assign(CONFIG, config);
  CONFIG.allowedSerials = [...new Set((CONFIG.allowedSerials || []).map(value => String(value).trim()).filter(Boolean))];
  needsInitialReconciliation = true;
  console.log(`[adb] usando adb: ${resolveAdb()}`);
  console.log(`[adb] alcance: ${CONFIG.requireAllowlist ? CONFIG.allowedSerials.join(', ') || 'ningun dispositivo' : 'dispositivos ADB conectados'}`);
  agent.init({ adbResolver: resolveAdb });
  agent.configurarApk({ wsPort: CONFIG.wsPort });   // el agente recién instalado apunta al router por el túnel
  poll();
  pollTimer = setInterval(poll, 1500);
}
function stop() {
  if (pollTimer) clearInterval(pollTimer);
  for (const controllers of activeScriptControllers.values()) {
    for (const controller of controllers) controller.abort();
  }
}

module.exports = { start, stop, has, execute, cancel, captureFrame, connectTcp, scanRange, live, adbStats, resolveAdb };
