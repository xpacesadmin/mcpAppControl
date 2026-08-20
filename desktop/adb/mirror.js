// Espejo en tiempo real — cliente del servidor scrcpy.
//
// Reemplaza al visor basado en `adb exec-out screencap -p`, que en un S21 Ultra
// (1440x3200) costaba 2,7 s y 7 MB POR FOTOGRAMA: 0,4 fps. El teléfono codificaba
// un PNG entero, se transfería, y Node lo volvía a decodificar para reencodearlo a
// JPEG. Manipular el móvil así es inviable.
//
// Aquí el teléfono codifica H.264 por hardware y envía un flujo continuo por un
// socket que dura toda la sesión. Los toques viajan por el socket de control ya
// abierto (32 bytes), en vez de arrancar un proceso `adb shell input tap` de ~104 ms.
//
// El servidor (vendor/scrcpy/scrcpy-server.jar, Apache-2.0 de Genymobile) corre en
// el teléfono con app_process. El cliente —parseo del flujo y codificación de los
// eventos de entrada— es de este proyecto.

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

// El servidor aborta si la versión que anuncia el cliente no es la suya exacta.
const SCRCPY_VERSION = '3.1';
const DEVICE_JAR = '/data/local/tmp/mcp-scrcpy-server.jar';

let CONFIG = {
  adbPath: null,
  maxSize: 1024,        // lado mayor del vídeo; 0 = resolución nativa
  maxFps: 30,
  bitRate: 4000000,
  idleTimeoutMs: 15000, // cierra la sesión al quedarse sin espectadores
};

const sessions = new Map();   // serial -> Session
let wss = null;
let resolveAdbPath = () => CONFIG.adbPath || 'adb';
let authorizeMirrorSerial = () => true;

// ------------------------------------------------------------------ utilidades

function serverJarPath() {
  const candidatos = [
    CONFIG.scrcpyServerPath,
    process.resourcesPath && path.join(process.resourcesPath, 'scrcpy', 'scrcpy-server.jar'),
    path.resolve(__dirname, '..', 'vendor', 'scrcpy', 'scrcpy-server.jar'),
  ].filter(Boolean);
  for (const c of candidatos) { try { if (fs.existsSync(c)) return c; } catch (_) {} }
  return null;
}

function runAdb(args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const p = spawn(resolveAdbPath(), args, { windowsHide: true });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error(`timeout: adb ${args.join(' ')}`)); }, timeout);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || out.trim() || `adb salió con código ${code}`));
    });
  });
}

// Lector incremental: el flujo llega troceado por TCP y hay que esperar a tener
// exactamente los bytes de cada cabecera antes de interpretarla.
class ByteReader {
  constructor() { this.buf = Buffer.alloc(0); this.waiters = []; }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this._pump();
  }
  _pump() {
    while (this.waiters.length && this.buf.length >= this.waiters[0].n) {
      const w = this.waiters.shift();
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(out);
    }
  }
  read(n) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ n, resolve, reject });
      this._pump();
    });
  }
  fail(err) {
    while (this.waiters.length) this.waiters.shift().reject(err);
  }
}

// ------------------------------------------------------------------- sesión

class Session {
  constructor(serial) {
    this.serial = serial;
    this.clients = new Set();
    this.videoSocket = null;
    this.controlSocket = null;
    this.tunnelServer = null;
    this.proc = null;
    this.scid = null;
    this.meta = null;          // { codec, width, height }
    this.configPacket = null;  // SPS/PPS: se reenvía a cada nuevo espectador
    this.starting = null;
    this.idleTimer = null;
    this.closed = false;
  }

  addClient(ws) {
    this.clients.add(ws);
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    // Un espectador que llega a mitad de sesión necesita el estado actual y la
    // cabecera SPS/PPS, o su decodificador no arranca hasta el siguiente keyframe.
    if (this.meta) {
      ws.send(JSON.stringify({ type: 'meta', ...this.meta }));
      if (this.configPacket) ws.send(this.framePayload(this.configPacket, true, false));
    }
  }

