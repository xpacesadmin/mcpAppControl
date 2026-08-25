// ============================================================
// MCP CONTROL BSOLUTIONS · CONSTRUCTOR DE RUTINAS + PROGRAMACIÓN
// Módulo independiente (no toca dashboard.js). Reutiliza los globales
// apiFetch / extractList / loadAll definidos en dashboard.js.
// ============================================================
(function () {
  'use strict';

  // Catálogo de pasos disponibles (mapea 1:1 con los comandos que ejecuta el
  // módulo ADB / el agente). Cada campo se convierte en un input del editor.
  const STEP_CATALOG = [
    { type: 'OPEN_APP',        label: 'Abrir app',            icon: '📱', fields: [{ key: 'package_name', label: 'Paquete', ph: 'com.spotify.music' }] },
    { type: 'GOTO_URL',        label: 'Abrir enlace / URL',   icon: '🔗', fields: [{ key: 'url', label: 'URL', ph: 'https://...' }] },
    { type: 'OPEN_WEB_SEARCH', label: 'Buscar en Google',      icon: '🔎', fields: [{ key: 'query', label: 'Tema / consulta', ph: '{{search_topic}}' }] },
    { type: 'CAPTURE_FOREGROUND_APP', label: 'Recordar app actual', icon: '📌', fields: [] },
    { type: 'RESTORE_FOREGROUND_APP', label: 'Volver a app original', icon: '↪️', fields: [] },
    { type: 'REPEAT_SCROLL',   label: 'Repetir scroll',         icon: '↕️', fields: [{ key: 'direction', label: 'Dirección', type: 'select', options: ['down', 'up'], def: 'down' }, { key: 'count', label: 'Cantidad', ph: '{{scroll_count}}' }, { key: 'pause_ms', label: 'Pausa entre scrolls (ms)', type: 'number', def: 800 }] },
    { type: 'CLICK_FIRST_ACTIONABLE', label: 'Primer elemento accionable', icon: '🎯', fields: [{ key: 'min_y', label: 'Y mínima', type: 'number', def: 300 }, { key: 'max_y', label: 'Y máxima', type: 'number', def: 2000 }, { key: 'exclude_text', label: 'Excluir textos (separados por coma)', ph: 'Search,Home,Shorts' }] },
    { type: 'WAIT',            label: 'Esperar',              icon: '⏱️', fields: [{ key: 'duration', label: 'Milisegundos', type: 'number', def: 2000 }] },
    { type: 'SCROLL',          label: 'Scroll',               icon: '↕️', fields: [{ key: 'direction', label: 'Dirección', type: 'select', options: ['down', 'up'], def: 'down' }] },
    { type: 'SWIPE',           label: 'Deslizar (swipe)',     icon: '👉', fields: [{ key: 'start_x', label: 'X inicio', type: 'number', def: 500 }, { key: 'start_y', label: 'Y inicio', type: 'number', def: 1500 }, { key: 'end_x', label: 'X fin', type: 'number', def: 500 }, { key: 'end_y', label: 'Y fin', type: 'number', def: 400 }] },
    { type: 'CLICK_BY_TEXT',   label: 'Tocar por texto',      icon: '🔤', fields: [{ key: 'text', label: 'Texto visible', ph: 'Buscar' }] },
    { type: 'CLICK_BY_ID',     label: 'Tocar por ID',         icon: '🆔', fields: [{ key: 'resource_id', label: 'resource-id' }] },
    { type: 'TAP_XY',          label: 'Tocar coordenada',     icon: '🎯', fields: [{ key: 'x', label: 'X', type: 'number' }, { key: 'y', label: 'Y', type: 'number' }] },
    { type: 'SET_TEXT',        label: 'Escribir en campo',    icon: '✍️', fields: [{ key: 'resource_id', label: 'Campo id (opcional)' }, { key: 'value', label: 'Texto' }] },
    { type: 'TYPE_TEXT',       label: 'Teclear texto',        icon: '⌨️', fields: [{ key: 'value', label: 'Texto' }] },
    { type: 'WAIT_FOR_ELEMENT',label: 'Esperar elemento',     icon: '🕵️', fields: [{ key: 'text', label: 'Texto a esperar' }, { key: 'timeout_ms', label: 'Timeout ms', type: 'number', def: 10000 }] },
    { type: 'PLAY_MEDIA',      label: 'Reproducir (esperar)', icon: '▶️', fields: [{ key: 'duration_seconds', label: 'Segundos', type: 'number', def: 30 }] },
    { type: 'PRESS_BACK',      label: 'Botón Atrás',          icon: '↩️', fields: [] },
    { type: 'PRESS_HOME',      label: 'Botón Inicio',         icon: '🏠', fields: [] },
    { type: 'INPUT_KEYEVENT',  label: 'Tecla (keyevent)',     icon: '🔘', fields: [{ key: 'keycode', label: 'Keycode', type: 'number', def: 4 }] },
    { type: 'FORCE_STOP',      label: 'Cerrar app',           icon: '🚪', fields: [{ key: 'package_name', label: 'Paquete' }] },
    { type: 'CAPTURE_SCREEN',  label: 'Captura de pantalla',  icon: '📸', fields: [] },
    { type: 'CHECK_BAN',       label: 'Comprobar baneo/captcha', icon: '🛡️', fields: [] },
    { type: 'USE_ACCOUNT',     label: 'Usar/activar cuenta',  icon: '👤', fields: [{ key: 'platform', label: 'Plataforma (opcional)', ph: 'instagram' }] },
    { type: 'ROTATE_ACCOUNT',  label: 'Rotar a otra cuenta',  icon: '🔄', fields: [{ key: 'platform', label: 'Plataforma (opcional)', ph: 'instagram' }] },
    { type: 'ASSIGN_PROXY',    label: 'Asignar proxy del pool', icon: '🌐', fields: [{ key: 'strategy', label: 'Estrategia', type: 'select', options: ['round_robin', 'random'], def: 'round_robin' }, { key: 'country', label: 'País (opcional)', ph: 'DO, US, ES...' }, { key: 'tags', label: 'Etiquetas (opcional)', ph: 'residencial,móvil' }] },
    { type: 'ROTATE_PROXY',    label: 'Rotar proxy',           icon: '🔁', fields: [{ key: 'strategy', label: 'Estrategia', type: 'select', options: ['round_robin', 'random'], def: 'round_robin' }, { key: 'country', label: 'País (opcional)', ph: 'DO, US, ES...' }, { key: 'tags', label: 'Etiquetas (opcional)', ph: 'residencial,móvil' }] },
    { type: 'CLEAR_PROXY',     label: 'Quitar proxy',          icon: '🚫', fields: [] },
    { type: 'CHECK_IP',        label: 'Comprobar IP de salida', icon: '🔎', fields: [] },
    { type: 'DEVICE_NETWORK_STATUS', label: 'Diagnóstico de red y proxy', icon: '📡', fields: [] },
    { type: 'DEVICE_STABILIZE', label: 'Estabilizar dispositivo ADB', icon: '🧰', fields: [
      { key: 'keep_awake', label: 'Mantener pantalla encendida', type: 'select', options: ['true', 'false'], def: 'true' },
      { key: 'screen_timeout_minutes', label: 'Apagar pantalla (min)', type: 'number', def: 30 },
      { key: 'animation_scale', label: 'Escala de animaciones', type: 'select', options: ['0', '0.5', '1'], def: '0' },
      { key: 'sync_time', label: 'Hora automática de red', type: 'select', options: ['false', 'true'], def: 'false' },
      { key: 'timezone', label: 'Zona horaria (opcional)', ph: 'America/Chicago' },
    ] },
    { type: 'WAIT_FOR_TEXT',   label: 'Esperar texto en pantalla', icon: '👁️', fields: [{ key: 'text', label: 'Texto' }, { key: 'timeout_ms', label: 'Timeout ms', type: 'number', def: 15000 }] },
    { type: 'ASSERT_TEXT',     label: 'Comprobar texto',      icon: '✔️', fields: [{ key: 'text', label: 'Texto esperado' }] },
    { type: 'DEVICE_HEALTH',   label: 'Leer salud (batería/temp)', icon: '🔋', fields: [] },
    { type: 'KEEP_AWAKE',      label: 'Mantener despierto',    icon: '☕', fields: [] },
    { type: 'SET_TIME_AUTO',   label: 'Hora automática (estabilizar)', icon: '🕐', fields: [] },
    { type: 'SET_TIMEZONE',    label: 'Fijar zona horaria',    icon: '🌍', fields: [{ key: 'timezone', label: 'Zona (ej. America/New_York)', ph: 'America/New_York' }] },
  ];

  // Plantillas de rutina listas por red social (nº5). Cada una crea una rutina activa.
  const TEMPLATES = [
    { name: 'General · búsqueda web + YouTube + retorno', platform: 'general', parameter_schema: [
      { name: 'search_topic', label: 'Tema de búsqueda', type: 'string', required: true, default: '' },
      { name: 'scroll_count', label: 'Cantidad de scrolls', type: 'number', required: true, default: 3, min: 1, max: 20 },
      { name: 'watch_seconds', label: 'Segundos por video', type: 'number', required: true, default: 300, min: 10, max: 600 },
    ], steps: [
      { type: 'CAPTURE_FOREGROUND_APP' },
      { type: 'PRESS_HOME' },
      { type: 'OPEN_WEB_SEARCH', query: '{{search_topic}}' },
      { type: 'WAIT', duration: 4000 },
      { type: 'CLICK_FIRST_ACTIONABLE', min_y: 350, max_y: 1800, exclude_text: 'Search,Google,More,Sign in' },
      { type: 'WAIT', duration: 3000 },
      { type: 'REPEAT_SCROLL', direction: 'down', count: '{{scroll_count}}', pause_ms: 900 },
      { type: 'PRESS_BACK' },
      { type: 'OPEN_APP', package_name: 'com.google.android.youtube' },
      { type: 'WAIT', duration: 5000 },
      { type: 'CLICK_FIRST_ACTIONABLE', min_y: 300, max_y: 1800, exclude_text: 'Home,Shorts,Subscriptions,You' },
      { type: 'PLAY_MEDIA', duration_seconds: '{{watch_seconds}}' },
      { type: 'INPUT_KEYEVENT', keycode: 87 },
      { type: 'PLAY_MEDIA', duration_seconds: '{{watch_seconds}}' },
      { type: 'FORCE_STOP', package_name: 'com.google.android.youtube' },
      { type: 'RESTORE_FOREGROUND_APP' },
    ] },    { name: 'Instagram · scroll + like', platform: 'instagram', steps: [
      { type: 'OPEN_APP', package_name: 'com.instagram.android' }, { type: 'WAIT', duration: 4000 },
      { type: 'CHECK_BAN' },
      { type: 'SCROLL', direction: 'down' }, { type: 'WAIT', duration: 3000 },
      { type: 'CLICK_BY_TEXT', text: 'Me gusta' }, { type: 'WAIT', duration: 2000 },
      { type: 'SCROLL', direction: 'down' }, { type: 'WAIT', duration: 3000 },
    ] },
    { name: 'TikTok · ver videos', platform: 'tiktok', steps: [
      { type: 'OPEN_APP', package_name: 'com.zhiliaoapp.musically' }, { type: 'WAIT', duration: 5000 },
      { type: 'CHECK_BAN' },
      { type: 'PLAY_MEDIA', duration_seconds: 20 }, { type: 'SWIPE', start_x: 540, start_y: 1500, end_x: 540, end_y: 400 },
      { type: 'PLAY_MEDIA', duration_seconds: 20 }, { type: 'SWIPE', start_x: 540, start_y: 1500, end_x: 540, end_y: 400 },
      { type: 'PLAY_MEDIA', duration_seconds: 20 },
    ] },
    { name: 'YouTube · buscar + ver', platform: 'youtube', steps: [
      { type: 'OPEN_APP', package_name: 'com.google.android.youtube' }, { type: 'WAIT', duration: 4000 },
      { type: 'CLICK_BY_ID', resource_id: 'com.google.android.youtube:id/menu_item_1' }, { type: 'WAIT', duration: 1500 },
      { type: 'TYPE_TEXT', value: 'lofi hip hop' }, { type: 'INPUT_KEYEVENT', keycode: 66 }, { type: 'WAIT', duration: 3000 },
      { type: 'PLAY_MEDIA', duration_seconds: 60 },
    ] },
    { name: 'Spotify · reproducir', platform: 'spotify', steps: [
      { type: 'OPEN_APP', package_name: 'com.spotify.music' }, { type: 'WAIT', duration: 5000 },
      { type: 'PLAY_MEDIA', duration_seconds: 120 },
    ] },
    { name: 'Login genérico (con cuenta)', platform: '', steps: [
      { type: 'USE_ACCOUNT' }, { type: 'WAIT', duration: 1000 },
      { type: 'SET_TEXT', resource_id: 'username_field', value: '{{account.username}}' }, { type: 'WAIT', duration: 800 },
      { type: 'SET_TEXT', resource_id: 'password_field', value: '{{account.password}}' }, { type: 'WAIT', duration: 800 },
      { type: 'CLICK_BY_TEXT', text: 'Iniciar sesión' }, { type: 'WAIT', duration: 4000 }, { type: 'CHECK_BAN' },
    ] },
    { name: 'Mantenimiento · estabilizar dispositivos', platform: 'adb', steps: [
      { type: 'DEVICE_STABILIZE', keep_awake: 'true', screen_timeout_minutes: 30, animation_scale: '0', sync_time: 'false' },
      { type: 'DEVICE_HEALTH' },
      { type: 'DEVICE_NETWORK_STATUS' },
    ] },
    { name: 'Red · asignar proxy y verificar', platform: 'adb', steps: [
      { type: 'DEVICE_STABILIZE', keep_awake: 'true', screen_timeout_minutes: 30, animation_scale: '0', sync_time: 'false' },
      { type: 'ASSIGN_PROXY', strategy: 'round_robin' },
      { type: 'DEVICE_NETWORK_STATUS' },
      { type: 'CHECK_IP' },
    ] },
    { name: 'Red · limpiar proxy y verificar', platform: 'adb', steps: [
      { type: 'CLEAR_PROXY' },
      { type: 'DEVICE_NETWORK_STATUS' },
      { type: 'CHECK_IP' },
    ] },
  ];
  const catalogOf = (t) => STEP_CATALOG.find(s => s.type === t) || { type: t, label: t, icon: '⚙️', fields: [] };
  const DAYS = [{ v: 1, l: 'Lun' }, { v: 2, l: 'Mar' }, { v: 3, l: 'Mié' }, { v: 4, l: 'Jue' }, { v: 5, l: 'Vie' }, { v: 6, l: 'Sáb' }, { v: 0, l: 'Dom' }];

  let steps = [];              // pasos de la rutina en edición
  let parameters = [];         // parámetros solicitados al ejecutar
  let editingWorkflowId = null;
  let editingScheduleId = null;
  let cacheWorkflows = [], cacheGroups = [], cacheSchedules = [];

  const esc = (t) => { const d = document.createElement('div'); d.textContent = t == null ? '' : String(t); return d.innerHTML; };
  const escA = (t) => esc(t).replace(/"/g, '&quot;');
  const $ = (id) => document.getElementById(id);

  // ---------- Overlay ----------
  function ensureOverlay() {
    if ($('routinesOverlay')) return;
    const el = document.createElement('div');
    el.id = 'routinesOverlay';
    el.className = 'rt-overlay';
    el.hidden = true;
    el.innerHTML = `
      <div class="rt-modal">
        <div class="rt-head">
          <div class="rt-tabs">
            <button class="rt-tab active" data-tab="routines" onclick="rtSwitchTab('routines')">🛠️ Rutinas</button>
            <button class="rt-tab" data-tab="schedules" onclick="rtSwitchTab('schedules')">🗓️ Programación</button>
            <button class="rt-tab" data-tab="accounts" onclick="rtSwitchTab('accounts')">👤 Cuentas</button>
            <button class="rt-tab" data-tab="proxies" onclick="rtSwitchTab('proxies')">🌐 Proxies</button>
            <button class="rt-tab" data-tab="hermes" onclick="rtSwitchTab('hermes')">🤖 Hermes</button>
          </div>
          <button class="rt-close" onclick="rtClose()">✕</button>
        </div>
        <div class="rt-body">
          <div id="rtPane-routines" class="rt-pane">
            <div class="rt-col rt-list-col">
              <div class="rt-col-head"><span>Rutinas</span><button class="rt-btn primary" onclick="rtNewRoutine()">+ Nueva</button></div>
              <div class="rt-tpl-bar">
                <select id="rtTplPicker" class="rt-mini-select" onchange="rtLoadTemplate(this.value); this.value='';">
                  <option value="">📚 Cargar plantilla…</option>
                </select>
              </div>
              <div id="rtRoutineList" class="rt-list"></div>
            </div>
            <div class="rt-col rt-editor-col">
              <div id="rtRoutineEditor" class="rt-editor"></div>
            </div>
          </div>
          <div id="rtPane-schedules" class="rt-pane" hidden>
            <div class="rt-col rt-list-col">
              <div class="rt-col-head"><span>Horarios</span><button class="rt-btn primary" onclick="rtNewSchedule()">+ Nuevo</button></div>
              <div id="rtScheduleList" class="rt-list"></div>
            </div>
            <div class="rt-col rt-editor-col">
              <div id="rtScheduleEditor" class="rt-editor"></div>
            </div>
          </div>
          <div id="rtPane-accounts" class="rt-pane" hidden>
            <div class="rt-col rt-list-col">
              <div class="rt-col-head"><span>Cuentas</span><span><button class="rt-btn" onclick="rtOpenImport()" title="Pega muchas cuentas de una vez">📥 Importar</button> <button class="rt-btn primary" onclick="rtNewAccount()">+ Nueva</button></span></div>
              <div id="rtAccountList" class="rt-list"></div>
            </div>
            <div class="rt-col rt-editor-col">
              <div id="rtAccountEditor" class="rt-editor"></div>
            </div>
          </div>
          <div id="rtPane-proxies" class="rt-pane" hidden>
            <div class="rt-col rt-list-col">
              <div class="rt-col-head"><span>Pool de proxies</span><button class="rt-btn primary" onclick="rtNewProxy()">+ Nuevo</button></div>
              <div id="rtProxyList" class="rt-list"></div>
            </div>
            <div class="rt-col rt-editor-col">
              <div id="rtProxyEditor" class="rt-editor"></div>
            </div>
          </div>
          <div id="rtPane-hermes" class="rt-pane rt-hermes-pane" hidden>
            <div id="rtHermesContent" class="rt-hermes-content"></div>
          </div>
        </div>
      </div>`;
    el.onclick = (e) => { if (e.target === el) rtClose(); };
    document.body.appendChild(el);
  }

  // ---------- API pública ----------
  window.openRoutineBuilder = async function () {
    ensureOverlay();
    $('routinesOverlay').hidden = false;
    rtSwitchTab('routines');
    fillTemplatePicker();
    await refreshData();
    renderRoutineList();
    renderRoutineEditor();
  };
  window.openHermesSetup = async function () {
    ensureOverlay();
    $('routinesOverlay').hidden = false;
    rtSwitchTab('hermes');
  };
  window.rtClose = () => { const o = $('routinesOverlay'); if (o) o.hidden = true; };
  window.rtSwitchTab = (tab) => {
    document.querySelectorAll('.rt-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('rtPane-routines').hidden = tab !== 'routines';
    $('rtPane-schedules').hidden = tab !== 'schedules';
    $('rtPane-accounts').hidden = tab !== 'accounts';
    $('rtPane-proxies').hidden = tab !== 'proxies';
    $('rtPane-hermes').hidden = tab !== 'hermes';
    if (tab === 'schedules') { renderScheduleList(); renderScheduleEditor(); }
    if (tab === 'accounts') { refreshAccounts().then(() => { renderAccountList(); renderAccountEditor(); }); }
    if (tab === 'proxies') { refreshProxies().then(() => { renderProxyList(); renderProxyEditor(); }); }
    if (tab === 'hermes') renderHermesPane();
  };

  async function refreshData() {
    try { cacheWorkflows = extractList(await apiFetch('/workflows?per_page=100')); } catch (e) { cacheWorkflows = []; }
    try { cacheGroups = extractList(await apiFetch('/groups')); } catch (e) { cacheGroups = []; }
    try { cacheSchedules = extractList(await apiFetch('/schedules?per_page=100')); } catch (e) { cacheSchedules = []; }
  }

  // ============================================================
  // RUTINAS
  // ============================================================
  function renderRoutineList() {
    const box = $('rtRoutineList'); if (!box) return;
    if (!cacheWorkflows.length) { box.innerHTML = '<p class="rt-empty">Sin rutinas. Crea una nueva.</p>'; return; }
    box.innerHTML = cacheWorkflows.map(w => `
      <div class="rt-list-item ${editingWorkflowId === w.id ? 'active' : ''}" onclick="rtEditRoutine(${w.id})">
        <div class="rt-item-name">${esc(w.name)}</div>
        <div class="rt-item-sub">${(Array.isArray(w.steps) ? w.steps.length : 0) || '?'} pasos · ${w.status === 'active' ? '<span class="rt-on">activa</span>' : 'borrador'}</div>
      </div>`).join('');
  }

  window.rtNewRoutine = () => { editingWorkflowId = null; steps = []; parameters = []; renderRoutineEditor(); renderRoutineList(); fillTemplatePicker(); };

  function fillTemplatePicker() {
    const sel = $('rtTplPicker'); if (!sel || sel.options.length > 1) return;
    TEMPLATES.forEach((t, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = '📚 ' + t.name; sel.appendChild(o); });
  }
  window.rtLoadTemplate = (idx) => {
    if (idx === '' || idx == null) return;
    const t = TEMPLATES[Number(idx)]; if (!t) return;
    editingWorkflowId = null;
    steps = JSON.parse(JSON.stringify(t.steps));
    parameters = JSON.parse(JSON.stringify(t.parameter_schema || []));
    renderRoutineEditor({ name: t.name, description: 'Plantilla ' + (t.platform || '') });
    renderRoutineList();
  };

  window.rtEditRoutine = async (id) => {
    try {
      const res = await apiFetch('/workflows/' + id);
      const wf = res.data;
      editingWorkflowId = wf.id;
      steps = Array.isArray(wf.steps) ? wf.steps.map(normalizeStep) : [];
      parameters = Array.isArray(wf.parameter_schema) ? JSON.parse(JSON.stringify(wf.parameter_schema)) : [];
      renderRoutineEditor(wf);
      renderRoutineList();
    } catch (e) { alert('No se pudo cargar la rutina: ' + e.message); }
  };
  const normalizeStep = (s) => ({ type: s.type, ...s });

  function renderRoutineEditor(wf) {
    const box = $('rtRoutineEditor'); if (!box) return;
    const name = wf ? wf.name : '';
    const desc = wf ? (wf.description || '') : '';
    box.innerHTML = `
      <div class="rt-field"><label>Nombre de la rutina</label><input id="rtName" type="text" value="${escA(name)}" placeholder="p. ej. Sesión Spotify mañana"></div>
      <div class="rt-field"><label>Descripción (opcional)</label><input id="rtDesc" type="text" value="${escA(desc)}" placeholder="Qué hace esta rutina"></div>
      <div class="rt-steps-head">
        <span>Parámetros al ejecutar (${parameters.length})</span>
        <button class="rt-btn" onclick="rtAddParam()">+ Parámetro</button>
      </div>
      <div id="rtParamsList" class="rt-steps"></div>
      <div class="rt-steps-head">
        <span>Pasos (${steps.length})</span>
        <select id="rtStepPicker" class="rt-mini-select">
          <option value="">+ Añadir paso…</option>
          ${STEP_CATALOG.map(s => `<option value="${s.type}">${s.icon} ${esc(s.label)}</option>`).join('')}
        </select>
      </div>
      <div id="rtStepsList" class="rt-steps"></div>
      <div class="rt-editor-actions">
        <button class="rt-btn" onclick="rtRunRoutine()" ${editingWorkflowId ? '' : 'disabled'} title="Ejecuta ya en todos los dispositivos conectados">▶️ Ejecutar ahora</button>
        <button class="rt-btn danger" onclick="rtDeleteRoutine()" ${editingWorkflowId ? '' : 'disabled'}>🗑️ Borrar</button>
        <button class="rt-btn primary" onclick="rtSaveRoutine()">💾 Guardar rutina</button>
      </div>
      <div id="rtRoutineMsg" class="rt-msg"></div>`;
    renderParams();
    $('rtStepPicker').onchange = (e) => { if (e.target.value) { addStep(e.target.value); e.target.value = ''; } };
    renderSteps();
  }

  function renderParams() {
    const box = $('rtParamsList'); if (!box) return;
    if (!parameters.length) { box.innerHTML = '<p class="rt-empty">Sin parámetros. Puedes usar valores fijos en los pasos.</p>'; return; }
    box.innerHTML = parameters.map((param, index) => `
      <div class="rt-step">
        <div class="rt-step-top"><span class="rt-step-idx">${index + 1}</span><span class="rt-step-title">⚙️ ${esc(param.label || param.name || 'Parámetro')}</span><button class="del" onclick="rtDelParam(${index})">✕</button></div>
        <div class="rt-step-fields">
          <label class="rt-sf">Nombre<input value="${escA(param.name || '')}" placeholder="search_topic" oninput="rtSetParam(${index},'name',this.value)"></label>
          <label class="rt-sf">Etiqueta<input value="${escA(param.label || '')}" placeholder="Tema de búsqueda" oninput="rtSetParam(${index},'label',this.value)"></label>
          <label class="rt-sf">Tipo<select onchange="rtSetParam(${index},'type',this.value)"><option value="string" ${param.type !== 'number' && param.type !== 'boolean' ? 'selected' : ''}>Texto</option><option value="number" ${param.type === 'number' ? 'selected' : ''}>Número</option><option value="boolean" ${param.type === 'boolean' ? 'selected' : ''}>Sí/No</option></select></label>
          <label class="rt-sf">Valor predeterminado<input value="${escA(param.default ?? '')}" oninput="rtSetParam(${index},'default',this.value)"></label>
          <label class="rt-sf">Obligatorio<select onchange="rtSetParam(${index},'required',this.value === 'true')"><option value="true" ${param.required ? 'selected' : ''}>Sí</option><option value="false" ${param.required ? '' : 'selected'}>No</option></select></label>
        </div>
      </div>`).join('');
  }
  window.rtAddParam = () => { parameters.push({ name: '', label: '', type: 'string', required: true, default: '' }); renderParams(); };
  window.rtSetParam = (index, key, value) => { if (parameters[index]) parameters[index][key] = value; };
  window.rtDelParam = (index) => { parameters.splice(index, 1); renderParams(); };

  function cleanParameters() {
    return parameters.map(param => {
      const output = { ...param, name: String(param.name || '').trim(), label: String(param.label || '').trim() };
      if (output.type === 'number' && output.default !== '') output.default = Number(output.default);
      if (!output.label) output.label = output.name;
      return output;
    }).filter(param => /^[A-Za-z][A-Za-z0-9_]*$/.test(param.name));
  }

  function addStep(type) {
    const cat = catalogOf(type);
    const step = { type };
    cat.fields.forEach(f => { if (f.def !== undefined) step[f.key] = f.def; });
    steps.push(step);
    renderSteps();
    updateStepCount();
  }
  const updateStepCount = () => { const head = $('rtStepPicker') && $('rtStepPicker').closest('.rt-steps-head'); const h = head && head.querySelector('span'); if (h) h.textContent = `Pasos (${steps.length})`; };

  function renderSteps() {
    const box = $('rtStepsList'); if (!box) return;
    if (!steps.length) { box.innerHTML = '<p class="rt-empty">Añade pasos con el desplegable de arriba.</p>'; return; }
    box.innerHTML = steps.map((st, i) => {
      const cat = catalogOf(st.type);
      const fields = cat.fields.map(f => {
        const val = st[f.key] !== undefined ? st[f.key] : '';
        if (f.type === 'select') {
          return `<label class="rt-sf">${esc(f.label || f.key)}
            <select onchange="rtSetField(${i},'${f.key}',this.value)">
              ${f.options.map(o => `<option value="${o}" ${String(val) === o ? 'selected' : ''}>${o}</option>`).join('')}
            </select></label>`;
        }
        return `<label class="rt-sf">${esc(f.label || f.key)}
          <input type="${f.type === 'number' && !String(val).includes('{{') ? 'number' : 'text'}" value="${escA(val)}" placeholder="${escA(f.ph || '')}" oninput="rtSetField(${i},'${f.key}',this.value)"></label>`;
      }).join('');
      return `
      <div class="rt-step">
        <div class="rt-step-top">
          <span class="rt-step-idx">${i + 1}</span>
          <span class="rt-step-title">${cat.icon} ${esc(cat.label)}</span>
          <span class="rt-step-btns">
            <button onclick="rtMoveStep(${i},-1)" ${i === 0 ? 'disabled' : ''} title="Subir">▲</button>
            <button onclick="rtMoveStep(${i},1)" ${i === steps.length - 1 ? 'disabled' : ''} title="Bajar">▼</button>
            <button onclick="rtDupStep(${i})" title="Duplicar">⧉</button>
            <button class="del" onclick="rtDelStep(${i})" title="Eliminar">✕</button>
          </span>
        </div>
        ${fields ? `<div class="rt-step-fields">${fields}</div>` : ''}
      </div>`;
    }).join('');
  }

  window.rtSetField = (i, key, val) => { if (steps[i]) steps[i][key] = val; };
  window.rtMoveStep = (i, dir) => { const j = i + dir; if (j < 0 || j >= steps.length) return; [steps[i], steps[j]] = [steps[j], steps[i]]; renderSteps(); };
  window.rtDupStep = (i) => { steps.splice(i + 1, 0, JSON.parse(JSON.stringify(steps[i]))); renderSteps(); updateStepCount(); };
  window.rtDelStep = (i) => { steps.splice(i, 1); renderSteps(); updateStepCount(); };

  function cleanSteps() {
    // convierte números y descarta strings vacíos
    return steps.map(st => {
      const cat = catalogOf(st.type);
      const out = { type: st.type };
      cat.fields.forEach(f => {
        let v = st[f.key];
        if (v === undefined || v === '') return;
        if (f.type === 'number' && !/^\\{\\{(?:params\\.)?[A-Za-z][A-Za-z0-9_]*\\}\\}$/.test(String(v))) v = Number(v);
        out[f.key] = v;
      });
      return out;
    });
  }

  window.rtSaveRoutine = async () => {
    const name = $('rtName').value.trim();
    const description = $('rtDesc').value.trim();
    const msg = $('rtRoutineMsg');
    if (!name) { msg.textContent = 'Ponle un nombre a la rutina.'; msg.className = 'rt-msg err'; return; }
    if (!steps.length) { msg.textContent = 'Añade al menos un paso.'; msg.className = 'rt-msg err'; return; }
    const selectedIds = typeof selectedDeviceIds !== 'undefined' ? [...selectedDeviceIds] : [];
    const payload = { name, description, steps: cleanSteps(), parameter_schema: cleanParameters() };
    if (selectedIds.length) payload.device_ids = selectedIds;
    try {
      let wf;
      if (editingWorkflowId) {
        const r = await apiFetch('/workflows/' + editingWorkflowId, { method: 'PUT', body: JSON.stringify({ ...payload, status: 'active' }) });
        wf = r.data;
      } else {
        const r = await apiFetch('/workflows', { method: 'POST', body: JSON.stringify(payload) });
        wf = r.data;
        // activar para que sea programable/ejecutable
        await apiFetch('/workflows/' + wf.id, { method: 'PUT', body: JSON.stringify({ status: 'active' }) });
        editingWorkflowId = wf.id;
      }
      msg.textContent = '✔ Guardada y activada.'; msg.className = 'rt-msg ok';
      await refreshData(); renderRoutineList(); renderRoutineEditor(wf);
      if (typeof loadAll === 'function') loadAll();
    } catch (e) { msg.textContent = 'Error: ' + e.message; msg.className = 'rt-msg err'; }
  };

  window.rtDeleteRoutine = async () => {
    if (!editingWorkflowId) return;
    if (!confirm('¿Borrar esta rutina?')) return;
    try {
      await apiFetch('/workflows/' + editingWorkflowId, { method: 'DELETE' });
      editingWorkflowId = null; steps = []; parameters = [];
      await refreshData(); renderRoutineList(); renderRoutineEditor();
    } catch (e) { alert('Error: ' + e.message); }
  };

  window.rtRunRoutine = async () => {
    if (!editingWorkflowId) return;
    const msg = $('rtRoutineMsg');
    try {
      const selectedIds = typeof selectedDeviceIds !== 'undefined' ? [...selectedDeviceIds] : [];
      if (!selectedIds.length) throw new Error('Selecciona explícitamente uno o más dispositivos.');
      const runParams = {};
      for (const param of cleanParameters()) {
        const answer = prompt(param.label || param.name, param.default ?? '');
        if (answer === null) throw new Error('Ejecución cancelada por el operador.');
        if (param.required && answer.trim() === '') throw new Error(`${param.label || param.name} es obligatorio.`);
        runParams[param.name] = param.type === 'number' ? Number(answer) : (param.type === 'boolean' ? /^(1|true|yes|sí|si)$/i.test(answer) : answer);
      }
      const body = { device_ids: selectedIds, params: runParams };
      const r = await apiFetch('/workflows/' + editingWorkflowId + '/execute', { method: 'POST', body: JSON.stringify(body) });
      msg.textContent = '▶️ ' + (r.message || 'Lanzada'); msg.className = 'rt-msg ok';
    } catch (e) { msg.textContent = 'Error al ejecutar: ' + e.message; msg.className = 'rt-msg err'; }
  };

  // ============================================================
  // PROGRAMACIÓN (HORARIOS)
  // ============================================================
  function renderScheduleList() {
    const box = $('rtScheduleList'); if (!box) return;
    if (!cacheSchedules.length) { box.innerHTML = '<p class="rt-empty">Sin horarios. Crea uno nuevo.</p>'; return; }
    box.innerHTML = cacheSchedules.map(s => `
      <div class="rt-list-item ${editingScheduleId === s.id ? 'active' : ''}" onclick="rtEditSchedule(${s.id})">
        <div class="rt-item-name">${esc(s.name)} ${s.is_active ? '<span class="rt-on">●</span>' : '<span class="rt-off">●</span>'}</div>
        <div class="rt-item-sub">${esc(s.workflow_name || 'rutina ?')} · ${s.mode === 'fixed_times' ? 'horas fijas' : 'bucle'}</div>
      </div>`).join('');
  }

  window.rtNewSchedule = () => { editingScheduleId = null; renderScheduleEditor(); renderScheduleList(); };

  window.rtEditSchedule = async (id) => {
    try {
      const res = await apiFetch('/schedules/' + id);
      editingScheduleId = id;
      renderScheduleEditor(res.data);
      renderScheduleList();
    } catch (e) { alert('Error: ' + e.message); }
  };

  function renderScheduleEditor(s) {
    const box = $('rtScheduleEditor'); if (!box) return;
    s = s || {};
    const mode = s.mode || 'fixed_times';
    const times = Array.isArray(s.times) ? s.times : [];
    const days = Array.isArray(s.days_of_week) ? s.days_of_week : [];
    box.innerHTML = `
      <div class="rt-field"><label>Nombre del horario</label><input id="rtSName" type="text" value="${escA(s.name || '')}" placeholder="p. ej. Actividad diaria mañana"></div>
      <div class="rt-field"><label>Rutina a ejecutar</label>
        <select id="rtSWorkflow">${cacheWorkflows.map(w => `<option value="${w.id}" ${s.workflow_id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
      </div>
      <div class="rt-field"><label>Grupo de dispositivos</label>
        <select id="rtSGroup">
          <option value="">Todos los dispositivos</option>
          ${cacheGroups.map(g => `<option value="${g.id}" ${s.group_id === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        </select>
      </div>
      <div class="rt-field"><label>Modo</label>
        <div class="rt-radio">
          <label><input type="radio" name="rtMode" value="fixed_times" ${mode === 'fixed_times' ? 'checked' : ''} onchange="rtToggleMode('fixed_times')"> Horas fijas (ej. 09:00, 14:30)</label>
          <label><input type="radio" name="rtMode" value="loop" ${mode === 'loop' ? 'checked' : ''} onchange="rtToggleMode('loop')"> En bucle dentro de una franja</label>
        </div>
      </div>
      <div id="rtModeFixed" class="rt-field" ${mode === 'loop' ? 'hidden' : ''}>
        <label>Horas de ejecución</label>
        <div class="rt-times-add"><input id="rtTimeInput" type="time"><button class="rt-btn" onclick="rtAddTime()">+ Añadir hora</button></div>
        <div id="rtTimesChips" class="rt-chips"></div>
      </div>
      <div id="rtModeLoop" class="rt-field" ${mode === 'fixed_times' ? 'hidden' : ''}>
        <div class="rt-row">
          <label class="rt-half">Desde<input id="rtWinStart" type="time" value="${escA((s.window_start || '09:00').slice(0, 5))}"></label>
          <label class="rt-half">Hasta<input id="rtWinEnd" type="time" value="${escA((s.window_end || '21:00').slice(0, 5))}"></label>
        </div>
        <label>Pausa entre repeticiones (segundos)</label>
        <input id="rtGap" type="number" value="${escA(s.loop_gap_seconds != null ? s.loop_gap_seconds : 300)}" min="0">
      </div>
      <div class="rt-field"><label>Días de la semana</label>
        <div id="rtDays" class="rt-days">
          ${DAYS.map(d => `<label class="rt-day ${days.includes(d.v) ? 'on' : ''}"><input type="checkbox" value="${d.v}" ${days.includes(d.v) ? 'checked' : ''} onchange="this.parentElement.classList.toggle('on',this.checked)"> ${d.l}</label>`).join('')}
        </div>
        <small class="rt-hint">Sin marcar ninguno = todos los días.</small>
      </div>
      <div class="rt-field"><label class="rt-check"><input id="rtSActive" type="checkbox" ${s.is_active === false ? '' : 'checked'}> Horario activo</label></div>
      <div class="rt-editor-actions">
        <button class="rt-btn" onclick="rtRunScheduleNow()" ${editingScheduleId ? '' : 'disabled'}>▶️ Ejecutar ahora</button>
        <button class="rt-btn danger" onclick="rtDeleteSchedule()" ${editingScheduleId ? '' : 'disabled'}>🗑️ Borrar</button>
        <button class="rt-btn primary" onclick="rtSaveSchedule()">💾 Guardar horario</button>
      </div>
      <div id="rtSchedMsg" class="rt-msg"></div>`;
    box._times = times.slice();
    renderTimeChips();
    if (!cacheWorkflows.length) { $('rtSchedMsg').textContent = 'Primero crea una rutina en la pestaña Rutinas.'; $('rtSchedMsg').className = 'rt-msg err'; }
  }

  window.rtToggleMode = (m) => { $('rtModeFixed').hidden = m !== 'fixed_times'; $('rtModeLoop').hidden = m !== 'loop'; };
  window.rtAddTime = () => {
    const v = $('rtTimeInput').value; if (!v) return;
    const box = $('rtScheduleEditor'); box._times = box._times || [];
    if (!box._times.includes(v)) box._times.push(v);
    box._times.sort(); renderTimeChips();
  };
  window.rtRemoveTime = (t) => { const box = $('rtScheduleEditor'); box._times = (box._times || []).filter(x => x !== t); renderTimeChips(); };
  function renderTimeChips() {
    const box = $('rtScheduleEditor'); const chips = $('rtTimesChips'); if (!chips) return;
    const times = box._times || [];
    chips.innerHTML = times.length ? times.map(t => `<span class="rt-chip">${t}<button onclick="rtRemoveTime('${t}')">✕</button></span>`).join('') : '<span class="rt-hint">Añade al menos una hora.</span>';
  }

  function collectDays() { return [...document.querySelectorAll('#rtDays input:checked')].map(c => Number(c.value)); }

  window.rtSaveSchedule = async () => {
    const msg = $('rtSchedMsg');
    const name = $('rtSName').value.trim();
    const workflow_id = Number($('rtSWorkflow').value);
    const groupVal = $('rtSGroup').value;
    const mode = document.querySelector('input[name="rtMode"]:checked').value;
    const box = $('rtScheduleEditor');
    if (!name) { msg.textContent = 'Ponle nombre al horario.'; msg.className = 'rt-msg err'; return; }
    if (!workflow_id) { msg.textContent = 'Elige una rutina.'; msg.className = 'rt-msg err'; return; }
    const payload = {
      name, workflow_id,
      group_id: groupVal ? Number(groupVal) : null,
      mode,
      days_of_week: collectDays(),
      is_active: $('rtSActive').checked,
    };
    if (mode === 'fixed_times') {
      payload.times = box._times || [];
      if (!payload.times.length) { msg.textContent = 'Añade al menos una hora.'; msg.className = 'rt-msg err'; return; }
    } else {
      payload.window_start = $('rtWinStart').value;
      payload.window_end = $('rtWinEnd').value;
      payload.loop_gap_seconds = Number($('rtGap').value) || 0;
    }
    try {
      if (editingScheduleId) {
        await apiFetch('/schedules/' + editingScheduleId, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        const r = await apiFetch('/schedules', { method: 'POST', body: JSON.stringify(payload) });
        editingScheduleId = r.data.id;
      }
      msg.textContent = '✔ Horario guardado.'; msg.className = 'rt-msg ok';
      await refreshData(); renderScheduleList();
    } catch (e) { msg.textContent = 'Error: ' + e.message; msg.className = 'rt-msg err'; }
  };

  window.rtDeleteSchedule = async () => {
    if (!editingScheduleId) return;
    if (!confirm('¿Borrar este horario?')) return;
    try { await apiFetch('/schedules/' + editingScheduleId, { method: 'DELETE' }); editingScheduleId = null; await refreshData(); renderScheduleList(); renderScheduleEditor(); }
    catch (e) { alert('Error: ' + e.message); }
  };

  window.rtRunScheduleNow = async () => {
    if (!editingScheduleId) return;
    const msg = $('rtSchedMsg');
    try { const r = await apiFetch('/schedules/' + editingScheduleId + '/run-now', { method: 'POST', body: JSON.stringify({}) }); msg.textContent = '▶️ ' + (r.message || 'Lanzado'); msg.className = 'rt-msg ok'; }
    catch (e) { msg.textContent = 'Error: ' + e.message; msg.className = 'rt-msg err'; }
  };

  // ============================================================
  // CUENTAS
  // ============================================================
  let cacheAccounts = [], cacheDevices = [], editingAccountId = null;

  async function refreshAccounts() {
    try { cacheAccounts = (await apiFetch('/accounts')).data || []; } catch (e) { cacheAccounts = []; }
    try { cacheDevices = extractList(await apiFetch('/devices?per_page=100')); } catch (e) { cacheDevices = []; }
  }
  const STATUS_LABEL = { unused: 'sin usar', active: 'activa', banned: 'baneada', cooldown: 'enfriando' };

  function renderAccountList() {
    const box = $('rtAccountList'); if (!box) return;
    if (!cacheAccounts.length) { box.innerHTML = '<p class="rt-empty">Sin cuentas. Crea o importa.</p>'; return; }
    box.innerHTML = cacheAccounts.map(a => {
      const dev = cacheDevices.find(d => d.id === a.device_id);
      const verify = { present: '✅ presente', missing: '🚨 ausente', unreachable: '⚠ no alcanzable', unknown: '○ sin verificar' }[a.verification_state || 'unknown'];
      return `<div class="rt-list-item ${editingAccountId === a.id ? 'active' : ''}" onclick="rtEditAccount(${a.id})">
        <div class="rt-item-name">${esc(a.username || a.email || 'cuenta')} <span class="acc-badge s-${esc(a.status)}">${esc(STATUS_LABEL[a.status] || a.status)}</span></div>
        <div class="rt-item-sub">${esc(a.platform || 'sin plataforma')}${dev ? ' · 📱 ' + esc(dev.name || dev.serial_number) : ''}${a.active ? ' · <b>en uso</b>' : ''} · ${verify}</div>
      </div>`;
    }).join('');
  }

  window.rtNewAccount = () => { editingAccountId = null; renderAccountEditor(); renderAccountList(); };

  // ---- Import masivo de cuentas ----
  window.rtOpenImport = () => {
    document.getElementById('rtImportModal')?.remove();
    const ov = document.createElement('div');
    ov.id = 'rtImportModal';
    ov.className = 'rt-overlay';
    ov.style.zIndex = '10002';
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    ov.innerHTML = `
      <div class="rt-modal" style="width:min(560px,94vw);height:auto;max-height:90vh">
        <div class="rt-head"><div class="rt-tabs"><button class="rt-tab active">📥 Importar cuentas</button></div><button class="rt-close" onclick="document.getElementById('rtImportModal').remove()">✕</button></div>
        <div class="rt-editor">
          <div class="rt-field"><label>Plataforma (para todas)</label><input id="impPlatform" type="text" placeholder="instagram, tiktok, youtube…"></div>
          <div class="rt-field"><label>Cuentas (una por línea)</label>
            <textarea id="impText" rows="10" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:8px;font-family:monospace;font-size:12.5px" placeholder="usuario,contraseña,email,secreto_totp&#10;usuario2,contraseña2&#10;usuario3:contraseña3"></textarea>
          </div>
          <p class="rt-hint">Formatos por línea: <code>usuario,clave,email,totp</code> (CSV) o <code>usuario:clave</code>. Email y TOTP son opcionales.</p>
          <div class="rt-editor-actions">
            <button class="rt-btn primary" onclick="rtDoImport()">Importar</button>
          </div>
          <div id="impMsg" class="rt-msg"></div>
        </div>
      </div>`;
    document.body.appendChild(ov);
  };

  function parseAccountsText(text, platform) {
    const rows = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      let parts;
      if (line.includes(',')) parts = line.split(',').map(s => s.trim());
      else if (line.includes(':')) { const i = line.indexOf(':'); parts = [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }
      else parts = [line];
      const [username, password, email, totp_secret] = parts;
      if (!username && !email) continue;
      const acc = { platform: platform || undefined, username };
      if (password) acc.password = password;
      if (email) acc.email = email;
      if (totp_secret) acc.totp_secret = totp_secret;
      rows.push(acc);
    }
    return rows;
  }

  window.rtDoImport = async () => {
    const msg = $('impMsg');
    const platform = $('impPlatform').value.trim();
    const rows = parseAccountsText($('impText').value, platform);
    if (!rows.length) { msg.textContent = 'No hay cuentas válidas que importar.'; msg.className = 'rt-msg err'; return; }
    try {
      const r = await apiFetch('/accounts/import', { method: 'POST', body: JSON.stringify(rows) });
      msg.textContent = `✔ ${r.data?.imported ?? rows.length} cuentas importadas.`; msg.className = 'rt-msg ok';
      await refreshAccounts(); renderAccountList();
      setTimeout(() => document.getElementById('rtImportModal')?.remove(), 1200);
    } catch (e) { msg.textContent = 'Error: ' + e.message; msg.className = 'rt-msg err'; }
  };
  window.rtEditAccount = (id) => { editingAccountId = id; renderAccountEditor(cacheAccounts.find(a => a.id === id)); renderAccountList(); };

  function renderAccountEditor(a) {
    const box = $('rtAccountEditor'); if (!box) return;
    a = a || {};
    const devOpts = ['<option value="">— sin asignar —</option>'].concat(cacheDevices.map(d => `<option value="${d.id}" ${a.device_id === d.id ? 'selected' : ''}>${esc(d.name || d.serial_number)}</option>`)).join('');
    box.innerHTML = `
      <div class="rt-row">
        <div class="rt-field rt-half"><label>Plataforma</label><input id="acPlatform" type="text" value="${escA(a.platform || '')}" placeholder="instagram, tiktok, youtube..."></div>
        <div class="rt-field rt-half"><label>Estado</label>
          <select id="acStatus">${['unused', 'active', 'banned', 'cooldown'].map(s => `<option value="${s}" ${a.status === s ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>
        </div>
      </div>
      <div class="rt-field"><label>Usuario</label><input id="acUsername" type="text" value="${escA(a.username || '')}"></div>
      <div class="rt-field"><label>Contraseña ${a.has_password ? '<span class="rt-hint">(guardada, cifrada — vacío = mantener)</span>' : ''}</label><input id="acPassword" type="password" placeholder="${a.has_password ? '••••••••' : ''}"></div>
      <div class="rt-field"><label>Email</label><input id="acEmail" type="text" value="${escA(a.email || '')}"></div>
      <div class="rt-field"><label>Secreto TOTP / 2FA ${a.has_totp ? '<span class="rt-hint">(guardado — vacío = mantener)</span>' : ''}</label><input id="acTotp" type="text" placeholder="clave base32 del autenticador"></div>
      <div class="rt-field"><label>Notas</label><input id="acNotes" type="text" value="${escA(a.notes || '')}"></div>
      <div class="rt-field"><label>Dispositivo asignado</label><select id="acDevice">${devOpts}</select></div>
      <div class="rt-editor-actions">
        ${editingAccountId ? `<button class="rt-btn" onclick="rtRotateOnDevice()" title="Activa otra cuenta del pool en este dispositivo">🔄 Rotar</button>` : ''}
        ${editingAccountId ? `<button class="rt-btn danger" onclick="rtDeleteAccount()">🗑️ Borrar</button>` : ''}
        <button class="rt-btn primary" onclick="rtSaveAccount()">💾 Guardar cuenta</button>
      </div>
      <div class="rt-hint" style="margin-top:8px">Login: <b>${esc(a.verification_state || 'unknown')}</b>${a.last_verified_at ? ' · verificado ' + esc(new Date(a.last_verified_at).toLocaleString()) : ''}</div>
      <div class="rt-hint" style="margin-top:8px">En una rutina de login usa <code>{{account.username}}</code>, <code>{{account.password}}</code>, <code>{{account.email}}</code> o <code>{{account.totp}}</code> en los pasos "Escribir en campo"/"Teclear texto"; se sustituyen por la cuenta activa de cada dispositivo.</div>
      <div id="rtAccMsg" class="rt-msg"></div>`;
  }

  window.rtSaveAccount = async () => {
    const msg = $('rtAccMsg');
    const body = {
      platform: $('acPlatform').value.trim(), username: $('acUsername').value.trim(),
      email: $('acEmail').value.trim(), notes: $('acNotes').value.trim(), status: $('acStatus').value,
    };
    if ($('acPassword').value) body.password = $('acPassword').value;
    if ($('acTotp').value.trim()) body.totp_secret = $('acTotp').value.trim();
    if (!body.username && !body.email) { msg.textContent = 'Usuario o email obligatorio.'; msg.className = 'rt-msg err'; return; }
    try {
      let acc;
      if (editingAccountId) acc = (await apiFetch('/accounts/' + editingAccountId, { method: 'PUT', body: JSON.stringify(body) })).data;
      else { acc = (await apiFetch('/accounts', { method: 'POST', body: JSON.stringify(body) })).data; editingAccountId = acc.id; }
      // asignación de dispositivo
      const devVal = $('acDevice').value;
      if (devVal) await apiFetch('/accounts/' + editingAccountId + '/assign', { method: 'POST', body: JSON.stringify({ device_id: Number(devVal) }) });
      else if (acc.device_id) await apiFetch('/accounts/' + editingAccountId + '/unassign', { method: 'POST', body: '{}' });
      msg.textContent = '✔ Cuenta guardada.'; msg.className = 'rt-msg ok';
      await refreshAccounts(); renderAccountList(); renderAccountEditor(cacheAccounts.find(x => x.id === editingAccountId));
    } catch (e) { msg.textContent = 'Error: ' + e.message; msg.className = 'rt-msg err'; }
  };

  window.rtDeleteAccount = async () => {
    if (!editingAccountId || !confirm('¿Borrar esta cuenta?')) return;
    try { await apiFetch('/accounts/' + editingAccountId, { method: 'DELETE' }); editingAccountId = null; await refreshAccounts(); renderAccountList(); renderAccountEditor(); }
    catch (e) { alert('Error: ' + e.message); }
  };

  window.rtRotateOnDevice = async () => {
    const a = cacheAccounts.find(x => x.id === editingAccountId);
    const msg = $('rtAccMsg');
    if (!a || !a.device_id) { msg.textContent = 'Asigna primero la cuenta a un dispositivo.'; msg.className = 'rt-msg err'; return; }
    try {
      const r = await apiFetch('/devices/' + a.device_id + '/rotate-account', { method: 'POST', body: JSON.stringify({ platform: a.platform }) });
      msg.textContent = r.success ? `🔄 ${r.message}` : r.message; msg.className = r.success ? 'rt-msg ok' : 'rt-msg err';
      await refreshAccounts(); renderAccountList();
    } catch (e) { msg.textContent = 'Error: ' + e.message; msg.className = 'rt-msg err'; }
  };

  // ============================================================
  // POOL DE PROXIES
  // ============================================================
  let cacheProxies = [], editingProxyId = null;

  async function refreshProxies() {
    try { cacheProxies = (await apiFetch('/proxies')).data || []; } catch (_) { cacheProxies = []; }
    if (!cacheDevices.length) {
      try { cacheDevices = extractList(await apiFetch('/devices?per_page=200')); } catch (_) { cacheDevices = []; }
    }
  }

  function renderProxyList() {
    const box = $('rtProxyList'); if (!box) return;
    if (!cacheProxies.length) {
      box.innerHTML = '<p class="rt-empty">Sin proxies. Agrega uno o importa una lista.</p>';
      return;
    }
    box.innerHTML = cacheProxies.map(proxy => `
      <div class="rt-list-item ${editingProxyId === proxy.id ? 'active' : ''}" onclick="rtEditProxy(${proxy.id})">
        <div class="rt-item-name">${esc(proxy.name || proxy.host)}
          <span class="proxy-pool-status s-${esc(proxy.status)}">${esc(proxy.status)}</span>
        </div>
        <div class="rt-item-sub">${esc(proxy.host)}:${Number(proxy.port)} · ${Number(proxy.assigned_devices)}/${Number(proxy.max_devices)}
          ${proxy.country ? ' · ' + esc(proxy.country) : ''}${proxy.requires_auth ? ' · 🔐' : ''}
        </div>
      </div>`).join('');
  }

  window.rtNewProxy = () => {
    editingProxyId = null;
    renderProxyList();
    renderProxyEditor();
  };

  window.rtEditProxy = id => {
    editingProxyId = id;
    renderProxyList();
    renderProxyEditor(cacheProxies.find(proxy => proxy.id === id));
  };

  function renderProxyEditor(proxy) {
    proxy = proxy || {};
    const box = $('rtProxyEditor'); if (!box) return;
    box.innerHTML = `
      <div class="rt-row">
        <div class="rt-field rt-half"><label>Nombre</label><input id="pxPoolName" type="text" value="${escA(proxy.name || '')}" placeholder="Residencial DO 01"></div>
        <div class="rt-field rt-half"><label>Estado</label><select id="pxPoolStatus">
          ${['active', 'disabled', 'error'].map(status => `<option value="${status}" ${proxy.status === status ? 'selected' : ''}>${status}</option>`).join('')}
        </select></div>
      </div>
      <div class="rt-row">
        <div class="rt-field" style="flex:2"><label>Host / IP</label><input id="pxPoolHost" type="text" value="${escA(proxy.host || '')}" placeholder="proxy.example.com"></div>
        <div class="rt-field" style="flex:1"><label>Puerto</label><input id="pxPoolPort" type="number" value="${escA(proxy.port || '')}" placeholder="8080"></div>
      </div>
      <div class="rt-row">
        <div class="rt-field rt-half"><label>Usuario</label><input id="pxPoolUser" type="text" value="${escA(proxy.username || '')}"></div>
        <div class="rt-field rt-half"><label>Clave ${proxy.has_password ? '<span class="rt-hint">(cifrada; vacío = mantener)</span>' : ''}</label><input id="pxPoolPass" type="password" placeholder="${proxy.has_password ? '••••••••' : ''}"></div>
      </div>
      <div class="rt-row">
        <div class="rt-field rt-half"><label>País</label><input id="pxPoolCountry" type="text" value="${escA(proxy.country || '')}" placeholder="DO"></div>
        <div class="rt-field rt-half"><label>Capacidad (dispositivos)</label><input id="pxPoolCapacity" type="number" min="1" value="${Number(proxy.max_devices || 1)}"></div>
      </div>
      <div class="rt-field"><label>Etiquetas (separadas por coma)</label><input id="pxPoolTags" type="text" value="${escA((proxy.tags || []).join(','))}" placeholder="residencial,móvil"></div>
      <div class="rt-editor-actions">
        ${editingProxyId ? '<button class="rt-btn danger" onclick="rtDeleteProxy()">🗑️ Borrar</button>' : ''}
        <button class="rt-btn primary" onclick="rtSaveProxy()">💾 Guardar proxy</button>
      </div>
      <div class="rt-proxy-divider"></div>
      <h4>Distribución masiva</h4>
      <p class="rt-hint">Usa los dispositivos seleccionados en la pantalla principal. Si no hay selección, usa todos los que estén online.</p>
      <div class="rt-row">
        <div class="rt-field rt-half"><label>Estrategia</label><select id="pxDistributionStrategy"><option value="round_robin">Round robin</option><option value="random">Aleatoria</option></select></div>
        <div class="rt-field rt-half"><label>Filtrar país (opcional)</label><input id="pxDistributionCountry" type="text" placeholder="DO"></div>
      </div>
      <div class="rt-editor-actions">
        <button class="rt-btn primary" onclick="rtDistributeProxies()">🌐 Distribuir proxies</button>
      </div>
      <div class="rt-proxy-divider"></div>
      <h4>Importación</h4>
      <p class="rt-hint">Una línea por proxy: <code>host:puerto</code> o <code>host:puerto:usuario:clave</code>.</p>
      <textarea id="pxImportRows" class="rt-textarea" rows="5" placeholder="10.0.0.5:8080&#10;proxy.example.com:3128:usuario:clave"></textarea>
      <div class="rt-editor-actions"><button class="rt-btn" onclick="rtImportProxies()">Importar lista</button></div>
      ${proxy.requires_auth ? '<p class="rt-msg err">Este proxy requiere autenticación. Android USB/ADB no puede aplicarlo como proxy HTTP global; necesitará un agente VPN/proxy compatible en el teléfono.</p>' : ''}
      <div id="rtProxyMsg" class="rt-msg"></div>`;
  }

  window.rtSaveProxy = async () => {
    const msg = $('rtProxyMsg');
    const body = {
      name: $('pxPoolName').value.trim(),
      host: $('pxPoolHost').value.trim(),
      port: Number($('pxPoolPort').value),
      protocol: 'http',
      username: $('pxPoolUser').value.trim(),
      country: $('pxPoolCountry').value.trim(),
      tags: $('pxPoolTags').value.split(',').map(tag => tag.trim()).filter(Boolean),
      status: $('pxPoolStatus').value,
      max_devices: Number($('pxPoolCapacity').value),
    };
    if ($('pxPoolPass').value) body.password = $('pxPoolPass').value;
    if (!body.host || !body.port) {
      msg.textContent = 'Host y puerto son obligatorios.';
      msg.className = 'rt-msg err';
      return;
    }
    try {
      if (editingProxyId) {
        await apiFetch('/proxies/' + editingProxyId, { method: 'PUT', body: JSON.stringify(body) });
      } else {
        const response = await apiFetch('/proxies', { method: 'POST', body: JSON.stringify(body) });
        editingProxyId = response.data.id;
      }
      await refreshProxies();
      renderProxyList();
      renderProxyEditor(cacheProxies.find(item => item.id === editingProxyId));
      $('rtProxyMsg').textContent = '✔ Proxy guardado.';
      $('rtProxyMsg').className = 'rt-msg ok';
    } catch (error) {
      msg.textContent = 'Error: ' + error.message;
      msg.className = 'rt-msg err';
    }
  };

  window.rtDeleteProxy = async () => {
    if (!editingProxyId || !confirm('¿Borrar este proxy del pool?')) return;
    try {
      await apiFetch('/proxies/' + editingProxyId, { method: 'DELETE' });
      editingProxyId = null;
      await refreshProxies();
      renderProxyList();
      renderProxyEditor();
    } catch (error) {
      const msg = $('rtProxyMsg');
      msg.textContent = 'Error: ' + error.message;
      msg.className = 'rt-msg err';
    }
  };

  window.rtImportProxies = async () => {
    const msg = $('rtProxyMsg');
    const rows = $('pxImportRows').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
      const parts = line.split(':');
      return {
        host: parts[0],
        port: Number(parts[1]),
        username: parts[2] || '',
        password: parts.slice(3).join(':') || '',
        max_devices: 1,
      };
    });
    if (!rows.length) {
      msg.textContent = 'Pega al menos un proxy.';
      msg.className = 'rt-msg err';
      return;
    }
    try {
      const response = await apiFetch('/proxies/import', { method: 'POST', body: JSON.stringify({ proxies: rows }) });
      await refreshProxies();
      renderProxyList();
      msg.textContent = response.message;
      msg.className = response.data.rejected.length ? 'rt-msg err' : 'rt-msg ok';
    } catch (error) {
      msg.textContent = 'Error: ' + error.message;
      msg.className = 'rt-msg err';
    }
  };

  window.rtDistributeProxies = async () => {
    const msg = $('rtProxyMsg');
    const ids = typeof selectedDeviceIds !== 'undefined' ? [...selectedDeviceIds] : [];
    const body = {
      strategy: $('pxDistributionStrategy').value,
      country: $('pxDistributionCountry').value.trim() || undefined,
    };
    if (ids.length) body.device_ids = ids;
    msg.textContent = `Distribuyendo en ${ids.length || 'todos los'} dispositivos online…`;
    msg.className = 'rt-msg';
    try {
      const response = await apiFetch('/proxies/distribute', { method: 'POST', body: JSON.stringify(body) });
      msg.textContent = response.message;
      msg.className = response.data.failed ? 'rt-msg err' : 'rt-msg ok';
      await refreshProxies();
      renderProxyList();
      if (typeof loadAll === 'function') loadAll();
    } catch (error) {
      msg.textContent = 'Error: ' + error.message;
      msg.className = 'rt-msg err';
    }
  };

  // ============================================================
  // HERMES MCP
  // ============================================================
  async function renderHermesPane(message = '', isError = false) {
    const box = $('rtHermesContent'); if (!box) return;
    box.innerHTML = '<div class="rt-hermes-loading">Consultando Hermes…</div>';
    try {
      const response = await apiFetch('/hermes/status');
      const status = response.data || {};
      box.innerHTML = `
        <div class="rt-hermes-card">
          <div class="rt-hermes-icon">🤖</div>
          <div>
            <h3>Hermes + AppControl</h3>
            <p>Hermes podrá administrar dispositivos, proxies, rutinas, horarios y reportes mediante el MCP incluido en esta aplicación.</p>
          </div>
        </div>
        <div class="rt-hermes-status-grid">
          <div><span>Hermes instalado</span><b class="${status.installed ? 'ok' : 'bad'}">${status.installed ? 'Sí' : 'No'}</b></div>
          <div><span>MCP incluido</span><b class="${status.portable_ready ? 'ok' : 'bad'}">${status.portable_ready ? 'Listo' : 'Falta'}</b></div>
          <div><span>Conexión AppControl</span><b class="${status.configured ? 'ok' : 'warn'}">${status.configured ? 'Conectado' : 'Sin configurar'}</b></div>
        </div>
        <div class="rt-hermes-note">
          La conexión usa solamente <code>127.0.0.1</code>. La clave API no se copia a Hermes:
          se guarda únicamente la ruta del archivo local generado por AppControl.
        </div>
        <div class="rt-editor-actions">
          ${status.configured ? '<button class="rt-btn" onclick="rtTestHermes()">🔎 Probar conexión</button>' : ''}
          ${status.configured ? '<button class="rt-btn danger" onclick="rtDisconnectHermes()">Desconectar</button>' : ''}
          <button class="rt-btn primary" onclick="rtConfigureHermes()" ${status.installed && status.portable_ready ? '' : 'disabled'}>
            ${status.configured ? '🔧 Reparar conexión' : '🔗 Conectar Hermes'}
          </button>
        </div>
        <p class="rt-hint" style="margin-top:14px">Después de conectar o reparar, abre una sesión nueva de Hermes para que cargue las herramientas.</p>
        <div id="rtHermesMsg" class="rt-msg ${isError ? 'err' : (message ? 'ok' : '')}">${esc(message || status.message || '')}</div>`;
    } catch (error) {
      box.innerHTML = `<div class="rt-msg err">No se pudo consultar Hermes: ${esc(error.message)}</div>`;
    }
  }

  function setHermesBusy(text) {
    const msg = $('rtHermesMsg');
    if (msg) {
      msg.textContent = text;
      msg.className = 'rt-msg';
    }
    document.querySelectorAll('#rtPane-hermes button').forEach(button => { button.disabled = true; });
  }

  window.rtConfigureHermes = async () => {
    setHermesBusy('Configurando y probando la conexión portable…');
    try {
      const response = await apiFetch('/hermes/configure', { method: 'POST', body: '{}' });
      await renderHermesPane(response.message || 'Hermes conectado.');
    } catch (error) {
      await renderHermesPane(error.message, true);
    }
  };

  window.rtTestHermes = async () => {
    setHermesBusy('Probando el servidor MCP…');
    try {
      const response = await apiFetch('/hermes/test', { method: 'POST', body: '{}' });
      await renderHermesPane(`${response.message}${response.data?.tools ? ` · ${response.data.tools} herramientas` : ''}`);
    } catch (error) {
      await renderHermesPane(error.message, true);
    }
  };

  window.rtDisconnectHermes = async () => {
    if (!confirm('¿Desconectar AppControl de Hermes en esta PC?')) return;
    setHermesBusy('Eliminando la conexión de Hermes…');
    try {
      const response = await apiFetch('/hermes/connection', { method: 'DELETE' });
      await renderHermesPane(response.message || 'Hermes desconectado.');
    } catch (error) {
      await renderHermesPane(error.message, true);
    }
  };
})();
