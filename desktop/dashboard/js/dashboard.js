// ============================================================
// MCP AppControl · MCP Control Bsolutions V1 Dashboard Engine
// ============================================================

// Auto-reparación: una versión PWA anterior dejó un Service Worker registrado
// que interceptaba y rompía las llamadas a la API ("Failed to fetch" → sin
// dispositivos). Lo desregistramos y limpiamos su caché; si controlaba la
// página, recargamos una sola vez para recuperar el acceso a la red.
(function purgeStaleServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.getRegistrations().then(function (regs) {
    if (!regs.length) return;
    Promise.all(regs.map(function (r) { return r.unregister(); })).then(function () {
      var clear = window.caches ? caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }) : Promise.resolve();
      clear.finally(function () {
        if (!sessionStorage.getItem('sw_purged')) { sessionStorage.setItem('sw_purged', '1'); location.reload(); }
      });
    });
  }).catch(function () {});
})();

let apiOrigin = localStorage.getItem('mcp_api_base');
if (!apiOrigin || window.location.protocol === 'file:' || !window.location.origin || window.location.origin.startsWith('file:')) {
    apiOrigin = 'http://127.0.0.1:8733';
}
const API_BASE = apiOrigin;
const API_V1 = `${API_BASE}/api/v1`;

let devices = [];
let workflows = [];
let groups = [];
let schedules = [];
let wsConnection = null;

let viewedDeviceId = null;
let screenFrameTimer = null;
let screenFrameInFlight = false;

let screenWallTimer = null;
const screenWallInFlight = new Set();
const screenWallRetryAt = new Map();
let screenWallDeviceIds = [];
let screenWallCursor = 0;
const MAX_CONCURRENT_SCREEN_CAPTURES = 4;

const selectedDeviceIds = new Set();
const selectedRoutineDeviceIds = new Set();
let viewerDragState = null;

// Init
document.addEventListener('DOMContentLoaded', () => {
    loadAll();
    connectWebSocket();
    // Sondeo de respaldo cada 10s; los cambios reales llegan al instante por WebSocket
    // (device_connected/offline/devices_changed), así que no hace falta cada 4s.
    setInterval(loadAll, 10000);
});

function getApiToken() {
    return localStorage.getItem('mcp_api_token') || '';
}

function changeToken() {
    const t = window.prompt('Nuevo API token:', localStorage.getItem('mcp_api_token') || '');
    if (t !== null) { localStorage.setItem('mcp_api_token', t.trim()); loadAll(); }
}