  removeClient(ws) {
    this.clients.delete(ws);
    if (!this.clients.size && !this.idleTimer) {
      this.idleTimer = setTimeout(() => this.stop('sin espectadores'), CONFIG.idleTimeoutMs);
    }
  }

  // Marco binario hacia el renderer: 1 byte de flags + unidad de acceso H.264.
  framePayload(data, isConfig, isKey) {
    const head = Buffer.alloc(1);
    head[0] = (isConfig ? 1 : 0) | (isKey ? 2 : 0);
    return Buffer.concat([head, data]);
  }

  broadcast(payload) {
    for (const ws of this.clients) {
      if (ws.readyState === 1) {
        // Si un espectador se atasca, acumular le agrava el retraso: mejor
        // saltarse fotogramas que servir vídeo cada vez más viejo.
        if (ws.bufferedAmount > 4 * 1024 * 1024) continue;
        ws.send(payload);
      }
    }
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this._start().catch(err => { this.starting = null; throw err; });
    return this.starting;
  }

  async _start() {
    const jar = serverJarPath();
    if (!jar) throw new Error('No se encontró scrcpy-server.jar (vendor/scrcpy/)');

    await runAdb(['-s', this.serial, 'push', jar, DEVICE_JAR], 60000);

    this.scid = Math.floor(Math.random() * 0x7FFFFFFF).toString(16).padStart(8, '0');
    const socketName = `scrcpy_${this.scid}`;

    // El servidor abre las conexiones hacia el PC (túnel inverso), así que aquí
    // escuchamos y esperamos: primero el socket de vídeo, después el de control.
    const port = await this._listen();
    await runAdb(['-s', this.serial, 'reverse', `localabstract:${socketName}`, `tcp:${port}`]);

    const args = [
      '-s', this.serial, 'shell',
      `CLASSPATH=${DEVICE_JAR}`,
      'app_process', '/', 'com.genymobile.scrcpy.Server', SCRCPY_VERSION,
      `scid=${this.scid}`,
      'log_level=error',
      'video=true', 'audio=false', 'control=true',
      'tunnel_forward=false',
      'send_device_meta=true', 'send_frame_meta=true', 'send_codec_meta=true',
      'video_codec=h264',
      `max_size=${CONFIG.maxSize}`,
      `max_fps=${CONFIG.maxFps}`,
      `video_bit_rate=${CONFIG.bitRate}`,
    ];
    this.proc = spawn(resolveAdbPath(), args, { windowsHide: true });
    this.proc.stderr.on('data', d => {
      const s = String(d).trim();
      if (s) console.error(`[mirror ${this.serial}] ${s}`);
    });
    this.proc.on('close', () => { if (!this.closed) this.stop('el servidor scrcpy terminó'); });

    await this.socketsReady;
    this._readVideo().catch(e => {
      if (!this.closed) console.error(`[mirror ${this.serial}] vídeo:`, e.message);
      this.stop('flujo de vídeo interrumpido');
    });
    return this;
  }

  _listen() {
    return new Promise((resolve, reject) => {
      let got = 0;
      let resolveSockets, rejectSockets;
      this.socketsReady = new Promise((res, rej) => { resolveSockets = res; rejectSockets = rej; });

      const srv = net.createServer((sock) => {
        sock.setNoDelay(true);
        got++;
        if (got === 1) this.videoSocket = sock;
        else if (got === 2) {
          this.controlSocket = sock;
          // Mensajes del dispositivo (portapapeles, etc.): se descartan, pero hay
          // que consumirlos o el socket se llena y el control deja de responder.
          sock.on('data', () => {});
          sock.on('error', () => {});
          resolveSockets();
          try { srv.close(); } catch (_) {}
        }
      });

      srv.on('error', (e) => { rejectSockets(e); reject(e); });
      srv.listen(0, '127.0.0.1', () => {
        this.tunnelServer = srv;
        resolve(srv.address().port);
      });

      setTimeout(() => {
        if (got < 2) {
          const e = new Error('el dispositivo no abrió los sockets de scrcpy');
          rejectSockets(e);
        }
      }, 15000);
    });
  }

  async _readVideo() {
    const r = new ByteReader();
    this.videoSocket.on('data', c => r.push(c));
    this.videoSocket.on('error', e => r.fail(e));
    this.videoSocket.on('close', () => r.fail(new Error('socket de vídeo cerrado')));

    // Sin byte centinela: scrcpy solo lo envía con tunnel_forward=true. Leerlo
    // aquí desplazaba todo un byte (el nombre salía "M-G998U" y el códec "264\0").
    const nameBuf = await r.read(64);                  // send_device_meta
    const deviceName = nameBuf.toString('utf8').replace(/\0.*$/, '');

    const codecBuf = await r.read(12);                 // send_codec_meta
    const codec = codecBuf.subarray(0, 4).toString('ascii');
    const width = codecBuf.readUInt32BE(4);
    const height = codecBuf.readUInt32BE(8);

    this.meta = { codec, width, height, deviceName };
    console.log(`[mirror] ${this.serial} transmitiendo ${width}x${height} ${codec} (${deviceName})`);
    const metaMsg = JSON.stringify({ type: 'meta', ...this.meta });
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(metaMsg);

    for (;;) {
      const head = await r.read(12);                   // send_frame_meta
      const pts = head.readBigUInt64BE(0);
      const len = head.readUInt32BE(8);
      const isConfig = (pts & (1n << 63n)) !== 0n;
      const isKey = (pts & (1n << 62n)) !== 0n;
      const data = await r.read(len);
      if (isConfig) this.configPacket = Buffer.from(data);
      this.broadcast(this.framePayload(data, isConfig, isKey));
    }
  }

  // ---- control (PC -> teléfono) ------------------------------------------

  send(buf) {
    if (this.controlSocket && !this.controlSocket.destroyed) {
      this.controlSocket.write(buf);
      return true;
    }
    return false;
  }

  // INJECT_TOUCH_EVENT (tipo 2): 32 bytes por evento sobre el socket ya abierto.
  touch(action, x, y, pressure = 1) {
    if (!this.meta) return false;
    const b = Buffer.alloc(32);
    b.writeUInt8(2, 0);
    b.writeUInt8(action, 1);                                   // 0 down, 1 up, 2 move
    b.writeBigUInt64BE(0xFFFFFFFFFFFFFFFFn, 2);                // puntero "ratón"
    b.writeInt32BE(Math.round(x), 10);
    b.writeInt32BE(Math.round(y), 14);
    b.writeUInt16BE(this.meta.width, 18);
    b.writeUInt16BE(this.meta.height, 20);
    b.writeUInt16BE(action === 1 ? 0 : Math.round(pressure * 0xFFFF), 22);
    b.writeUInt32BE(action === 1 ? 0 : 1, 24);                 // actionButton PRIMARY
    b.writeUInt32BE(action === 1 ? 0 : 1, 28);                 // buttons PRIMARY
    return this.send(b);
  }