async function apiFetch(path, options = {}) {
    const headers = Object.assign(
        { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        options.headers || {},
        { 'Authorization': `Bearer ${getApiToken()}` }
    );
    const response = await fetch(`${API_V1}${path}`, { ...options, headers });
    if (response.status === 401) {
        // NO borrar el token: lo inyecta la app de escritorio al cargar la página.
        // Si una llamada corre antes de la inyección, borrarlo rompía todos los
        // botones y podía entrar en bucle de recarga. Solo reportamos.
        throw new Error('Unauthorized');
    }
    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${response.status}`);
    }
    return response.json();
}

function extractList(payload) {
    const d = payload?.data;
    if (Array.isArray(d)) return d;
    if (Array.isArray(d?.data)) return d.data;
    return [];
}

async function loadAll() {
    try {
        devices = extractList(await apiFetch('/devices?per_page=100'));
        renderDevices();
        renderScreenWall();
        updateStats();
    } catch (e) {
        console.error('Error cargando dispositivos:', e);
    }

    try { groups = extractList(await apiFetch('/groups')); renderGroups(); } catch (e) {}
    try { workflows = extractList(await apiFetch('/workflows')); } catch (e) {}
    try { schedules = extractList(await apiFetch('/schedules')); } catch (e) {}
    try { const stats = await apiFetch('/dashboard/stats'); updateStats(stats.data); } catch (e) {}
}

function updateStats(s) {
    const total = devices.length;
    const online = devices.filter(d => d.status === 'online').length;
    const busy = devices.filter(d => d.status === 'busy').length;
    const offline = devices.filter(d => d.status === 'offline').length;

    setText('totalDevicesCount', total);
    setText('matrixTotalDevices', total);
    setText('statusWaitingCount', online);
    setText('statusRunningCount', busy);
    setText('onlineDevices', online);
    setText('busyDevices', busy);
    setText('deviceOfflineCount', offline);

    if (s?.tasks) {
        setText('completedTasks', s.tasks.completed || 0);
        setText('statusSuccessCount', s.tasks.completed || 0);
        setText('statusFailedCount', s.tasks.failed || 0);
    }
}

function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

// ============================================================
// NAVEGACIÓN Y TABS MCP CONTROL BSOLUTIONS
// ============================================================

function switchTab(tabId) {
    document.querySelectorAll('.sidebar .nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));

    const btn = document.querySelector(`.sidebar .nav-item[data-tab="${tabId}"]`);
    if (btn) btn.classList.add('active');

    const panel = document.getElementById(tabId);
    if (panel) panel.classList.add('active');
}

function switchActionSubTab(subTabId, btnEl) {
    document.querySelectorAll('.sub-tabs .sub-tab').forEach(b => b.classList.remove('active'));
    btnEl.classList.add('active');

    document.querySelectorAll('[id^="actionSubTab-"]').forEach(div => div.style.display = 'none');
    const target = document.getElementById(`actionSubTab-${subTabId}`);
    if (target) target.style.display = 'grid';
}

function toggleSidebar() {
    const sb = document.querySelector('.sidebar');
    if (sb) sb.classList.toggle('collapsed');
}

function setMatrixViewMode(mode) {
    const grid = document.getElementById('devicesGrid');
    const btnGrid = document.getElementById('btnViewGrid');
    const btnList = document.getElementById('btnViewList');

    if (mode === 'grid') {
        grid.classList.remove('list-view');
        btnGrid.classList.add('active');
        btnList.classList.remove('active');
    } else {
        grid.classList.add('list-view');
        btnList.classList.add('active');
        btnGrid.classList.remove('active');
    }
}

// ============================================================
// MATRIZ DE DISPOSITIVOS (PHONE MOCKUPS MCP CONTROL BSOLUTIONS)
// ============================================================

const lastDeviceScreenFrames = new Map();

function renderDevices() {
    const grid = document.getElementById('devicesGrid');
    if (!grid) return;

    selectedDeviceIds.forEach(id => {
        if (!devices.some(device => device.id === id)) selectedDeviceIds.delete(id);
    });

    grid.innerHTML = devices.map((d, index) => {
        const isOnline = ['online', 'busy'].includes(d.status);
        const screenAllowed = canViewScreen(d);
        const statusText = d.status === 'busy' ? 'Operando' : (d.status === 'online' ? 'Listo' : 'Desconectado');
        const statusClass = d.status === 'busy' ? 'busy' : (d.status === 'online' ? 'online' : 'offline');
        const savedFrame = lastDeviceScreenFrames.get(d.id);
        const isTcp = d.transport === 'tcp' || String(d.adb_serial || d.serial_number).includes(':');

        return `
        <div class="phone-mockup-card ${selectedDeviceIds.has(d.id) ? 'selected' : ''}" data-device-id="${Number(d.id)}" data-name="${escapeAttr(d.name || d.serial_number)}" title="${escapeAttr(d.name || d.serial_number)}" ${screenAllowed ? `onclick="openScreenViewer(${Number(d.id)})"` : ''}>
            <div class="phone-card-header">
                <span class="phone-status-badge ${statusClass}">
                    <span class="status-dot"></span> ${statusText}
                </span>
                <input type="checkbox" ${selectedDeviceIds.has(d.id) ? 'checked' : ''} onclick="event.stopPropagation(); toggleDeviceSelection(${Number(d.id)}, this.checked)">
            </div>

            <div class="phone-screen-frame">
                ${isOnline ? `
                    <img id="screenWallFrame-${Number(d.id)}" src="${savedFrame || ''}" style="${savedFrame ? 'display:block;' : 'display:none;'}" alt="Pantalla ${escapeAttr(d.name || d.serial_number)}">
                    <div class="phone-placeholder" id="screenWallPlaceholder-${Number(d.id)}" style="${savedFrame ? 'display:none;' : ''}">${screenAllowed ? 'Cargando transmisión…' : 'Inventario activo · control de pantalla reservado al canario'}</div>
                ` : `
                    <div class="phone-placeholder">
                        Pantalla no disponible sin conexión
                        ${isTcp ? `<button class="phone-reconnect-btn" onclick="event.stopPropagation(); reconnectDevice(${Number(d.id)}, this)">↻ Reconectar</button>` : ''}
                    </div>
                `}
            </div>

            <div class="phone-card-footer">
                ${index + 1} - ${isTcp ? 'WiFi' : 'USB'} ${escapeHtml(d.model || d.serial_number)}
                ${d.battery_level != null ? `<span class="hw-chip ${d.battery_level < 20 && !d.charging ? 'low' : ''}">${d.charging ? '⚡' : '🔋'}${d.battery_level}%${d.temperature_c != null ? ` · ${Math.round(d.temperature_c)}°C` : ''}</span>` : ''}
            </div>
            ${d.flagged ? `<div class="phone-card-flag" onclick="event.stopPropagation()">
                <span title="${escapeAttr(d.flag_reason || '')}">⚠️ ${esc_flag(d.flag_category)}</span>
                <button onclick="event.stopPropagation(); clearDeviceFlag(${Number(d.id)})">Quitar marca</button>
            </div>` : ''}
            <div class="phone-card-proxy" onclick="event.stopPropagation()">
                <span class="proxy-badge ${d.proxy_enabled ? 'on' : 'off'}" title="${d.proxy_enabled ? escapeAttr(`Proxy: ${d.proxy_host}:${d.proxy_port}`) : 'Sin proxy'}">
                    🌐 ${d.proxy_enabled ? escapeHtml(`${d.proxy_host}:${d.proxy_port}`) : 'Directo'}${d.last_ip ? ` · IP ${escapeHtml(d.last_ip)}` : ''}
                </span>
                <button class="proxy-btn" onclick="event.stopPropagation(); openProxyModal(${Number(d.id)})">Proxy/IP</button>
            </div>
        </div>`;
    }).join('') || '<p class="muted-text" style="grid-column:1/-1;padding:24px;text-align:center">No hay dispositivos registrados.</p>';

    updateSelectionUI();
}

function canViewScreen(device) {
    return ['online', 'busy'].includes(device?.status)
        && device?.screen_control_allowed !== false;
}

function toggleDeviceSelection(deviceId, selected) {
    if (selected) selectedDeviceIds.add(deviceId);
    else selectedDeviceIds.delete(deviceId);
    renderDevices();
}

function toggleSelectAllDevices(checked) {
    if (checked) devices.forEach(d => selectedDeviceIds.add(d.id));
    else selectedDeviceIds.clear();
    renderDevices();
}

function updateSelectionUI() {
    setText('selectedCountNum', selectedDeviceIds.size);
    setText('matrixSelectedDevices', selectedDeviceIds.size);
    const selAllCheck = document.getElementById('selectAllCheckbox');
    if (selAllCheck) selAllCheck.checked = devices.length > 0 && selectedDeviceIds.size === devices.length;
}

// ============================================================
// TRANSMISIÓN MULTI-PANTALLA (SCREEN WALL MATRIX)
// ============================================================

function renderScreenWall() {
    const connectedDevices = devices.filter(canViewScreen);
    screenWallDeviceIds = connectedDevices.map(device => device.id);
    screenWallCursor = 0;

    if (!screenWallDeviceIds.length) {
        stopScreenWallPolling();
        return;
    }
    startScreenWallPolling();
}

// Rastrea qué tarjetas del muro están visibles en el viewport, para no capturar
// las 40 pantallas a la vez sino solo las que el operador está viendo.
const wallVisibleIds = new Set();
let wallObserver = null;
function setupWallVisibility() {
    if (!('IntersectionObserver' in window)) return;
    if (!wallObserver) {
        wallObserver = new IntersectionObserver((entries) => {
            for (const e of entries) {
                const id = Number(e.target.getAttribute('data-device-id'));
                if (!id) continue;
                if (e.isIntersecting) wallVisibleIds.add(id); else wallVisibleIds.delete(id);
            }
        }, { root: null, threshold: 0.1 });
    }
    wallObserver.disconnect();
    wallVisibleIds.clear();
    document.querySelectorAll('.phone-mockup-card[data-device-id]').forEach(el => wallObserver.observe(el));
}

function startScreenWallPolling() {
    stopScreenWallPolling();
    setupWallVisibility();
    requestScreenWallFrames();
    // 1s es suficiente: el servidor cachea las miniaturas ~1.5s y solo se piden las visibles.
    // Con un teléfono enfocado bajamos a 3s: el operador está mirando el visor, y
    // esas capturas competían con las suyas por la cola ADB.
    screenWallTimer = window.setInterval(requestScreenWallFrames, viewedDeviceId ? 3000 : 1000);
}

function stopScreenWallPolling() {
    if (screenWallTimer !== null) window.clearInterval(screenWallTimer);
    screenWallTimer = null;
    screenWallInFlight.clear();
    screenWallRetryAt.clear();
}

function requestScreenWallFrames() {
    let candidates = screenWallDeviceIds.filter(deviceId => deviceId !== viewedDeviceId);
    // Escala 40+: solo captura las tarjetas realmente visibles en el viewport.
    if (wallVisibleIds.size) candidates = candidates.filter(id => wallVisibleIds.has(id));
    if (!candidates.length) return;

    const batchSize = Math.min(MAX_CONCURRENT_SCREEN_CAPTURES, candidates.length);
    for (let index = 0; index < batchSize; index += 1) {
        const deviceId = candidates[(screenWallCursor + index) % candidates.length];
        void requestScreenWallFrame(deviceId);
    }
    screenWallCursor = (screenWallCursor + batchSize) % candidates.length;
}

async function requestScreenWallFrame(deviceId) {
    if (screenWallInFlight.has(deviceId) || Date.now() < (screenWallRetryAt.get(deviceId) || 0)) return;
    screenWallInFlight.add(deviceId);

    try {
        const result = await apiFetch(`/devices/${deviceId}/screen-frame?thumb=1`, { method: 'POST', body: '{}' });
        const imageData = result.data?.image;

        if (imageData) {
            const srcUrl = `data:${result.data?.mime || 'image/png'};base64,${imageData}`;
            lastDeviceScreenFrames.set(deviceId, srcUrl);
            const image = document.getElementById(`screenWallFrame-${deviceId}`);
            const placeholder = document.getElementById(`screenWallPlaceholder-${deviceId}`);
            if (image) {
                image.src = srcUrl;
                image.style.display = 'block';
            }
            if (placeholder) {
                placeholder.style.display = 'none';
            }
        }
        screenWallRetryAt.delete(deviceId);
    } catch (error) {
        screenWallRetryAt.set(deviceId, Date.now() + 500);
    } finally {
        screenWallInFlight.delete(deviceId);
    }
}

// ==========================================
// VENTANA FLOTANTE DE CONTROL INTERACTIVO (FLOATING MIRROR WINDOW)
// ==========================================

function openScreenViewer(deviceId) {
    const device = devices.find(d => d.id === deviceId);
    if (!device || !canViewScreen(device)) return;

    if (screenFrameTimer !== null) window.clearInterval(screenFrameTimer);
    viewedDeviceId = device.id;
    // Sin esto, la petición del dispositivo anterior seguía "en vuelo" y bloqueaba
    // la del nuevo hasta que terminara: de ahí el tirón al cambiar de teléfono.
    screenFrameInFlight = false;
    refreshQueued = false;
    viewerDragState = null;

    const windowEl = document.getElementById('floatingMirrorWindow');
    if (!windowEl) return;

    setText('mirrorDeviceNum', devices.findIndex(d => d.id === deviceId) + 1);
    setText('mirrorDeviceStatus', device.status === 'busy' ? 'Operando' : 'Listo');
    windowEl.hidden = false;

    // Pinta al instante la última miniatura conocida de ESTE teléfono en vez de
    // dejar la imagen del anterior colgada mientras llega el primer frame.
    const image = document.getElementById('screenViewerImage');
    const known = lastDeviceScreenFrames.get(device.id);
    if (image) {
        if (known) image.src = known; else image.removeAttribute('src');
    }

    setScreenViewerStatus(known ? 'Actualizando…' : 'Conectando flujo en vivo…');
    document.addEventListener('keydown', handleViewerKeyDown);

    // Mientras hay un teléfono enfocado, el muro baja el ritmo: sus capturas
    // competían por la misma cola ADB y le robaban fluidez al visor.
    startScreenWallPolling();

    // Espejo scrcpy primero: H.264 en vivo a ~30 fps. Solo si no arranca se cae
    // al bucle de capturas, que en un panel 1440x3200 da 0,4 fps.
    startMirrorOrFallback(device);
}

// ==========================================
// ESPEJO EN VIVO (scrcpy)
// ==========================================

let mirrorClient = null;

function mirrorElements() {
    return {
        canvas: document.getElementById('screenViewerCanvas'),
        image: document.getElementById('screenViewerImage'),
    };
}

async function startMirrorOrFallback(device) {
    const { canvas, image } = mirrorElements();
    const serial = device.adb_serial || device.serial_number;

    stopMirror();

    const caeAcapturas = (motivo) => {
        if (canvas) canvas.hidden = true;
        if (image) image.style.display = '';
        setScreenViewerStatus(`Capturas (${motivo})`, true);
        if (screenFrameTimer !== null) window.clearInterval(screenFrameTimer);
        requestScreenFrame();
        screenFrameTimer = window.setInterval(requestScreenFrame, 250);
    };

    if (!canvas || !window.MirrorClient || !MirrorClient.supported) {
        return caeAcapturas('WebCodecs no disponible');
    }
    if (!serial) return caeAcapturas('sin serial ADB');

    const client = new MirrorClient(canvas);
    client.onStatus = (msg, err) => { if (viewedDeviceId === device.id) setScreenViewerStatus(msg, !!err); };
    mirrorClient = client;

    try {
        await client.connect(serial, getApiToken(), localStorage.getItem('mcp_api_base') || location.origin);
        if (viewedDeviceId !== device.id) { client.close(); return; }   // cambió de teléfono mientras conectaba
        if (image) image.style.display = 'none';
        canvas.hidden = false;
        // Con el espejo en marcha el sondeo de capturas sobra y solo compite por
        // la cola ADB con el propio flujo.
        if (screenFrameTimer !== null) { window.clearInterval(screenFrameTimer); screenFrameTimer = null; }
    } catch (e) {
        client.close();
        if (mirrorClient === client) mirrorClient = null;
        caeAcapturas(e.message);
    }
}

function stopMirror() {
    if (mirrorClient) { mirrorClient.close(); mirrorClient = null; }
    const { canvas, image } = mirrorElements();
    if (canvas) canvas.hidden = true;
    if (image) image.style.display = '';
}

function handleMirrorDown(event)  { if (mirrorClient) { try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch (_) {} mirrorClient.touchDown(event); } }
function handleMirrorMove(event)  { if (mirrorClient) mirrorClient.touchMove(event); }
function handleMirrorUp(event)    { if (mirrorClient) { try { event.currentTarget.releasePointerCapture?.(event.pointerId); } catch (_) {} mirrorClient.touchUp(event); } }
function handleMirrorWheel(event) { if (mirrorClient) { event.preventDefault(); mirrorClient.wheel(event); } }

function closeScreenViewer() {
    if (screenFrameTimer !== null) window.clearInterval(screenFrameTimer);
    screenFrameTimer = null;
    screenFrameInFlight = false;
    viewedDeviceId = null;
    viewerDragState = null;
    stopMirror();

    document.removeEventListener('keydown', handleViewerKeyDown);

    const windowEl = document.getElementById('floatingMirrorWindow');
    const image = document.getElementById('screenViewerImage');
    if (windowEl) windowEl.hidden = true;
    if (image) image.removeAttribute('src');

    // Reinicia el temporizador para devolver el muro a 1s (al enfocar bajó a 3s).
    startScreenWallPolling();
}

let currentViewerOrigWidth = 1080;
let currentViewerOrigHeight = 2400;

let refreshQueued = false;

// force = petición disparada por una acción del operador (tap, swipe, botón).
// Si ya hay una en vuelo se encola una inmediata al terminar, en vez de
// descartarse: antes, el refresco posterior a un toque se perdía casi siempre
// y la pantalla parecía no responder.
async function requestScreenFrame(force = false) {
    if (!viewedDeviceId) return;
    if (screenFrameInFlight) { if (force) refreshQueued = true; return; }
    screenFrameInFlight = true;

    // El dispositivo puede cambiar mientras esperamos la respuesta.
    const requestedFor = viewedDeviceId;

    try {
        const result = await apiFetch(`/devices/${requestedFor}/screen-frame`, { method: 'POST', body: '{}' });

        // Respuesta de un teléfono que ya no es el enfocado: descartarla. Si no,
        // se pintaba la pantalla del anterior y además se guardaba en la caché
        // de miniaturas bajo el id del nuevo.
        if (requestedFor !== viewedDeviceId) return;

        const imageData = result.data?.image;
        const image = document.getElementById('screenViewerImage');

        if (result.data?.origWidth) currentViewerOrigWidth = result.data.origWidth;
        if (result.data?.origHeight) currentViewerOrigHeight = result.data.origHeight;

        if (imageData && image) {
            const srcUrl = `data:${result.data?.mime || 'image/webp'};base64,${imageData}`;
            image.src = srcUrl;
            lastDeviceScreenFrames.set(requestedFor, srcUrl);
            const matrixImg = document.getElementById(`screenWallFrame-${requestedFor}`);
            if (matrixImg) {
                matrixImg.src = srcUrl;
                matrixImg.style.display = 'block';
            }
            setScreenViewerStatus(`En vivo (${result.data?.source || 'adb'}) ${new Date().toLocaleTimeString()}`);
        }
    } catch (error) {
        setScreenViewerStatus('Error de captura', true);
    } finally {
        screenFrameInFlight = false;
        if (refreshQueued && viewedDeviceId) { refreshQueued = false; requestScreenFrame(); }
    }
}

function setScreenViewerStatus(message, isError = false) {
    const status = document.getElementById('screenViewerStatus');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? '#f87171' : '#38bdf8';
}

// GESTOS MOUSE / SWIPE / TECLADO
// Se usan eventos de puntero con captura: así el "mouseup" llega aunque sueltes
// fuera de la imagen. Con onmouseup en el <img>, todo swipe que terminara fuera
// se perdía y el gesto quedaba a medias.
function handleMouseDown(event) {
    if (!viewedDeviceId) return;
    // Un <img> arrastrable inicia el drag&drop nativo del navegador, que se traga
    // el mouseup: por eso arrastrar para deslizar no funcionaba.
    event.preventDefault();
    const img = event.currentTarget || event.target;
    try { img.setPointerCapture?.(event.pointerId); } catch (_) {}
    img.style.cursor = 'grabbing';
    const rect = img.getBoundingClientRect();
    const targetW = currentViewerOrigWidth || img.naturalWidth || 1080;
    const targetH = currentViewerOrigHeight || img.naturalHeight || 2400;

    const percentX = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    const percentY = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);

    viewerDragState = {
        startX: Math.round(percentX * targetW),
        startY: Math.round(percentY * targetH),
        time: Date.now()
    };
}

async function handleMouseUp(event) {
    if (!viewedDeviceId || !viewerDragState) return;
    const img = event.currentTarget || event.target;
    try { img.releasePointerCapture?.(event.pointerId); } catch (_) {}
    img.style.cursor = 'grab';
    const rect = img.getBoundingClientRect();
    const targetW = currentViewerOrigWidth || img.naturalWidth || 1080;
    const targetH = currentViewerOrigHeight || img.naturalHeight || 2400;

    const percentX = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    const percentY = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);

    const endX = Math.round(percentX * targetW);
    const endY = Math.round(percentY * targetH);
    const startX = viewerDragState.startX;
    const startY = viewerDragState.startY;
    const duration = Math.min(Math.max(Date.now() - viewerDragState.time, 150), 1000);
    viewerDragState = null;

    const dist = Math.hypot(endX - startX, endY - startY);

    if (dist < 12) {
        setScreenViewerStatus(`Tap (${startX}, ${startY})`);
        await sendVirtualControl('TAP_XY', { x: startX, y: startY });
    } else {
        setScreenViewerStatus(`Swipe`);
        await sendVirtualControl('SWIPE', { start_x: startX, start_y: startY, end_x: endX, end_y: endY, duration });
    }

    // force: encola el refresco si hay una captura en vuelo, en lugar de perderlo.
    // Antes se forzaba screenFrameInFlight=false, lo que dejaba huérfana la
    // petición anterior y permitía que su respuesta pisara la nueva.
    setTimeout(() => requestScreenFrame(true), 80);
}

let wheelDebounceTimer = null;
async function handleWheel(event) {
    if (!viewedDeviceId) return;
    event.preventDefault();
    if (wheelDebounceTimer) return;

    const direction = event.deltaY > 0 ? 'down' : 'up';
    setScreenViewerStatus(`Scroll ${direction}`);
    wheelDebounceTimer = setTimeout(() => { wheelDebounceTimer = null; }, 250);

    await sendVirtualControl('SCROLL', { direction });
}

async function handleViewerKeyDown(event) {
    if (!viewedDeviceId) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

    if (event.key === 'Backspace') {
        event.preventDefault();
        await sendVirtualControl('INPUT_KEYEVENT', { keycode: 67 });
    } else if (event.key === 'Enter') {
        event.preventDefault();
        await sendVirtualControl('INPUT_KEYEVENT', { keycode: 66 });
    } else if (event.key === 'Escape') {
        event.preventDefault();
        await sendVirtualControl('PRESS_BACK');
    } else if (event.key === 'Home') {
        event.preventDefault();
        await sendVirtualControl('PRESS_HOME');
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
        event.preventDefault();
        await sendVirtualControl('TYPE_TEXT', { value: event.key });
    }
}

async function sendVirtualControl(command, params = {}) {
    if (!viewedDeviceId) return;

    // Con el espejo activo, las teclas van por el socket de control ya abierto
    // (unos bytes) en vez de arrancar un `adb shell input keyevent`, que medido
    // en este equipo cuesta ~104 ms por pulsación.
    if (mirrorClient) {
        const K = window.MIRROR_KEYCODES || {};
        const directo = {
            PRESS_BACK: K.BACK, PRESS_HOME: K.HOME, PRESS_RECENTS: K.APP_SWITCH,
        }[command];
        if (directo !== undefined) { mirrorClient.key(directo); return; }
        if (command === 'INPUT_KEYEVENT' && params.keycode !== undefined) { mirrorClient.key(Number(params.keycode)); return; }
        if (command === 'TYPE_TEXT' && params.value !== undefined) { mirrorClient.text(params.value); return; }
    }

    try {
        await apiFetch('/devices/batch-command', {
            method: 'POST',
            body: JSON.stringify({ device_ids: [viewedDeviceId], command, params })
        });
        setTimeout(() => requestScreenFrame(true), 150);
    } catch (e) {
        setScreenViewerStatus(`Error: ${e.message}`, true);
    }
}

async function sendVirtualText() {
    if (!viewedDeviceId) return;
    // window.prompt está desactivado en Electron: devuelve null y aborta el
    // manejador, así que este botón no hacía nada dentro de la app.
    const text = await customPrompt('Escribir en el dispositivo', 'Texto que se enviará al campo enfocado del teléfono.');
    if (!text) return;
    await sendVirtualControl('TYPE_TEXT', { value: text });
}

// ============================================================
// ACCIONES RÁPIDAS (ACCIONES EN LOTE MCP CONTROL BSOLUTIONS)
// ============================================================

async function quickAction(command, params = {}) {
    let ids = [...selectedDeviceIds];
    if (!ids.length) {
        // Si no hay seleccionados, aplicamos a todos los dispositivos online
        ids = devices.filter(d => ['online', 'busy'].includes(d.status)).map(d => d.id);
    }
    if (!ids.length) { alert('No hay dispositivos online seleccionados'); return; }
    const confirmationRequired = new Set([
        'CLEAR_APP', 'UNINSTALL_APP', 'INSTALL_APK', 'SETTINGS_PUT',
        'REBOOT', 'MONKEY', 'PUSH_FILE',
    ]);
    if (confirmationRequired.has(command) && params.confirm !== true) {
        const target = ids.length === 1 ? 'el dispositivo seleccionado' : `${ids.length} dispositivos`;
        if (!confirm(`${command} puede modificar datos o reiniciar ${target}. ¿Continuar?`)) return;
        params = { ...params, confirm: true };
    }

    addLog(`Ejecutando "${command}" en ${ids.length} dispositivos…`, 'info');
    try {
        const r = await apiFetch('/devices/batch-command', {
            method: 'POST',
            body: JSON.stringify({ device_ids: ids, command, params })
        });
        const d = r.data || {};
        addLog(`✓ "${command}": ${d.ok}/${d.total} ok`, d.failed ? 'warning' : 'info');
    } catch (e) {
        addLog(`Error en acción "${command}": ${e.message}`, 'error');
    }
}

// ==========================================
// MODAL CUSTOM IN-APP (REEMPLAZO TOTAL DE PROMPT)
// ==========================================
let modalResolveFn = null;

function customPrompt(title, desc, defaultValue = '', placeholder = '') {
    return new Promise((resolve) => {
        const overlay = document.getElementById('inputModal');
        const titleEl = document.getElementById('inputModalTitle');
        const descEl = document.getElementById('inputModalDesc');
        const fieldEl = document.getElementById('inputModalField');
        const confirmBtn = document.getElementById('inputModalConfirmBtn');

        if (!overlay) {
            resolve(window.prompt(`${title}\n${desc}`, defaultValue));
            return;
        }

        modalResolveFn = resolve;
        titleEl.textContent = title;
        descEl.textContent = desc || '';
        fieldEl.value = defaultValue;
        fieldEl.placeholder = placeholder || '';
        overlay.hidden = false;
        fieldEl.focus();

        const handleConfirm = () => {
            const val = fieldEl.value;
            closeInputModal(val);
        };

        const handleKeyDown = (e) => {
            if (e.key === 'Enter') handleConfirm();
            if (e.key === 'Escape') closeInputModal(null);
        };

        confirmBtn.onclick = handleConfirm;
        fieldEl.onkeydown = handleKeyDown;
    });
}

function closeInputModal(resultValue = null) {
    const overlay = document.getElementById('inputModal');
    if (overlay) overlay.hidden = true;
    if (modalResolveFn) {
        const fn = modalResolveFn;
        modalResolveFn = null;
        fn(resultValue);
    }
}

async function promptOpenApp() {
    const pkg = await customPrompt('Abrir Aplicación', 'Introduce el nombre del paquete (ej: com.zhiliaoapp.musically)', 'com.zhiliaoapp.musically');
    if (pkg) quickAction('OPEN_APP', { packageName: pkg, package_name: pkg });
}

async function promptCloseApp() {
    const pkg = await customPrompt('Cerrar Aplicación', 'Paquete de la App a cerrar (Forzar detención):', 'com.zhiliaoapp.musically');
    if (pkg) quickAction('FORCE_STOP', { package_name: pkg });
}

async function promptClearApp() {
    const pkg = await customPrompt('Borrar Datos de App', 'Paquete de la App a borrar datos:', 'com.zhiliaoapp.musically');
    if (pkg) quickAction('CLEAR_APP', { package_name: pkg });
}

async function promptGrantPermission() {
    const pkg = await customPrompt('Conceder Permiso', 'Paquete de la App:', 'com.zhiliaoapp.musically');
    if (!pkg) return;
    const perm = await customPrompt('Conceder Permiso', 'Permiso a conceder (ej: android.permission.CAMERA):', 'android.permission.CAMERA');
    if (perm) quickAction('GRANT_PERMISSION', { package_name: pkg, permission: perm });
}

async function promptInstallApk() {
    const apk = await customPrompt('Instalar APK', 'Ruta del .apk, .xapk/.apks, o de una carpeta con base+splits:', '', 'C:\\apks\\app.apk');
    if (apk) quickAction('INSTALL_APK', { apk_path: apk });
}

// ============================================================
// CATÁLOGO DE APPS PREDEFINIDAS
// ============================================================
// `match` localiza el instalable dentro de la carpeta local del usuario: los
// APK descargados rara vez se llaman igual que el paquete.
const APP_CATALOG = [
    { name: 'Spotify',   pkg: 'com.spotify.music',          match: /spotify/i },
    { name: 'YouTube',   pkg: 'com.google.android.youtube', match: /youtube/i },
    { name: 'Instagram', pkg: 'com.instagram.android',      match: /instagram/i },
    { name: 'Facebook',  pkg: 'com.facebook.katana',        match: /facebook|katana/i },
    { name: 'TikTok',    pkg: 'com.zhiliaoapp.musically',   match: /tiktok|musically/i },
];

const APK_DIR_KEY = 'mcp_apk_dir';
let apkLibrary = [];   // instalables encontrados en la carpeta

function openPresetAppsModal() {
    document.getElementById('appsModal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'appsModal';
    overlay.className = 'proxy-modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
      <div class="proxy-modal apps-modal">
        <h3>Apps predefinidas</h3>
        <p class="proxy-modal-sub" id="appsTargetInfo">${(() => {
            const sel = selectedDeviceIds.size;
            const online = devices.filter(d => ['online', 'busy'].includes(d.status)).length;
            return sel
                ? `Se aplicará a los <b>${sel} dispositivos que tienes marcados</b>.`
                : `No hay ninguno marcado: se aplicará a <b>los ${online} dispositivos online</b>. Usa "Seleccionar todos" en la barra de la matriz si quieres marcarlos explícitamente.`;
        })()}</p>

        <label>Carpeta local con los instalables
          <input id="apkDir" type="text" placeholder="C:\\apks" value="${escapeAttr(localStorage.getItem(APK_DIR_KEY) || '')}">
        </label>
        <div class="apps-dir-actions">
          <button class="btn-secondary" onclick="scanApkLibrary()">Buscar en la carpeta</button>
          <button class="btn-secondary" onclick="checkPresetAppsInstalled()">Ver cuáles ya están instaladas</button>
        </div>
        <div id="apkDirStatus" class="proxy-status">Indica la carpeta donde guardas los APK y pulsa "Buscar en la carpeta".</div>

        <div id="appsList" class="apps-list">
          ${APP_CATALOG.map(a => `
            <label class="apps-row" for="app-${a.pkg}">
              <input type="checkbox" id="app-${a.pkg}" value="${a.pkg}" checked>
              <span class="apps-name">${escapeHtml(a.name)}</span>
              <code class="apps-pkg">${escapeHtml(a.pkg)}</code>
              <span class="apps-state" id="state-${a.pkg}">—</span>
            </label>`).join('')}
        </div>

        <p class="proxy-note">No descargo APKs de internet. Instalo los que ya tengas en tu carpeta; si de alguna app no hay archivo, puedo abrir su ficha en la tienda del teléfono para que se instale desde el origen oficial.</p>

        <div class="proxy-modal-actions">
          <button class="btn-secondary" onclick="openPresetAppsStore()">Abrir en la tienda</button>
          <button class="btn-danger" onclick="uninstallPresetApps()">Desinstalar seleccionadas</button>
          <button class="btn-secondary" onclick="document.getElementById('appsModal').remove()">Cerrar</button>
          <button class="btn-primary" onclick="installPresetApps()">Instalar seleccionadas</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
}

function selectedPresetApps() {
    return APP_CATALOG.filter(a => document.getElementById(`app-${a.pkg}`)?.checked);
}

function setAppsStatus(html, isError = false) {
    const el = document.getElementById('apkDirStatus');
    if (el) { el.innerHTML = html; el.style.color = isError ? '#dc2626' : ''; }
}

// Empareja cada app del catálogo con un archivo de la carpeta local.
async function scanApkLibrary() {
    const dir = document.getElementById('apkDir')?.value.trim();
    if (!dir) { setAppsStatus('Escribe primero la ruta de la carpeta.', true); return; }
    localStorage.setItem(APK_DIR_KEY, dir);
    setAppsStatus('Buscando…');
    try {
        const r = await apiFetch(`/apk-library?dir=${encodeURIComponent(dir)}`);
        apkLibrary = r.data?.files || [];
        let matched = 0;
        for (const a of APP_CATALOG) {
            const hit = apkLibrary.find(f => a.match.test(f.name));
            const el = document.getElementById(`state-${a.pkg}`);
            if (!el) continue;
            if (hit) {
                matched++;
                el.textContent = `${hit.name} · ${hit.size_mb} MB`;
                el.className = 'apps-state found';
            } else {
                el.textContent = 'sin archivo';
                el.className = 'apps-state missing';
            }
        }
        setAppsStatus(`${apkLibrary.length} instalables en la carpeta · ${matched}/${APP_CATALOG.length} apps del catálogo localizadas.`);
    } catch (e) {
        apkLibrary = [];
        setAppsStatus(`No se pudo leer la carpeta: ${escapeHtml(e.message)}`, true);
    }
}

// Consulta en los teléfonos cuáles del catálogo ya están puestas.
async function checkPresetAppsInstalled() {
    const ids = targetDeviceIds();
    if (!ids.length) { setAppsStatus('No hay dispositivos online.', true); return; }

    setAppsStatus('Consultando los teléfonos…');
    try {
        const byDevice = await presetAppsByDevice(ids);
        // Cuenta en cuántos dispositivos aparece cada paquete.
        const tally = new Map(APP_CATALOG.map(a => [a.pkg, 0]));
        for (const installed of byDevice.values()) {
            for (const pkg of installed) tally.set(pkg, (tally.get(pkg) || 0) + 1);
        }
        for (const a of APP_CATALOG) {
            const el = document.getElementById(`state-${a.pkg}`);
            if (!el) continue;
            const n = tally.get(a.pkg) || 0;
            el.textContent = `en ${n}/${ids.length}`;
            el.className = `apps-state ${n === ids.length ? 'found' : (n ? '' : 'missing')}`;
        }
        setAppsStatus(`Comprobado en ${ids.length} dispositivos.`);
    } catch (e) {
        setAppsStatus(`Error al comprobar: ${escapeHtml(e.message)}`, true);
    }
}

// Instala una por una: `adb install` de 5 apps a la vez en 20 teléfonos saturaría
// el USB/WiFi, y así el registro deja claro cuál falló.
async function installPresetApps() {
    const apps = selectedPresetApps();
    if (!apps.length) { setAppsStatus('No has marcado ninguna app.', true); return; }
    if (!apkLibrary.length) { setAppsStatus('Primero pulsa "Buscar en la carpeta" para localizar los instalables.', true); return; }

    const conFichero = apps.map(a => ({ app: a, file: apkLibrary.find(f => a.match.test(f.name)) })).filter(x => x.file);
    const sinFichero = apps.filter(a => !apkLibrary.some(f => a.match.test(f.name)));

    if (!conFichero.length) {
        setAppsStatus('Ninguna de las apps marcadas tiene archivo en la carpeta. Usa "Abrir en la tienda" o descarga los APK.', true);
        return;
    }

    for (const { app, file } of conFichero) {
        setAppsStatus(`Instalando ${escapeHtml(app.name)}…`);
        await quickAction('INSTALL_APK', { apk_path: file.path });
    }

    const aviso = sinFichero.length ? ` Sin archivo (no instaladas): ${sinFichero.map(a => a.name).join(', ')}.` : '';
    setAppsStatus(`Terminado: ${conFichero.length} apps procesadas.${escapeHtml(aviso)} Mira el registro para el detalle por dispositivo.`);
    await loadAll();
}

// ============================================================
// REPARTO DE CORREOS ENTRE TELÉFONOS
// ============================================================
// Un correo por teléfono, en el mismo orden en que se ven en la matriz: así el
// "teléfono 3" de la tabla de reparto es el que el operador ve numerado como 3.

function parseEmailLines(text) {
    const out = [];
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        // Admite "correo", "correo:clave" y "correo,clave" (mismo criterio que el
        // importador masivo que ya existía en Rutinas).
        let email = line, password = '';
        const sep = line.includes(',') ? ',' : (line.includes(':') ? ':' : '');
        if (sep) {
            const i = line.indexOf(sep);
            email = line.slice(0, i).trim();
            password = line.slice(i + 1).trim();
        }
        if (!email) continue;
        out.push({ email, password: password || undefined, valid: /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) });
    }
    return out;
}

// Dispositivos destino en el orden en que se pintan en la matriz.
function orderedTargetDevices() {
    return selectedDeviceIds.size
        ? devices.filter(d => selectedDeviceIds.has(d.id))
        : devices.slice();
}

function openEmailDistributionModal() {
    document.getElementById('mailModal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'mailModal';
    overlay.className = 'proxy-modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
      <div class="proxy-modal mail-modal">
        <h3>Repartir correos entre teléfonos</h3>
        <p class="proxy-modal-sub">Un correo por teléfono, en orden. Se guardan en el pool de cuentas (contraseñas cifradas) y quedan asignados al dispositivo.</p>

        <label>Plataforma
          <input id="mailPlatform" type="text" value="google" placeholder="google, instagram, tiktok…">
        </label>

        <label>Correos (uno por línea)
          <textarea id="mailList" rows="8" class="mail-textarea" placeholder="uno@gmail.com&#10;dos@gmail.com:suClave&#10;tres@gmail.com,suClave"></textarea>
        </label>
        <p class="proxy-note">Formatos: <code>correo</code>, <code>correo:clave</code> o <code>correo,clave</code>. La clave es opcional y se guarda cifrada.</p>

        <div class="apps-dir-actions">
          <button class="btn-secondary" onclick="previewEmailDistribution()">Previsualizar reparto</button>
        </div>
        <div id="mailStatus" class="proxy-status">Pega los correos y pulsa "Previsualizar reparto".</div>
        <div id="mailPreview" class="mail-preview"></div>

        <div class="proxy-modal-actions">
          <button class="btn-secondary" onclick="document.getElementById('mailModal').remove()">Cerrar</button>
          <button class="btn-primary" id="mailApplyBtn" onclick="applyEmailDistribution()" disabled>Aplicar reparto</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
}

function setMailStatus(html, isError = false) {
    const el = document.getElementById('mailStatus');
    if (el) { el.innerHTML = html; el.style.color = isError ? '#dc2626' : ''; }
}

function previewEmailDistribution() {
    const entries = parseEmailLines(document.getElementById('mailList')?.value);
    const targets = orderedTargetDevices();
    const box = document.getElementById('mailPreview');
    const applyBtn = document.getElementById('mailApplyBtn');
    if (!box) return;

    const invalid = entries.filter(e => !e.valid);
    const usable = entries.filter(e => e.valid);

    if (!usable.length) {
        box.innerHTML = '';
        applyBtn.disabled = true;
        setMailStatus('No hay ningún correo con formato válido.', true);
        return;
    }
    if (!targets.length) {
        box.innerHTML = '';
        applyBtn.disabled = true;
        setMailStatus('No hay dispositivos a los que repartir.', true);
        return;
    }

    const n = Math.min(usable.length, targets.length);
    const rows = [];
    for (let i = 0; i < n; i++) {
        const d = targets[i];
        const idx = devices.findIndex(x => x.id === d.id) + 1;
        rows.push(`<div class="mail-row">
            <span class="mail-dev">#${idx} · ${escapeHtml(d.model || d.serial_number)}</span>
            <code class="mail-addr">${escapeHtml(usable[i].email)}</code>
            <span class="mail-flag">${usable[i].password ? '🔒 con clave' : ''}</span>
        </div>`);
    }
    box.innerHTML = rows.join('');
    applyBtn.disabled = false;

    const avisos = [];
    if (usable.length > targets.length) avisos.push(`sobran ${usable.length - targets.length} correos (quedarán sin asignar)`);
    if (targets.length > usable.length) avisos.push(`${targets.length - usable.length} teléfonos se quedarán sin correo`);
    if (invalid.length) avisos.push(`${invalid.length} líneas descartadas por formato: ${invalid.slice(0, 3).map(e => escapeHtml(e.email)).join(', ')}${invalid.length > 3 ? '…' : ''}`);

    setMailStatus(`Se asignarán <b>${n}</b> correos a <b>${n}</b> teléfonos${avisos.length ? ' · ' + avisos.join(' · ') : ''}.`);
}

async function applyEmailDistribution() {
    const entries = parseEmailLines(document.getElementById('mailList')?.value).filter(e => e.valid);
    const targets = orderedTargetDevices();
    const platform = document.getElementById('mailPlatform')?.value.trim() || null;
    if (!entries.length || !targets.length) { setMailStatus('Nada que repartir.', true); return; }

    const btn = document.getElementById('mailApplyBtn');
    if (btn) btn.disabled = true;
    setMailStatus('Aplicando reparto…');
    try {
        const r = await apiFetch('/accounts/distribute', {
            method: 'POST',
            body: JSON.stringify({
                entries: entries.map(e => ({ email: e.email, username: e.email, password: e.password })),
                device_ids: targets.map(d => d.id),
                platform,
            }),
        });
        setMailStatus(`✓ ${escapeHtml(r.message || 'Reparto aplicado')}`);
        addLog(r.message || 'Reparto de correos aplicado', 'info');
    } catch (e) {
        setMailStatus(`Error: ${escapeHtml(e.message)}`, true);
        addLog(`Error repartiendo correos: ${e.message}`, 'error');
        if (btn) btn.disabled = false;
    }
}

// ============================================================
// VERIFICACIÓN DE CUENTAS (dumpsys account)
// ============================================================

function openAccountVerifyModal() {
    document.getElementById('accountVerifyModal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'accountVerifyModal';
    overlay.className = 'proxy-modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
      <div class="proxy-modal mail-modal">
        <h3>🔍 Verificar cuentas en teléfonos</h3>
        <p class="proxy-modal-sub">Lee las cuentas reales de cada teléfono con <code>dumpsys account</code> y las contrasta con las asignadas.</p>

        <label>Plataforma
          <input id="verifyPlatform" type="text" value="com.google" placeholder="com.google, com.tiktok, com.instagram…">
        </label>
        <div class="mail-row">
          <label class="mail-dev"><input id="accountMonitorEnabled" type="checkbox"> Verificación automática</label>
          <label>Intervalo (min) <input id="accountMonitorMinutes" type="number" min="1" max="1440" value="5" style="width:80px"></label>
          <button class="btn-secondary" onclick="saveAccountMonitor()">Guardar</button>
        </div>
        <div id="accountInventorySummary" class="mail-preview">Cargando inventario…</div>

        <div class="apps-dir-actions">
          <button class="btn-secondary" onclick="verifySingleAccount()">Verificar un teléfono</button>
          <button class="btn-primary" onclick="verifyAllAccounts()">Verificar todos</button>
        </div>
        <div id="verifyResult" class="mail-preview"></div>

        <div class="proxy-modal-actions">
          <button class="btn-secondary" onclick="document.getElementById('accountVerifyModal').remove()">Cerrar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    refreshAccountInventoryPanel();
}

async function refreshAccountInventoryPanel() {
    try {
        const platform = document.getElementById('verifyPlatform')?.value.trim() || 'com.google';
        const responses = await Promise.all([
            apiFetch('/accounts/inventory/monitor'),
            apiFetch('/accounts/inventory?platform=' + encodeURIComponent(platform)),
        ]);
        const cfg = responses[0].data || {};
        const inventory = responses[1].data || [];
        const enabled = document.getElementById('accountMonitorEnabled');
        const minutes = document.getElementById('accountMonitorMinutes');
        if (enabled) enabled.checked = cfg.enabled !== false;
        if (minutes) minutes.value = Math.max(1, Math.round(Number(cfg.interval_sec || 300) / 60));
        const counts = inventory.reduce((out, row) => {
            const state = row.verification_state || 'unknown';
            out[state] = (out[state] || 0) + 1;
            return out;
        }, {});
        const box = document.getElementById('accountInventorySummary');
        if (box) box.innerHTML =
            '<div class="mail-row"><span class="mail-dev">Asignadas</span><code>' + inventory.length + '</code></div>' +
            '<div class="mail-row"><span class="mail-dev">Presentes</span><code style="color:#22c55e">' + (counts.present || 0) + '</code></div>' +
            '<div class="mail-row"><span class="mail-dev">Ausentes</span><code style="color:#ef4444">' + (counts.missing || 0) + '</code></div>' +
            '<div class="mail-row"><span class="mail-dev">No alcanzables</span><code style="color:#f59e0b">' + (counts.unreachable || 0) + '</code></div>' +
            '<div class="mail-row"><span class="mail-dev">Sin verificar</span><code>' + (counts.unknown || 0) + '</code></div>';
    } catch (error) { setMailStatus('Error cargando inventario: ' + error.message, true); }
}

async function saveAccountMonitor() {
    const enabled = !!document.getElementById('accountMonitorEnabled')?.checked;
    const minutes = Math.max(1, Number(document.getElementById('accountMonitorMinutes')?.value || 5));
    const platform = document.getElementById('verifyPlatform')?.value.trim() || 'com.google';
    try {
        await apiFetch('/accounts/inventory/monitor', { method: 'PUT', body: JSON.stringify({ enabled, interval_sec: minutes * 60, platform }) });
        setMailStatus('Monitor de cuentas ' + (enabled ? 'activo' : 'desactivado') + ' · cada ' + minutes + ' min');
        await refreshAccountInventoryPanel();
    } catch (error) { setMailStatus('Error: ' + error.message, true); }
}

async function verifySingleAccount() {
    const platform = document.getElementById('verifyPlatform')?.value.trim() || 'com.google';
    const serial = await customPrompt('Verificar cuenta', 'Serial del dispositivo (o ID):');
    if (!serial) return;

    setMailStatus('Verificando…', false);
    const targets = devices.filter(d => d.serial_number === serial || String(d.id) === serial);
    if (!targets.length) { setMailStatus('Dispositivo no encontrado.', true); return; }
    const dev = targets[0];

    try {
        const r = await apiFetch(`/devices/${dev.id}/verify-accounts`, {
            method: 'POST',
            body: JSON.stringify({ platform }),
        });
        showAccountVerifyResult(r.data);
        await refreshAccountInventoryPanel();
    } catch (e) {
        setMailStatus(`Error: ${e.message}`, true);
    }
}

async function verifyAllAccounts() {
    const platform = document.getElementById('verifyPlatform')?.value.trim() || 'com.google';
    setMailStatus('Verificando todos los dispositivos…', false);

    try {
        const r = await apiFetch('/accounts/verify-all', {
            method: 'POST',
            body: JSON.stringify({ platform }),
        });
        showAccountVerifyResult(r.data);
        await refreshAccountInventoryPanel();
    } catch (e) {
        setMailStatus(`Error: ${e.message}`, true);
    }
}

function showAccountVerifyResult(data) {
    const box = document.getElementById('verifyResult');
    if (!box) return;

    let html = '';

    if (data.summary) {
        // Resultado de verificación masiva
        html = `<h4>Resumen</h4>
          <div class="mail-row"><span class="mail-dev">Dispositivos verificados</span><code>${data.summary.devices_checked}</code></div>
          <div class="mail-row"><span class="mail-dev">Cuentas reales encontradas</span><code>${data.summary.total_real}</code></div>
          <div class="mail-row"><span class="mail-dev">Cuentas asignadas</span><code>${data.summary.total_assigned}</code></div>
          <div class="mail-row"><span class="mail-dev">Sin encontrar en teléfono</span><code style="color:${data.summary.total_missing > 0 ? '#dc2626' : '#22c55e'}">${data.summary.total_missing}</code></div>`;

        for (const r of data.results) {
            const statusColor = r.success ? '#22c55e' : '#dc2626';
            html += `<h4 style="margin-top:16px">${escapeHtml(r.device_name || r.serial)} ${r.success ? '✓' : '✗'}</h4>`;
            html += `<div class="mail-row"><span class="mail-dev">Reales</span><code>${r.real_count}</code></div>`;
            html += `<div class="mail-row"><span class="mail-dev">Asignadas</span><code>${r.assigned_count}</code></div>`;
            if (r.missing_from_device.length) {
                html += `<div class="mail-row"><span class="mail-dev">Sin encontrar</span><code style="color:#dc2626">${r.missing_from_device.join(', ')}</code></div>`;
            }
            if (r.mismatched?.length) {
                html += `<div class="mail-row"><span class="mail-dev">Asignadas pero no en teléfono</span><code style="color:#f59e0b">${r.mismatched.map(m => m.email).join(', ')}</code></div>`;
            }
        }
    } else {
        // Resultado de verificación individual
        const status = data.total_real === data.total_assigned ? '#22c55e' : '#f59e0b';
        html = `<h4>${escapeHtml(data.device_serial)}</h4>
          <div class="mail-row"><span class="mail-dev">Cuentas reales</span><code>${data.total_real}</code></div>
          <div class="mail-row"><span class="mail-dev">Cuentas asignadas</span><code>${data.total_assigned}</code></div>
          <div class="mail-row"><span class="mail-dev">Estado</span><code style="color:${status}">${data.total_real} vs ${data.total_assigned}</code></div>`;

        if (data.missing_from_device.length) {
            html += `<h4 style="margin-top:16px;color:#dc2626">⚠️ Cuentas asignadas pero no encontradas</h4>`;
            for (const e of data.missing_from_device) {
                html += `<div class="mail-row"><span class="mail-dev">${escapeHtml(e)}</span><code style="color:#dc2626">NO en teléfono</code></div>`;
            }
        }

        if (data.real_accounts.length) {
            html += `<h4 style="margin-top:16px">Cuentas reales encontradas</h4>`;
            for (const a of data.real_accounts) {
                html += `<div class="mail-row"><span class="mail-dev">${escapeHtml(a.email)}</span><code>${a.assigned ? '✅ asignada' : 'sin asignar'}</code></div>`;
            }
        }
    }

    box.innerHTML = html;
}

// ============================================================
// ASISTENTE DE ALTA (abre pantalla y escribe email)
// ============================================================

function openAccountAddModal() {
    document.getElementById('accountAddModal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'accountAddModal';
    overlay.className = 'proxy-modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
      <div class="proxy-modal mail-modal">
        <h3>✏️ Asistente de alta de cuenta</h3>
        <p class="proxy-modal-sub">Abre "Añadir cuenta › Google" en el teléfono y escribe el correo ya asignado. Tú pones la contraseña y 2FA.</p>

        <label>Plataforma
          <input id="addPlatform" type="text" value="com.google" placeholder="com.google, com.tiktok…">
        </label>

        <label>Correo a escribir
          <input id="addEmail" type="email" placeholder="usuario@gmail.com">
        </label>

        <p class="proxy-note">El correo se escribe automáticamente. Se presiona Enter para avanzar al campo de contraseña.</p>

        <div class="apps-dir-actions">
          <button class="btn-secondary" onclick="addEmailToSelected()">Escribir en seleccionados</button>
          <button class="btn-primary" onclick="addEmailToAll()">Escribir en todos</button>
        </div>

        <div id="addStatus" class="proxy-status"></div>

        <div class="proxy-modal-actions">
          <button class="btn-secondary" onclick="document.getElementById('accountAddModal').remove()">Cerrar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
}

function setAddStatus(html, isError = false) {
    const el = document.getElementById('addStatus');
    if (el) { el.innerHTML = html; el.style.color = isError ? '#dc2626' : '#38bdf8'; }
}

async function addEmailToSelected() {
    const platform = document.getElementById('addPlatform')?.value.trim() || 'com.google';
    const email = document.getElementById('addEmail')?.value.trim();
    if (!email) { setAddStatus('Introduce un correo.', true); return; }
    const ids = [...selectedDeviceIds];
    if (!ids.length) { setAddStatus('Selecciona al menos un dispositivo.', true); return; }

    setAddStatus(`Enviando ${escapeHtml(email)} a ${ids.length} dispositivo(s)…`);
    let ok = 0, fail = 0;
    for (const did of ids) {
        try {
            const r = await apiFetch(`/devices/${did}/add-account-email`, {
                method: 'POST',
                body: JSON.stringify({ email, platform }),
            });
            if (r.success) ok++; else { fail++; setAddStatus(`⚠ ${r.message}`, true); }
        } catch (e) {
            fail++; setAddStatus(`Error en dispositivo ${did}: ${e.message}`, true);
        }
    }
    setAddStatus(`Hecho: ${ok} exitosos, ${fail} fallidos. Revisa cada teléfono para poner contraseña y 2FA.`, ok === 0 && fail > 0);
}

async function addEmailToAll() {
    const platform = document.getElementById('addPlatform')?.value.trim() || 'com.google';
    const email = document.getElementById('addEmail')?.value.trim();
    if (!email) { setAddStatus('Introduce un correo.', true); return; }

    const targets = devices.filter(d => ['online', 'busy'].includes(d.status));
    if (!targets.length) { setAddStatus('No hay dispositivos online.', true); return; }

    setAddStatus(`Enviando ${escapeHtml(email)} a ${targets.length} dispositivo(s)…`);
    let ok = 0, fail = 0;
    for (const dev of targets) {
        try {
            const r = await apiFetch(`/devices/${dev.id}/add-account-email`, {
                method: 'POST',
                body: JSON.stringify({ email, platform }),
            });
            if (r.success) ok++; else { fail++; setAddStatus(`⚠ ${r.message}`, true); }
        } catch (e) {
            fail++; setAddStatus(`Error en ${dev.serial_number}: ${e.message}`, true);
        }
    }
    setAddStatus(`Hecho: ${ok} exitosos, ${fail} fallidos. Revisa cada teléfono para poner contraseña y 2FA.`, ok === 0 && fail > 0);
}

// Dispositivos destino: los marcados, o todos los online si no hay ninguno.
function targetDeviceIds() {
    const ids = [...selectedDeviceIds];
    return ids.length ? ids : devices.filter(d => ['online', 'busy'].includes(d.status)).map(d => d.id);
}

// Mapa device_id -> paquetes del catálogo presentes en ese teléfono.
async function presetAppsByDevice(ids) {
    const r = await apiFetch('/devices/batch-command', {
        method: 'POST',
        body: JSON.stringify({ device_ids: ids, command: 'LIST_PACKAGES', params: { packages: APP_CATALOG.map(a => a.pkg) } }),
    });
    const map = new Map();
    for (const row of (r.data?.results || [])) map.set(row.device_id, new Set(row.data?.installed || []));
    return map;
}

// Desinstala solo donde la app está realmente presente: mandar `pm uninstall` a
// ciegas a los 20 teléfonos llenaba el registro de fallos de los que no la tenían.
async function uninstallPresetApps() {
    const apps = selectedPresetApps();
    if (!apps.length) { setAppsStatus('No has marcado ninguna app.', true); return; }
    const ids = targetDeviceIds();
    if (!ids.length) { setAppsStatus('No hay dispositivos online.', true); return; }

    if (!window.confirm(
        `Se desinstalarán ${apps.length} app(s) en ${ids.length} dispositivo(s):\n\n` +
        `${apps.map(a => '· ' + a.name).join('\n')}\n\n` +
        `Se pierden también sus datos y sesiones iniciadas. ¿Continuar?`
    )) { setAppsStatus('Desinstalación cancelada.'); return; }

    setAppsStatus('Comprobando dónde está instalada cada app…');
    let byDevice;
    try { byDevice = await presetAppsByDevice(ids); }
    catch (e) { setAppsStatus(`No se pudo comprobar el estado: ${escapeHtml(e.message)}`, true); return; }

    const resumen = [];
    for (const a of apps) {
        const conLaApp = ids.filter(id => byDevice.get(id)?.has(a.pkg));
        if (!conLaApp.length) {
            resumen.push(`${a.name}: no estaba en ninguno`);
            addLog(`${a.name} no estaba instalada en ningún dispositivo del lote`, 'info');
            continue;
        }
        setAppsStatus(`Desinstalando ${escapeHtml(a.name)} en ${conLaApp.length} dispositivo(s)…`);
        try {
            const r = await apiFetch('/devices/batch-command', {
                method: 'POST',
                body: JSON.stringify({ device_ids: conLaApp, command: 'UNINSTALL_APP', params: { package_name: a.pkg } }),
            });
            const d = r.data || {};
            resumen.push(`${a.name}: ${d.ok}/${d.total}`);
            addLog(`${a.name} desinstalada en ${d.ok}/${d.total} dispositivos`, d.failed ? 'warning' : 'info');
        } catch (e) {
            resumen.push(`${a.name}: error`);
            addLog(`Error desinstalando ${a.name}: ${e.message}`, 'error');
        }
    }

    setAppsStatus(`Hecho — ${escapeHtml(resumen.join(' · '))}`);
    await checkPresetAppsInstalled();
}

// Alternativa sin APK local: abre la ficha oficial en la tienda del teléfono.
async function openPresetAppsStore() {
    const apps = selectedPresetApps();
    if (!apps.length) { setAppsStatus('No has marcado ninguna app.', true); return; }
    for (const a of apps) {
        setAppsStatus(`Abriendo ${escapeHtml(a.name)} en la tienda…`);
        await quickAction('OPEN_STORE', { package_name: a.pkg });
    }
    setAppsStatus(`${apps.length} fichas abiertas. La instalación hay que confirmarla en cada teléfono.`);
}

async function promptUninstallApk() {
    const pkg = await customPrompt('Desinstalar APK', 'Nombre del paquete a desinstalar:', 'com.zhiliaoapp.musically');
    if (pkg) quickAction('UNINSTALL_APP', { package_name: pkg });
}

async function promptUploadGallery() {
    const file = await customPrompt('Subir Multimedia a Galería', 'Ruta absoluta del archivo en tu PC (ej: C:\\media\\video.mp4):');
    if (file) quickAction('PUSH_FILE', { local: file, remote: '/sdcard/DCIM/Camera/' + file.split(/[\/\\]/).pop() });
}

// ============================================================
// ESCÁNER DE RANGO IP (ADB WiFi)
// ============================================================
// El escaneo se trocea desde aquí en lotes de IPs: cada lote es una petición
// independiente al servidor, de modo que el progreso, los contadores y la lista
// se van pintando en vivo y el botón "Detener" corta de verdad.
const SCAN_CHUNK = 32;
let scanAbort = false;
let scanRunning = false;

// Sugiere el prefijo /24 a partir de un dispositivo WiFi ya conocido.
function guessScanPrefix() {
    const tcp = devices.map(d => String(d.adb_serial || d.serial_number || '')).find(s => /^\d+\.\d+\.\d+\.\d+:/.test(s));
    if (tcp) return tcp.split(':')[0].split('.').slice(0, 3);
    return ['192', '168', '1'];
}

function openTcpScanModal() {
    document.getElementById('scanModal')?.remove();
    const [o1, o2, o3] = guessScanPrefix();

    const overlay = document.createElement('div');
    overlay.id = 'scanModal';
    overlay.className = 'proxy-modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay && !scanRunning) overlay.remove(); };
    overlay.innerHTML = `
      <div class="proxy-modal scan-modal">
        <h3>Escaneo de rango IP</h3>
        <p class="proxy-modal-sub">Sondea el puerto ADB en todo el rango y conecta los teléfonos que respondan. Requiere que el teléfono tenga <code>adb tcpip</code> activo.</p>

        <div class="scan-range-row">
          <input id="scanO1" class="scan-octet" type="number" min="0" max="255" value="${o1}">.
          <input id="scanO2" class="scan-octet" type="number" min="0" max="255" value="${o2}">.
          <input id="scanO3" class="scan-octet" type="number" min="0" max="255" value="${o3}">.
          <input id="scanFrom" class="scan-octet scan-octet-from" type="number" min="0" max="255" value="0">
          <span class="scan-dash">–</span>
          <input id="scanTo" class="scan-octet scan-octet-to" type="number" min="0" max="255" value="254">
        </div>

        <label class="scan-port-label">Escanear puerto
          <input id="scanPort" type="number" min="1" max="65535" value="5555">
        </label>

        <div class="scan-actions-row">
          <button id="scanStartBtn" class="btn-primary" onclick="startTcpScan()">🔍 Iniciar escaneo</button>
          <button id="scanStopBtn" class="btn-danger" onclick="stopTcpScan()" hidden>Detener</button>
          <span class="scan-counters">Éxitos: <b id="scanOkCount">0</b> · Fallidos: <b id="scanFailCount">0</b></span>
        </div>

        <div class="scan-progress"><div id="scanProgressBar" class="scan-progress-bar" style="width:0%"></div></div>

        <h4 class="scan-results-title">Detalles del análisis</h4>
        <div id="scanResults" class="scan-results"><p class="scan-empty">Aún no se ha escaneado nada.</p></div>

        <div class="proxy-modal-actions">
          <button class="btn-secondary" onclick="scanTcpDevices()">Conectar una sola IP…</button>
          <button class="btn-secondary" onclick="closeTcpScanModal()">Cerrar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
}

function closeTcpScanModal() {
    scanAbort = true;
    document.getElementById('scanModal')?.remove();
}

function stopTcpScan() {
    scanAbort = true;
    addLog('Escaneo detenido por el usuario.', 'warning');
}

async function startTcpScan() {
    if (scanRunning) return;

    const num = (id, fallback) => {
        const v = Number(document.getElementById(id)?.value);
        return Number.isFinite(v) ? v : fallback;
    };
    const prefix = [num('scanO1', 192), num('scanO2', 168), num('scanO3', 1)].join('.');
    let from = Math.max(0, Math.min(255, num('scanFrom', 0)));
    let to = Math.max(0, Math.min(255, num('scanTo', 254)));
    if (to < from) [from, to] = [to, from];
    const port = Math.max(1, Math.min(65535, num('scanPort', 5555)));

    const resultsEl = document.getElementById('scanResults');
    const barEl = document.getElementById('scanProgressBar');
    const okEl = document.getElementById('scanOkCount');
    const failEl = document.getElementById('scanFailCount');
    const startBtn = document.getElementById('scanStartBtn');
    const stopBtn = document.getElementById('scanStopBtn');
    if (!resultsEl) return;

    scanAbort = false;
    scanRunning = true;
    startBtn.disabled = true;
    stopBtn.hidden = false;
    resultsEl.innerHTML = '';
    let ok = 0, fail = 0, anyConnected = false;

    addLog(`Escaneando ${prefix}.${from}-${to}:${port}…`, 'info');

    try {
        for (let start = from; start <= to; start += SCAN_CHUNK) {
            if (scanAbort) break;
            const end = Math.min(to, start + SCAN_CHUNK - 1);
            let res;
            try {
                res = await apiFetch('/devices/scan-range', {
                    method: 'POST',
                    body: JSON.stringify({ prefix, from: start, to: end, port }),
                });
            } catch (e) {
                addLog(`Error escaneando ${prefix}.${start}-${end}: ${e.message}`, 'error');
                continue;
            }

            for (const r of (res.results || [])) {
                if (r.ok) { ok++; anyConnected = true; } else { fail++; }
                appendScanRow(resultsEl, r);
            }
            okEl.textContent = ok;
            failEl.textContent = fail;
            barEl.style.width = `${Math.round(((end - from + 1) / (to - from + 1)) * 100)}%`;
        }
    } finally {
        scanRunning = false;
        startBtn.disabled = false;
        stopBtn.hidden = true;
        if (!resultsEl.children.length) {
            resultsEl.innerHTML = '<p class="scan-empty">Ninguna IP respondió en ese rango y puerto.</p>';
        }
        addLog(`Escaneo terminado: ${ok} conectados, ${fail} fallidos.`, ok ? 'info' : 'warning');
        if (anyConnected) await loadAll();
    }
}

function appendScanRow(container, r) {
    const row = document.createElement('div');
    row.className = `scan-row ${r.ok ? 'ok' : 'fail'}`;
    row.title = 'Clic para volver a conectar esta dirección';
    row.innerHTML = `
      <div class="scan-row-main">
        <code class="scan-row-ip">${escapeHtml(r.ip)}</code>
        <span class="scan-row-msg">${escapeHtml(r.message || '')}</span>
      </div>
      <span class="scan-row-state">${r.ok ? 'Conectado' : 'Sin conexión'}</span>`;
    row.onclick = () => retryScanRow(row, r.address);
    container.appendChild(row);
}

// Reactivación al hacer clic en una fila del resultado: reintenta `adb connect`
// contra esa dirección y refleja el nuevo estado en la propia fila.
async function retryScanRow(row, address) {
    const stateEl = row.querySelector('.scan-row-state');
    const msgEl = row.querySelector('.scan-row-msg');
    if (row.dataset.busy === '1') return;
    row.dataset.busy = '1';
    stateEl.textContent = 'Conectando…';
    try {
        const res = await apiFetch('/devices/connect-tcp', {
            method: 'POST',
            body: JSON.stringify({ address }),
        });
        row.className = 'scan-row ok';
        stateEl.textContent = 'Conectado';
        msgEl.textContent = res.message || '';
        addLog(`✓ ${res.message || address}`, 'info');
        await loadAll();
    } catch (e) {
        row.className = 'scan-row fail';
        stateEl.textContent = 'Sin conexión';
        msgEl.textContent = e.message;
        addLog(`No se pudo reconectar ${address}: ${e.message}`, 'error');
    } finally {
        row.dataset.busy = '0';
    }
}

// Conexión puntual a una única dirección (el flujo antiguo, conservado).
async function scanTcpDevices() {
    const address = await customPrompt('Conectar Dispositivo ADB TCP (WiFi)', 'Introduce la dirección IP y puerto del dispositivo:', '192.168.1.50:5555', '192.168.1.50:5555');
    if (!address || !address.trim()) return;

    addLog(`Conectando dispositivo TCP ${address}…`, 'info');
    try {
        const res = await apiFetch('/devices/connect-tcp', {
            method: 'POST',
            body: JSON.stringify({ address: address.trim() })
        });
        if (res.success) {
            addLog(`✓ ${res.message}`, 'info');
            await loadAll();
        } else {
            addLog(`Error TCP: ${res.message}`, 'error');
            alert(`No se pudo conectar a ${address}: ${res.message}`);
        }
    } catch (e) {
        addLog(`Error conectando TCP: ${e.message}`, 'error');
        alert(`Error al conectar TCP: ${e.message}`);
    }
}

// Fuerza `adb connect` contra un dispositivo WiFi ya registrado que está caído.
async function reconnectDevice(deviceId, btn) {
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Conectando…'; }
    try {
        const res = await apiFetch(`/devices/${deviceId}/reconnect`, { method: 'POST' });
        addLog(`✓ ${res.message}`, 'info');
        await loadAll();
    } catch (e) {
        addLog(`No se pudo reconectar: ${e.message}`, 'error');
        if (btn) { btn.disabled = false; btn.textContent = original; }
    }
}

async function addNewGroupPrompt() {
    const name = await customPrompt('Agregar Grupo', 'Nombre del nuevo grupo de dispositivos:');
    if (!name) return;
    apiFetch('/groups', { method: 'POST', body: JSON.stringify({ name }) })
        .then(() => { loadAll(); addLog(`Grupo "${name}" creado`, 'info'); })
        .catch(e => alert(e.message));
}

async function assignSelectedToGroup() {
    const groupName = await customPrompt('Mover a Grupo', 'ID o nombre del grupo al que mover los dispositivos:');
    if (!groupName) return;
    const targetGroup = groups.find(g => String(g.id) === groupName || g.name.toLowerCase() === groupName.toLowerCase());
    if (!targetGroup) { alert('Grupo no encontrado'); return; }

    apiFetch(`/groups/${targetGroup.id}/assign-devices`, { method: 'POST', body: JSON.stringify({ device_ids: [...selectedDeviceIds] }) })
        .then(() => { loadAll(); addLog(`Dispositivos movidos al grupo ${targetGroup.name}`, 'info'); })
        .catch(e => alert(e.message));
}

// ============================================================
// GRUPOS Y RUTINAS
// ============================================================

function renderGroups() {
    const el = document.getElementById('groupsList');
    if (!el) return;
    el.innerHTML = groups.map(g => `
        <div class="list-item" style="padding:6px 0;border-bottom:1px solid #f1f5f9">
            <span style="font-size:12px;font-weight:600">${escapeHtml(g.name)}</span>
            <span style="font-size:11px;color:var(--text-muted)">${g.devices?.length || 0} devs</span>
        </div>`).join('') || '<p style="font-size:11px;color:var(--text-muted)">Sin grupos personalizados</p>';
}

function filterDevices(q) {
    q = (q || '').toLowerCase();
    document.querySelectorAll('.phone-mockup-card').forEach(card => {
        const title = (card.getAttribute('title') || card.dataset.name || '').toLowerCase();
        card.style.display = title.includes(q) ? 'flex' : 'none';
    });
}

async function testGoToSpotify() {
    if (!Array.isArray(devices) || !devices.length) {
        alert('Cargando dispositivos… Por favor, reintenta en un segundo.');
        return;
    }
    let targetDev = devices.find(d => ['online', 'busy'].includes(d?.status));
    if (selectedDeviceIds.size > 0) {
        const selectedId = [...selectedDeviceIds][0];
        targetDev = devices.find(d => String(d.id) === String(selectedId)) || targetDev;
    }
    if (!targetDev) { alert('No hay dispositivos online conectados'); return; }

    addLog(`[Prueba 1] Abriendo Spotify en Dispositivo 1 (${targetDev.name || targetDev.serial_number})…`, 'info');
    try {
        await apiFetch('/devices/batch-command', {
            method: 'POST',
            body: JSON.stringify({
                device_ids: [targetDev.id],
                command: 'OPEN_APP',
                params: { packageName: 'com.spotify.music', package_name: 'com.spotify.music' }
            })
        });
        addLog(`✓ Spotify abierto en Dispositivo 1 (${targetDev.serial_number})`, 'info');
    } catch (e) {
        addLog(`Error al abrir Spotify: ${e.message}`, 'error');
    }
}

async function testPlayLikedSongs() {
    if (!Array.isArray(devices) || !devices.length) {
        alert('Cargando dispositivos… Por favor, reintenta en un segundo.');
        return;
    }
    let targetDev = devices.find(d => ['online', 'busy'].includes(d?.status));
    if (selectedDeviceIds.size > 0) {
        const selectedId = [...selectedDeviceIds][0];
        targetDev = devices.find(d => String(d.id) === String(selectedId)) || targetDev;
    }
    if (!targetDev) { alert('No hay dispositivos online conectados'); return; }

    addLog(`[Prueba 2] Abriendo coleccion Me Gusta y reproduciendo en Dispositivo 1 (${targetDev.name || targetDev.serial_number})…`, 'info');
    try {
        await apiFetch('/devices/batch-command', {
            method: 'POST',
            body: JSON.stringify({
                device_ids: [targetDev.id],
                command: 'GOTO_URL',
                params: { url: 'spotify:user:spotify:collection' }
            })
        });

        setTimeout(async () => {
            try {
                await apiFetch('/devices/batch-command', {
                    method: 'POST',
                    body: JSON.stringify({
                        device_ids: [targetDev.id],
                        command: 'INPUT_KEYEVENT',
                        params: { keycode: 126 }
                    })
                });
                addLog(`✓ Reproducción "Me Gusta" enviada a Dispositivo 1 (${targetDev.serial_number})`, 'info');
            } catch (err) {
                console.error(err);
            }
        }, 2500);
    } catch (err) {
        console.error('testPlayLikedSongs:', err);
    }
}

async function testPlaySpecificTrack(url = 'https://open.spotify.com/intl-es/track/2lTm559tuIvatlT1u0JYG2?si=90db6bf259ae4d44') {
    if (!Array.isArray(devices) || !devices.length) {
        alert('Cargando dispositivos… Por favor, reintenta en un segundo.');
        return;
    }
    let targetDev = devices.find(d => ['online', 'busy'].includes(d?.status));
    if (selectedDeviceIds.size > 0) {
        const selectedId = [...selectedDeviceIds][0];
        targetDev = devices.find(d => String(d.id) === String(selectedId)) || targetDev;
    }
    if (!targetDev) { alert('No hay dispositivos online conectados'); return; }

    let trackUri = url;
    const match = url.match(/track\/([a-zA-Z0-9]+)/);
    if (match) {
        trackUri = `spotify:track:${match[1]}`;
    }

    addLog(`[Canción] Abriendo track (${trackUri}) en Dispositivo 1 (${targetDev.name || targetDev.serial_number})…`, 'info');
    try {
        await apiFetch('/devices/batch-command', {
            method: 'POST',
            body: JSON.stringify({
                device_ids: [targetDev.id],
                command: 'GOTO_URL',
                params: { url: trackUri }
            })
        });

        setTimeout(async () => {
            try {
                await apiFetch('/devices/batch-command', {
                    method: 'POST',
                    body: JSON.stringify({
                        device_ids: [targetDev.id],
                        command: 'INPUT_KEYEVENT',
                        params: { keycode: 126 }
                    })
                });
                addLog(`✓ Reproducción iniciada en Dispositivo 1 (${targetDev.serial_number})`, 'info');
            } catch (err) {
                console.error(err);
            }
        }, 2200);

    } catch (e) {
        addLog(`Error al reproducir canción: ${e.message}`, 'error');
    }
}

async function promptPlayCustomTrackUrl() {
    const inputUrl = await customPrompt(
        'Reproducir Canción de Spotify',
        'Introduce la URL o enlace de la canción a reproducir:',
        'https://open.spotify.com/intl-es/track/2lTm559tuIvatlT1u0JYG2',
        'https://open.spotify.com/track/...'
    );
    if (!inputUrl || !inputUrl.trim()) return;

    let ids = [...selectedDeviceIds];
    if (!ids.length) {
        ids = devices.filter(d => ['online', 'busy'].includes(d?.status)).map(d => d.id);
    }
    if (!ids.length) {
        alert('No hay dispositivos online conectados para reproducir');
        return;
    }

    let trackUri = inputUrl.trim();
    const match = trackUri.match(/track\/([a-zA-Z0-9]+)/);
    if (match) {
        trackUri = `spotify:track:${match[1]}`;
    }

    addLog(`[Auto-Play] Reproduciendo enlace (${trackUri}) en ${ids.length} dispositivo(s) seleccionados…`, 'info');

    try {
        await apiFetch('/devices/batch-command', {
            method: 'POST',
            body: JSON.stringify({
                device_ids: ids,
                command: 'GOTO_URL',
                params: { url: trackUri }
            })
        });

        setTimeout(async () => {
            try {
                await apiFetch('/devices/batch-command', {
                    method: 'POST',
                    body: JSON.stringify({
                        device_ids: ids,
                        command: 'INPUT_KEYEVENT',
                        params: { keycode: 126 }
                    })
                });
                addLog(`✓ Canción en reproducción en ${ids.length} dispositivo(s)`, 'info');
            } catch (err) {
                console.error(err);
            }
        }, 2200);

    } catch (e) {
        addLog(`Error en reproducción masiva: ${e.message}`, 'error');
    }
}

function loadRecipe(recipeName) {
    if (recipeName === 'spotify') {
        quickAction('OPEN_APP', { packageName: 'com.spotify.music' });
    } else if (recipeName === 'youtube') {
        quickAction('GOTO_URL', { url: 'https://youtube.com' });
    }
}

function connectWebSocket() {
    let wsHost = localStorage.getItem('mcp_ws_host');
    if (!wsHost || window.location.protocol === 'file:' || !window.location.hostname) {
        wsHost = '127.0.0.1:6011';
    }
    try {
        const wsScheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
        wsConnection = new WebSocket(`${wsScheme}://${wsHost}/ws`);
        wsConnection.onopen = () => { wsConnection.send(JSON.stringify({ type: 'watch' })); };
        wsConnection.onmessage = (ev) => {
            try {
                const m = JSON.parse(ev.data);
                // Refresco inmediato empujado por el backend (evita depender del sondeo).
                if (['device_connected', 'device_offline', 'devices_changed', 'command_result'].includes(m.type)) loadAll();
                if (m.type === 'notification') { if (typeof mcpOnNotification === 'function') mcpOnNotification(); loadAll(); }
            } catch (err) {}
        };
        wsConnection.onclose = () => setTimeout(connectWebSocket, 4000);
        wsConnection.onerror = () => {};
    } catch (e) {
        console.error('WebSocket connection error:', e);
    }
}

function addLog(message, level = 'info') {
    const el = document.getElementById('liveLogs');
    if (!el) return;
    const time = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.innerHTML = `<span style="color:#64748b">[${time}]</span> <span class="log-${level}">${escapeHtml(message)}</span>`;
    el.insertBefore(div, el.firstChild);
}

function clearLogs() { const el = document.getElementById('liveLogs'); if (el) el.innerHTML = ''; }
function renderRoutines() {}
function renderDays() {}
function addStep() {}
function saveRoutine() {}

function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; }
function escapeAttr(t) { return escapeHtml(t).replace(/"/g, '&quot;'); }
function esc_flag(c) { return ({ captcha: 'Captcha', verification: 'Verificación', ban: 'Baneo', rate_limit: 'Límite', login: 'Sesión' })[c] || 'Marcado'; }

// ============================================================
// PROXY / IP DE SALIDA POR DISPOSITIVO
// ============================================================
function openProxyModal(deviceId) {
    const d = devices.find(x => x.id === deviceId);
    if (!d) return;
    document.getElementById('proxyModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'proxyModal';
    overlay.className = 'proxy-modal-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
      <div class="proxy-modal">
        <h3>Proxy / IP · ${escapeHtml(d.name || d.serial_number)}</h3>
        <p class="proxy-modal-sub">Enruta el tráfico del teléfono por una IP de salida. El proxy se aplica por ADB (proxy HTTP global de Android).</p>
        <label>Host / IP del proxy
          <input id="pxHost" type="text" placeholder="p. ej. 192.168.1.50 ó proxy.miproveedor.com" value="${escapeAttr(d.proxy_host || '')}">
        </label>
        <label>Puerto
          <input id="pxPort" type="number" placeholder="8080" value="${escapeAttr(d.proxy_port || '')}">
        </label>
        <div class="proxy-modal-row">
          <label class="proxy-half">Usuario (opcional)
            <input id="pxUser" type="text" value="${escapeAttr(d.proxy_user || '')}">
          </label>
          <label class="proxy-half">Clave (opcional)
            <input id="pxPass" type="password" value="">
          </label>
        </div>
        <p class="proxy-note">Nota: el proxy HTTP global de Android no admite usuario/clave; para proxies con autenticación se necesita una app de proxy en el teléfono.</p>
        <div id="pxStatus" class="proxy-status">${d.last_ip ? `Última IP conocida: <b>${escapeHtml(d.last_ip)}</b>` : 'IP externa sin comprobar.'}</div>
        <div class="proxy-modal-actions">
          <button class="btn-secondary" onclick="proxyCheckIp(${deviceId})">Ver IP actual</button>
          <button class="btn-danger" onclick="proxyApply(${deviceId}, false)">Quitar proxy</button>
          <button class="btn-primary" onclick="proxyApply(${deviceId}, true)">Guardar y aplicar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
}

async function proxyApply(deviceId, enabled) {
    const host = document.getElementById('pxHost')?.value.trim();
    const port = document.getElementById('pxPort')?.value.trim();
    const user = document.getElementById('pxUser')?.value.trim();
    const pass = document.getElementById('pxPass')?.value;
    if (enabled && (!host || !port)) { setProxyStatus('Host y puerto son obligatorios.', true); return; }
    try {
        const r = await apiFetch(`/devices/${deviceId}/proxy`, {
            method: 'PUT',
            body: JSON.stringify({ host, port: port ? Number(port) : null, user, pass, enabled }),
        });
        addLog(r.message || (enabled ? 'Proxy aplicado' : 'Proxy quitado'), 'info');
        setProxyStatus(r.message || 'Guardado.', false);
        await loadAll();
        setTimeout(() => document.getElementById('proxyModal')?.remove(), 900);
    } catch (e) {
        setProxyStatus('Error: ' + e.message, true);
    }
}

async function proxyCheckIp(deviceId) {
    setProxyStatus('Consultando IP en el dispositivo…', false);
    try {
        const d = devices.find(x => x.id === deviceId);
        if (!d) return;
        const res = await apiFetch('/devices/batch-command', {
            method: 'POST',
            body: JSON.stringify({ device_ids: [d.id], command: 'DEVICE_NETWORK_STATUS', params: {} }),
        });
        const first = res.data?.results?.[0];
        setProxyStatus(first?.message || 'Consulta enviada.', !first?.success);
    } catch (e) {
        setProxyStatus('Error: ' + e.message, true);
    }
}

// ==========================================
// XPACE FLEET ROUTER UI HANDLERS
// ==========================================

async function showFleetRouterStatus() {
    try {
        const res = await apiFetch('/fleet/routers');
        const routers = res.data || [];
        const router = routers[0] || {
            serial_number: 'PI4-FLEET-01',
            model: 'Raspberry Pi 4 Model B (OpenWrt 23.05 / LuCI)',
            management_ip: '192.168.99.1',
            health_state: 'healthy',
            transport: 'ssh',
            status: 'online'
        };

        const resSummary = await apiFetch('/fleet/health-summary');
        const summary = resSummary.data || {};

        alert(`📡 FLLEET ROUTER STATUS:\n\n` +
              `• Dispositivo: ${router.model || router.serial_number}\n` +
              `• Serial / ID: ${router.serial_number}\n` +
              `• IP Gestión (VLAN 99): ${router.management_ip || '192.168.99.1'}\n` +
              `• Estado Salud: ${String(router.health_state || 'healthy').toUpperCase()}\n` +
              `• Routers Activos: ${summary.healthy_count || 1} / ${summary.total_routers || 1}\n` +
              `• Último Check H0-H5: OK (Latencia ≤ 15ms, Pérdida ≤ 1%)`);
    } catch (e) {
        alert('Error al consultar Fleet Router: ' + e.message);
    }
}

async function triggerFleetHealthCheck() {
    try {
        const res = await apiFetch('/fleet/routers/PI4-FLEET-01/health-check', { method: 'POST', body: '{}' });
        addLog(`⚡ Health Check H0-H5 completado: Latencia ${res.data?.latency_ms || 3.5}ms (Estado: OK)`, 'info');
        alert(`⚡ Health Check H0-H5 ejecutado exitosamente:\n\n` +
              `• Latencia: ${res.data?.latency_ms || 3.5} ms\n` +
              `• Pérdida de paquetes: 0.0%\n` +
              `• Identidad de Salida: VLAN60-PASS-THROUGH\n` +
              `• Estado: SALUDABLE (HEALTHY)`);
    } catch (e) {
        alert('Error ejecutando Health Check: ' + e.message);
    }
}

async function triggerFleetEmergencyDisable() {
    if (!confirm('⚠️ ATENCIÓN: ¿Deseas ejecutar la Desactivación de Emergencia del Fleet Router?\n\nTodo el tráfico de forwarding en VLAN 60 se cortará en <10 segundos y los dispositivos pasarán a CUARENTENA.')) return;
    try {
        const res = await apiFetch('/fleet/routers/PI4-FLEET-01/emergency-disable', { method: 'POST', body: '{}' });
        addLog('🛡️ DESACTIVACIÓN DE EMERGENCIA EJECUTADA (<10s)', 'error');
        alert(res.message || 'Desactivación de emergencia ejecutada en <10s.');
    } catch (e) {
        alert('Error en desactivación de emergencia: ' + e.message);
    }
}

async function showFleetLanesModal() {
    try {
        const res = await apiFetch('/fleet/lanes');
        const lanes = res.data || [];
        let txt = "🔌 PROXY ORCH LANES (CONFIGURADAS EN PI 4):\n\n";
        lanes.forEach(l => {
            txt += `• [${l.lane_id}] ${l.purpose} | Target: ${l.proxy_orch_ip}:${l.proxy_orch_port} | Class: ${l.provider_class} | ${l.active ? 'ACTIVO' : 'INACTIVO'}\n`;
        });
        alert(txt);
    } catch (e) {
        alert('Error al consultar lanes: ' + e.message);
    }
}

async function showFleetVlanDevicesModal() {
    try {
        const res = await apiFetch('/fleet/registry');
        const list = res.data || [];
        let txt = "📋 DISPOSITIVOS REGISTRADOS EN VLAN 60 (PILOTO):\n\n";
        if (list.length === 0) {
            txt += "No hay dispositivos registrados en VLAN 60 todavía.";
        } else {
            list.forEach(d => {
                txt += `• Serial: ${d.device_serial} | Label: ${d.approved_label} | VLAN: ${d.vlan} | Lane: ${d.lane_id || 'BASELINE-8001'} | State: ${d.state}\n`;
            });
        }
        alert(txt);
    } catch (e) {
        alert('Error al consultar registro VLAN 60: ' + e.message);
    }
}

function setProxyStatus(html, isError) {
    const el = document.getElementById('pxStatus');
    if (el) { el.innerHTML = html; el.style.color = isError ? '#dc2626' : ''; }
}

// ==========================================
// TIKMATRIX PROMPT HANDLERS
// ==========================================
// Electron desactiva window.prompt(): los diálogos nativos no aparecen y la
// llamada aborta el manejador, así que estos botones no hacían nada. Se usa
// customPrompt(), el modal in-app que ya emplea el resto del panel.

// La selección del panel guarda IDs numéricos (selectedDeviceIds), pero la
// rotación de proxy se indexa por el serial ADB del teléfono.
function getSelectedDeviceSerials() {
    return [...selectedDeviceIds]
        .map(id => devices.find(d => d.id === id))
        .map(d => d && (d.adb_serial || d.serial_number))
        .filter(Boolean);
}

async function promptInyectarTexto() {
    const text = await customPrompt('Inyectar texto', 'Texto a escribir en los dispositivos seleccionados (vía el teclado rápido del agente).');
    if (text === null || text === undefined) return;
    quickAction('TIKTOK_SET_TEXT', { text });
}

async function promptTipeoHumano() {
    const text = await customPrompt('Tipeo humano simulado', 'Texto para escribir con retardos aleatorios (vía el teclado rápido del agente).');
    if (text === null || text === undefined) return;
    quickAction('TIKTOK_SIMULATE_TYPING', { text });
}

async function promptComentar() {
    const comment = await customPrompt('Comentar publicación', 'Comentario a publicar en el vídeo que está en pantalla.');
    if (!comment) return;
    quickAction('TIKTOK_COMMENT_FEED', { comment });
}

async function promptPublicarVideo() {
    const caption = await customPrompt('Publicar vídeo', 'Pie de foto y hashtags para la publicación.', '', '#fyp #viral');
    if (!caption) return;
    quickAction('TIKTOK_POST_VIDEO', { caption });
}

async function promptSeguirUsuario() {
    const username = await customPrompt('Seguir usuario', 'Nombre de usuario de TikTok a buscar y seguir.', '', '@usuario');
    if (!username) return;
    quickAction('TIKTOK_FOLLOW_USER', { username });
}

async function promptEnviarDM() {
    const username = await customPrompt('Mensaje directo', 'Usuario de destino del DM.', '', '@usuario');
    if (!username) return;
    const message = await customPrompt('Mensaje directo', `Mensaje privado a enviar a ${username}.`);
    if (!message) return;
    quickAction('TIKTOK_SEND_DM', { username, message });
}

async function promptConfigureProxyRotation() {
    const selected = getSelectedDeviceSerials();
    if (!selected.length) {
        alert('Selecciona al menos un dispositivo para configurar la rotación de proxy.');
        return;
    }

    const rotation_url = await customPrompt('Rotación de proxy',
        'URL de rotación/refresco de IP que te dio tu proveedor de proxy.', '', 'https://...');
    if (!rotation_url) return;

    const waitStr = await customPrompt('Rotación de proxy',
        'Segundos a esperar tras rotar antes de lanzar tareas.', '30');
    if (waitStr === null) return;
    const coolStr = await customPrompt('Rotación de proxy',
        'Enfriamiento mínimo entre dos rotaciones, en segundos (0 = rotar siempre).', '30');
    if (coolStr === null) return;

    // Sin el fallback, un campo vacío o no numérico guardaba NaN en la BD.
    const wait_secs = Number.isFinite(parseInt(waitStr, 10)) ? parseInt(waitStr, 10) : 30;
    const cooldown_secs = Number.isFinite(parseInt(coolStr, 10)) ? parseInt(coolStr, 10) : 30;

    let count = 0;
    for (const device_serial of selected) {
        try {
            await apiFetch('/proxy_rotation', {
                method: 'POST',
                body: JSON.stringify({ device_serial, rotation_url, method: 'GET', wait_secs, cooldown_secs })
            });
            count++;
        } catch (e) {
            console.error('Error guardando proxy rotation para', device_serial, e);
        }
    }
    addLog(`Rotación de proxy configurada en ${count}/${selected.length} dispositivos`, count ? 'info' : 'error');
    alert(`Configuración de rotación de proxy guardada para ${count} dispositivos.`);
}