  // INJECT_SCROLL_EVENT (tipo 3)
  scroll(x, y, hScroll, vScroll) {
    if (!this.meta) return false;
    const b = Buffer.alloc(21);
    b.writeUInt8(3, 0);
    b.writeInt32BE(Math.round(x), 1);
    b.writeInt32BE(Math.round(y), 5);
    b.writeUInt16BE(this.meta.width, 9);
    b.writeUInt16BE(this.meta.height, 11);
    b.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(hScroll * 32767))), 13);
    b.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(vScroll * 32767))), 15);
    b.writeUInt32BE(0, 17);
    return this.send(b);
  }

  // INJECT_KEYCODE (tipo 0)
  key(keycode, action = 0, metaState = 0) {
    const b = Buffer.alloc(14);
    b.writeUInt8(0, 0);
    b.writeUInt8(action, 1);
    b.writeUInt32BE(keycode, 2);
    b.writeUInt32BE(0, 6);
    b.writeUInt32BE(metaState, 10);
    return this.send(b);
  }

  // INJECT_TEXT (tipo 1)
  text(value) {
    const data = Buffer.from(String(value ?? ''), 'utf8');
    const b = Buffer.alloc(5 + data.length);
    b.writeUInt8(1, 0);
    b.writeUInt32BE(data.length, 1);
    data.copy(b, 5);
    return this.send(b);
  }

  stop(motivo = '') {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const ws of this.clients) { try { ws.close(1000, motivo); } catch (_) {} }
    this.clients.clear();
    for (const s of [this.videoSocket, this.controlSocket]) { try { s?.destroy(); } catch (_) {} }
    try { this.tunnelServer?.close(); } catch (_) {}
    try { this.proc?.kill(); } catch (_) {}
    if (this.scid) {
      runAdb(['-s', this.serial, 'reverse', '--remove', `localabstract:scrcpy_${this.scid}`], 5000).catch(() => {});
    }
    sessions.delete(this.serial);
    if (motivo) console.log(`[mirror] ${this.serial} detenido: ${motivo}`);
  }
}

// ------------------------------------------------------------------ servidor

async function getSession(serial) {
  let s = sessions.get(serial);
  if (s && !s.closed) { await s.start(); return s; }
  s = new Session(serial);
  sessions.set(serial, s);
  try {
    await s.start();
  } catch (e) {
    s.stop('');
    throw e;
  }
  return s;
}

// Se engancha al servidor HTTP existente (8733) en la ruta /mirror, para no abrir
// otro puerto ni duplicar la autenticación.
function init({ httpServer, adbResolver, token, config, authorizeSerial } = {}) {
  Object.assign(CONFIG, config || {});
  if (adbResolver) resolveAdbPath = adbResolver;
  authorizeMirrorSerial = typeof authorizeSerial === 'function' ? authorizeSerial : () => true;

  wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://127.0.0.1'); } catch (_) { return socket.destroy(); }
    if (url.pathname !== '/mirror') return;   // otras rutas: que las atienda quien corresponda

    if (token && url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    const serial = url.searchParams.get('serial');
    if (!serial) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      return socket.destroy();
    }
    let authorized = false;
    try { authorized = authorizeMirrorSerial(serial) === true; } catch (_) {}
    if (!authorized) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, ws => onConnection(ws, serial));
  });

  console.log('[mirror] espejo scrcpy disponible en ws://127.0.0.1:<puerto>/mirror');
}

async function onConnection(ws, serial) {
  let session = null;
  try {
    session = await getSession(serial);
  } catch (e) {
    try { ws.send(JSON.stringify({ type: 'error', message: e.message })); } catch (_) {}
    return ws.close(1011, 'no se pudo iniciar el espejo');
  }
  session.addClient(ws);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    // Las coordenadas llegan normalizadas (0..1) para no depender de la
    // resolución a la que el renderer esté dibujando el canvas.
    const X = () => (m.x ?? 0) * session.meta.width;
    const Y = () => (m.y ?? 0) * session.meta.height;
    switch (m.type) {
      case 'touch':  session.touch(m.action, X(), Y(), m.pressure ?? 1); break;
      case 'scroll': session.scroll(X(), Y(), m.h ?? 0, m.v ?? 0); break;
      case 'key':    session.key(m.keycode, m.action ?? 0, m.meta ?? 0); break;
      case 'keypress': session.key(m.keycode, 0); session.key(m.keycode, 1); break;
      case 'text':   session.text(m.value); break;
    }
  });

  ws.on('close', () => session.removeClient(ws));
  ws.on('error', () => session.removeClient(ws));
}

function stopAll() {
  for (const s of [...sessions.values()]) s.stop('cierre de la aplicación');
}

function stats() {
  return [...sessions.values()].map(s => ({
    serial: s.serial, viewers: s.clients.size, meta: s.meta, running: !s.closed,
  }));
}

module.exports = { init, stopAll, stats, getSession, SCRCPY_VERSION };
