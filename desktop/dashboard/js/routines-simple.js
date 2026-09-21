(function () {
  'use strict';

  const PACE_PRESETS = {
    careful: { pace: 'careful', step_delay_ms: 2200, action_settle_ms: 1200, lock_portrait: true },
    standard: { pace: 'standard', step_delay_ms: 1200, action_settle_ms: 700, lock_portrait: true },
    quick: { pace: 'quick', step_delay_ms: 650, action_settle_ms: 350, lock_portrait: true },
  };
  const PACE_LIMITS = {
    step_delay_ms: { min: 600, max: 10000 },
    action_settle_ms: { min: 250, max: 5000 },
  };
  const APP_CHOICES = [
    { name: 'Spotify', pkg: 'com.spotify.music' },
    { name: 'YouTube', pkg: 'com.google.android.youtube' },
    { name: 'Gmail', pkg: 'com.google.android.gm' },
    { name: 'Instagram', pkg: 'com.instagram.android' },
    { name: 'Facebook', pkg: 'com.facebook.katana' },
    { name: 'TikTok', pkg: 'com.zhiliaoapp.musically' },
    { name: 'Play Store', pkg: 'com.android.vending' },
    { name: 'Ajustes', pkg: 'com.android.settings' },
  ];

  let simpleEditingId = null;
  let simpleDraft = freshDraft();
  let simpleSavedTargets = [];
  let simpleTargetMode = 'selection';
  let simpleSourceCanonical = true;
  let simpleConversionApproved = false;
  let advancedOptions = { ...PACE_PRESETS.careful };
  let apiWrapped = false;

  const byId = id => document.getElementById(id);
  const escapeHtml = value => {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  };
  const escapeAttr = value => escapeHtml(value).replace(/"/g, '&quot;');

  function freshDraft() {
    return {
      name: '', description: '', kind: 'app_browse', package_name: 'com.spotify.music',
      active_seconds: 45, scroll_count: 3, search_topic: '', return_to_original: true,
      pace: 'careful', lock_portrait: true,
    };
  }

  function selectedIds() {
    try { return [...selectedDeviceIds].map(Number).filter(Number.isInteger); }
    catch (_) { return []; }
  }

  function normalizedOptions(input) {
    const source = input && typeof input === 'object' ? input : {};
    const pace = ['quick', 'standard', 'careful'].includes(source.pace) ? source.pace : 'careful';
    return {
      pace,
      step_delay_ms: boundedNumber(source.step_delay_ms, PACE_PRESETS[pace].step_delay_ms, PACE_LIMITS.step_delay_ms.min, PACE_LIMITS.step_delay_ms.max),
      action_settle_ms: boundedNumber(source.action_settle_ms, PACE_PRESETS[pace].action_settle_ms, PACE_LIMITS.action_settle_ms.min, PACE_LIMITS.action_settle_ms.max),
      lock_portrait: source.lock_portrait !== false,
    };
  }

  function boundedNumber(value, fallback, min, max) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.round(numeric))) : fallback;
  }

  function executionOptionsFromSimple() {
    const preset = PACE_PRESETS[simpleDraft.pace] || PACE_PRESETS.careful;
    return { ...preset, lock_portrait: simpleDraft.lock_portrait !== false };
  }

  function wrapWorkflowApi() {
    if (apiWrapped || typeof window.apiFetch !== 'function') return;
    apiWrapped = true;
    const baseApiFetch = window.apiFetch;
    window.apiFetch = async function (path, options = {}) {
      const method = String(options.method || 'GET').toUpperCase();
      const isWorkflowWrite = (method === 'POST' && path === '/workflows') || (method === 'PUT' && /^\/workflows\/\d+$/.test(path));
      const isExecution = method === 'POST' && /^\/workflows\/\d+\/execute$/.test(path);
      if ((isWorkflowWrite || isExecution) && options.body) {
        try {
          const payload = JSON.parse(options.body);
          if (!payload.execution_options) payload.execution_options = readAdvancedOptions();
          options = { ...options, body: JSON.stringify(payload) };
        } catch (_) {}
      }
      const response = await baseApiFetch(path, options);
      if (method === 'GET' && /^\/workflows\/\d+$/.test(path) && response?.data) {
        advancedOptions = normalizedOptions(response.data.execution_options);
      }
      return response;
    };
  }

  function readAdvancedOptions() {
    const pace = byId('rtAdvancedPace')?.value || advancedOptions.pace || 'careful';
    return {
      pace: ['quick', 'standard', 'careful'].includes(pace) ? pace : 'careful',
      step_delay_ms: boundedNumber(byId('rtAdvancedStepDelay')?.value, advancedOptions.step_delay_ms, PACE_LIMITS.step_delay_ms.min, PACE_LIMITS.step_delay_ms.max),
      action_settle_ms: boundedNumber(byId('rtAdvancedSettle')?.value, advancedOptions.action_settle_ms, PACE_LIMITS.action_settle_ms.min, PACE_LIMITS.action_settle_ms.max),
      lock_portrait: byId('rtAdvancedPortrait') ? byId('rtAdvancedPortrait').checked : advancedOptions.lock_portrait !== false,
    };
  }

  function installStyles() {
    if (byId('simpleRoutineStyles')) return;
    const style = document.createElement('style');
    style.id = 'simpleRoutineStyles';
    style.textContent = `
      .rt-mode-switch{display:inline-flex;gap:3px;padding:3px;background:var(--theme-surface-3,#eef2f7);border:1px solid var(--border-color,#dbe3ee);border-radius:10px}.rt-mode-switch button{border:0;background:transparent;color:var(--text-muted,#64748b);padding:6px 10px;border-radius:7px;font-size:12px;font-weight:750;cursor:pointer}.rt-mode-switch button.active{background:var(--panel-bg,#fff);color:var(--primary,#4f46e5);box-shadow:0 1px 4px rgba(15,23,42,.12)}.rt-simple-pane{width:100%;height:100%;overflow:auto;padding:18px 22px;box-sizing:border-box;background:var(--panel-bg,#fff);color:var(--text-dark,#0f172a)}.sr-shell{width:min(760px,100%);margin:0 auto}.sr-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:14px}.sr-top h3{margin:0;font-size:20px}.sr-top p{margin:4px 0 0;color:var(--text-muted,#64748b);font-size:12.5px;line-height:1.45}.sr-card{border:1px solid var(--border-color,#e2e8f0);border-radius:13px;padding:14px;margin-bottom:11px;background:var(--theme-surface-2,#f8fafc)}.sr-card-title{font-size:12px;font-weight:800;color:var(--text-muted,#64748b);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px}.sr-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.sr-grid .wide{grid-column:1/-1}.sr-field{display:block;font-size:11.5px;font-weight:700;color:var(--text-dark,#334155)}.sr-field input,.sr-field select{display:block;width:100%;box-sizing:border-box;margin-top:5px;padding:9px 10px;border:1px solid var(--border-color,#cbd5e1);border-radius:8px;background:var(--theme-input-bg,#fff);color:var(--theme-input-text,#111827);font-size:13px}.sr-check{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:650;margin-top:7px}.sr-check input{margin:0}.sr-kind-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.sr-kind{border:1px solid var(--border-color,#dbe3ee);border-radius:10px;background:var(--panel-bg,#fff);color:var(--text-dark,#334155);padding:10px;text-align:left;cursor:pointer}.sr-kind strong{display:block;font-size:12.5px}.sr-kind small{display:block;color:var(--text-muted,#64748b);font-size:10.5px;line-height:1.35;margin-top:3px}.sr-kind.active{border-color:var(--primary,#6366f1);box-shadow:0 0 0 2px color-mix(in srgb,var(--primary,#6366f1) 18%,transparent)}.sr-pace{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.sr-pace label{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--border-color,#dbe3ee);border-radius:9px;padding:9px;background:var(--panel-bg,#fff);font-size:12px;cursor:pointer}.sr-pace label:has(input:checked){border-color:var(--primary,#6366f1)}.sr-pace b{display:block}.sr-pace small{display:block;color:var(--text-muted,#64748b);margin-top:2px}.sr-preview{font-size:12px;color:var(--text-muted,#64748b);line-height:1.55}.sr-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:12px}.sr-msg{min-height:18px;font-size:12.5px;margin-top:9px}.sr-msg.ok{color:#16a34a}.sr-msg.err{color:#dc2626}.sr-warning{padding:8px 10px;border-radius:8px;background:#fffbeb;color:#92400e;font-size:11.5px;margin-top:8px}.rt-advanced-execution{border:1px solid var(--border-color,#dbe3ee);border-radius:10px;background:var(--theme-surface-2,#f8fafc);padding:10px 12px;margin:0 0 14px}.rt-advanced-execution summary{font-size:12.5px;font-weight:750;cursor:pointer}.rt-advanced-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:10px}.rt-advanced-grid label{font-size:11px;color:var(--text-muted,#64748b);font-weight:650}.rt-advanced-grid input,.rt-advanced-grid select{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:7px 8px;border:1px solid var(--border-color,#cbd5e1);border-radius:7px}.rt-advanced-grid .portrait{display:flex;align-items:center;gap:6px;margin-top:20px}.rt-advanced-grid .portrait input{width:auto;margin:0}@media(max-width:720px){.sr-kind-grid,.sr-grid,.rt-advanced-grid{grid-template-columns:1fr}.sr-pace{grid-template-columns:1fr}.sr-top{flex-direction:column}}`;
    document.head.appendChild(style);
  }

  function patchOverlay() {
    const overlay = byId('routinesOverlay');
    if (!overlay) return false;
    const head = overlay.querySelector('#rtPane-routines .rt-col-head');
    if (head && !byId('rtModeSwitch')) {
      const switcher = document.createElement('div');
      switcher.id = 'rtModeSwitch';
      switcher.className = 'rt-mode-switch';
      switcher.innerHTML = '<button id="rtSimpleModeBtn" type="button" onclick="srShowSimple()">Simple</button><button id="rtAdvancedModeBtn" type="button" onclick="srShowAdvanced()">Avanzado</button>';
      head.parentElement.insertBefore(switcher, head.nextSibling);
      switcher.style.margin = '8px 10px 0';
    }
    installAdvancedControls();
    return true;
  }

  function installAdvancedControls() {
    const editor = byId('rtRoutineEditor');
    if (!editor || byId('rtAdvancedExecution')) return;
    const desc = byId('rtDesc')?.closest('.rt-field');
    if (!desc) return;
    const options = normalizedOptions(advancedOptions);
    const details = document.createElement('details');
    details.id = 'rtAdvancedExecution';
    details.className = 'rt-advanced-execution';
    details.innerHTML = `
      <summary>Ritmo y orientación (avanzado)</summary>
      <div class="rt-advanced-grid">
        <label>Ritmo<select id="rtAdvancedPace" onchange="srAdvancedPaceChanged(this.value)"><option value="careful">Cuidadoso (2.2 s + 1.2 s)</option><option value="standard">Normal (1.2 s + 0.7 s)</option><option value="quick">Rápido (0.65 s + 0.35 s)</option></select></label>
        <label>Pausa entre pasos (ms)<input id="rtAdvancedStepDelay" type="number" min="${PACE_LIMITS.step_delay_ms.min}" max="${PACE_LIMITS.step_delay_ms.max}" value="${options.step_delay_ms}"></label>
        <label>Espera extra tras acción (ms)<input id="rtAdvancedSettle" type="number" min="${PACE_LIMITS.action_settle_ms.min}" max="${PACE_LIMITS.action_settle_ms.max}" value="${options.action_settle_ms}"></label>
        <label class="portrait"><input id="rtAdvancedPortrait" type="checkbox" ${options.lock_portrait ? 'checked' : ''}> Mantener vertical</label>
      </div>`;
    desc.insertAdjacentElement('afterend', details);
    byId('rtAdvancedPace').value = options.pace;
  }

  window.srAdvancedPaceChanged = function (pace) {
    const preset = PACE_PRESETS[pace] || PACE_PRESETS.careful;
    if (byId('rtAdvancedStepDelay')) byId('rtAdvancedStepDelay').value = preset.step_delay_ms;
    if (byId('rtAdvancedSettle')) byId('rtAdvancedSettle').value = preset.action_settle_ms;
  };

  function simplePane() {
    const routinesPane = byId('rtPane-routines');
    if (!routinesPane) return null;
    let pane = byId('rtSimplePane');
    if (!pane) {
      pane = document.createElement('div');
      pane.id = 'rtSimplePane';
      pane.className = 'rt-simple-pane';
      pane.hidden = true;
      routinesPane.appendChild(pane);
    }
    return pane;
  }

  window.srShowSimple = async function () {
    if (!patchOverlay()) return;
    const pane = simplePane();
    byId('rtPane-routines').querySelectorAll(':scope > .rt-col').forEach(col => { col.hidden = true; });
    pane.hidden = false;
    byId('rtSimpleModeBtn')?.classList.add('active');
    byId('rtAdvancedModeBtn')?.classList.remove('active');
    renderSimpleEditor();
    await refreshSimpleWorkflowList();
  };

  window.srShowAdvanced = function () {
    const pane = simplePane();
    if (pane) pane.hidden = true;
    byId('rtPane-routines')?.querySelectorAll(':scope > .rt-col').forEach(col => { col.hidden = false; });
    byId('rtSimpleModeBtn')?.classList.remove('active');
    byId('rtAdvancedModeBtn')?.classList.add('active');
    installAdvancedControls();
  };

  function targetChoiceMarkup(scope) {
    const current = scope.length ? scope.join(', ') : 'ninguno';
    const saved = simpleSavedTargets.length
      ? simpleSavedTargets.map(target => `${escapeHtml(target.name || target.serial_number || `ID ${target.id}`)} (#${target.id})`).join(', ')
      : 'ninguno';
    if (!simpleEditingId) return `
      <div class="sr-preview"><b>Selección actual:</b> ${current}</div>
      <div class="sr-pace" style="margin-top:8px">
        <label><input type="radio" name="srTargets" value="selection" ${simpleTargetMode !== 'none' ? 'checked' : ''} onchange="srSetTargetMode(this.value)"><span><b>Asignar selección actual</b><small>Guarda exactamente los dispositivos seleccionados.</small></span></label>
        <label><input type="radio" name="srTargets" value="none" ${simpleTargetMode === 'none' ? 'checked' : ''} onchange="srSetTargetMode(this.value)"><span><b>Guardar sin dispositivos</b><small>No crea destinos guardados.</small></span></label>
      </div>`;
    return `
      <div class="sr-preview"><b>Destinos guardados:</b> ${saved}<br><b>Selección actual:</b> ${current}</div>
      <div class="sr-pace" style="margin-top:8px">
        <label><input type="radio" name="srTargets" value="preserve" ${simpleTargetMode === 'preserve' ? 'checked' : ''} onchange="srSetTargetMode(this.value)"><span><b>Conservar guardados</b><small>No cambia la asignación actual.</small></span></label>
        <label><input type="radio" name="srTargets" value="replace" ${simpleTargetMode === 'replace' ? 'checked' : ''} onchange="srSetTargetMode(this.value)"><span><b>Reemplazar con selección</b><small>Requiere confirmación al guardar.</small></span></label>
        <label><input type="radio" name="srTargets" value="clear" ${simpleTargetMode === 'clear' ? 'checked' : ''} onchange="srSetTargetMode(this.value)"><span><b>Quitar todos los destinos</b><small>Envía una lista vacía solo tras confirmar.</small></span></label>
      </div>`;
  }

  function renderSimpleEditor() {
    const pane = simplePane();
    if (!pane) return;
    const scope = selectedIds();
    pane.innerHTML = `
      <div class="sr-shell">
        <div class="sr-top"><div><h3>Crear una rutina simple</h3><p>Elige lo que debe hacer. Los detalles técnicos quedan disponibles en Avanzado.</p></div><button class="rt-btn" data-sr-always onclick="srShowAdvanced()">Abrir avanzado</button></div>
        <section class="sr-card">
          <div class="sr-card-title">Rutina</div>
          <label class="sr-field wide">Abrir una rutina guardada<select id="srWorkflow" onchange="srLoadWorkflow(this.value)"><option value="">Nueva rutina…</option></select></label>
          <div class="sr-grid sr-configurable" style="margin-top:10px">
            <label class="sr-field">Nombre<input id="srName" value="${escapeAttr(simpleDraft.name)}" placeholder="p. ej. Revisión de Spotify"></label>
            <label class="sr-field">Nota opcional<input id="srDescription" value="${escapeAttr(simpleDraft.description)}" placeholder="Qué hará esta rutina"></label>
          </div>
        </section>
        <section class="sr-card sr-configurable">
          <div class="sr-card-title">¿Qué debe hacer?</div>
          <div class="sr-kind-grid">
            ${kindButton('app_browse', '📱 Abrir y recorrer una app', 'Abre una app, espera y realiza algunos desplazamientos.')}
            ${kindButton('web_read', '🔎 Buscar y leer una página', 'Busca un tema, abre un resultado y recorre la página.')}
            ${kindButton('maintenance', '🧰 Revisar el dispositivo', 'Estabiliza y comprueba salud y red.')}
          </div>
          <div id="srKindFields" style="margin-top:11px"></div>
        </section>
        <section class="sr-card sr-configurable">
          <div class="sr-card-title">Ritmo y pantalla</div>
          <div class="sr-pace">
            <label><input type="radio" name="srPace" value="careful" ${simpleDraft.pace === 'careful' ? 'checked' : ''} onchange="srSet('pace',this.value)"><span><b>Cuidadoso · recomendado</b><small>2.2 s entre pasos y 1.2 s extra después de cada acción.</small></span></label>
            <label><input type="radio" name="srPace" value="standard" ${simpleDraft.pace === 'standard' ? 'checked' : ''} onchange="srSet('pace',this.value)"><span><b>Normal</b><small>1.2 s entre pasos y 0.7 s extra después de cada acción.</small></span></label>
            ${simpleDraft.pace === 'quick' ? '<label><input type="radio" name="srPace" value="quick" checked onchange="srSet(\'pace\',this.value)"><span><b>Rápido · guardado</b><small>0.65 s entre pasos y 0.35 s extra después de cada acción.</small></span></label>' : ''}
          </div>
          <label class="sr-check"><input id="srPortrait" type="checkbox" ${simpleDraft.lock_portrait !== false ? 'checked' : ''} onchange="srSet('lock_portrait',this.checked)"> Mantener pantalla vertical durante toda la rutina</label>
        </section>
        <section class="sr-card"><div class="sr-card-title">Dispositivos asignados</div>${targetChoiceMarkup(scope)}</section>
        <section class="sr-card sr-preview"><span id="srPreview"></span></section>
        ${simpleSourceCanonical ? '' : `<div class="sr-warning"><b>Rutina avanzada protegida.</b> Sus ${Array.isArray(simpleDraft._sourceSteps) ? simpleDraft._sourceSteps.length : 0} pasos no coinciden exactamente con una plantilla Simple. Ábrela en Avanzado o conviértela explícitamente.<div style="margin-top:8px"><button id="srConvertBtn" class="rt-btn danger" onclick="srApproveConversion()">Convertir y reemplazar pasos…</button></div></div>`}
        <div class="sr-actions"><button class="rt-btn" data-sr-always onclick="srNewRoutine()">Limpiar</button><button id="srSaveBtn" class="rt-btn primary" onclick="srSave(false)">💾 Guardar</button><button id="srRunBtn" class="rt-btn primary" onclick="srSave(true)">▶ Guardar y ejecutar</button></div>
        <div id="srMessage" class="sr-msg"></div>
      </div>`;
    renderKindFields();
    if (!simpleSourceCanonical) pane.querySelectorAll('.sr-configurable input,.sr-configurable select,.sr-configurable button,#srSaveBtn,#srRunBtn').forEach(control => { control.disabled = true; });
  }

  function kindButton(kind, title, help) {
    return `<button type="button" class="sr-kind ${simpleDraft.kind === kind ? 'active' : ''}" onclick="srChooseKind('${kind}')"><strong>${title}</strong><small>${help}</small></button>`;
  }

  window.srChooseKind = function (kind) {
    simpleDraft.kind = kind;
    document.querySelectorAll('.sr-kind').forEach(button => button.classList.toggle('active', button.getAttribute('onclick').includes(`'${kind}'`)));
    renderKindFields();
  };

  window.srSetTargetMode = function (mode) {
    if (['selection', 'none', 'preserve', 'replace', 'clear'].includes(mode)) simpleTargetMode = mode;
  };

  window.srApproveConversion = function () {
    const count = Array.isArray(simpleDraft._sourceSteps) ? simpleDraft._sourceSteps.length : 0;
    if (!confirm(`Convertir esta rutina avanzada a la plantilla Simple seleccionada?\n\nEsto reemplazará permanentemente sus ${count} pasos al guardar. Los destinos guardados se conservarán salvo que elijas otra opción.`)) return;
    simpleSourceCanonical = true;
    simpleConversionApproved = true;
    renderSimpleEditor();
    refreshSimpleWorkflowList();
  };

  window.srSet = function (key, value) { simpleDraft[key] = value; updatePreview(); };

  function renderKindFields() {
    const box = byId('srKindFields');
    if (!box) return;
    if (simpleDraft.kind === 'app_browse') {
      const known = APP_CHOICES.some(app => app.pkg === simpleDraft.package_name);
      box.innerHTML = `<div class="sr-grid">
        <label class="sr-field">App<select onchange="srSet('package_name',this.value)">${APP_CHOICES.map(app => `<option value="${app.pkg}" ${simpleDraft.package_name === app.pkg ? 'selected' : ''}>${app.name}</option>`).join('')}${known ? '' : `<option value="${escapeAttr(simpleDraft.package_name)}" selected>${escapeHtml(simpleDraft.package_name)}</option>`}</select></label>
        <label class="sr-field">Tiempo dentro de la app<select onchange="srSet('active_seconds',Number(this.value))">${timeOptions(simpleDraft.active_seconds)}</select></label>
        <label class="sr-field">Desplazamientos<select onchange="srSet('scroll_count',Number(this.value))">${countOptions(simpleDraft.scroll_count)}</select></label>
        <label class="sr-check"><input type="checkbox" ${simpleDraft.return_to_original !== false ? 'checked' : ''} onchange="srSet('return_to_original',this.checked)"> Volver a la app original al terminar</label>
      </div>`;
    } else if (simpleDraft.kind === 'web_read') {
      box.innerHTML = `<div class="sr-grid">
        <label class="sr-field wide">Tema o frase de búsqueda<input value="${escapeAttr(simpleDraft.search_topic)}" oninput="srSet('search_topic',this.value)" placeholder="p. ej. clima de Chicago hoy"></label>
        <label class="sr-field">Tiempo en la página<select onchange="srSet('active_seconds',Number(this.value))">${timeOptions(simpleDraft.active_seconds)}</select></label>
        <label class="sr-field">Desplazamientos<select onchange="srSet('scroll_count',Number(this.value))">${countOptions(simpleDraft.scroll_count)}</select></label>
        <label class="sr-check wide"><input type="checkbox" ${simpleDraft.return_to_original !== false ? 'checked' : ''} onchange="srSet('return_to_original',this.checked)"> Volver a la app original al terminar</label>
      </div>`;
    } else {
      box.innerHTML = '<div class="sr-preview">Mantendrá la pantalla despierta, conservará animaciones normales, comprobará batería/temperatura y leerá el estado de red. No modifica proxy ni cuentas.</div>';
    }
    updatePreview();
  }

  function timeOptions(selected) {
    return [[30,'30 segundos'],[45,'45 segundos'],[60,'1 minuto'],[120,'2 minutos'],[300,'5 minutos']]
      .map(([value,label]) => `<option value="${value}" ${Number(selected) === value ? 'selected' : ''}>${label}</option>`).join('');
  }
  function countOptions(selected) {
    return [[0,'Ninguno'],[2,'2'],[3,'3'],[5,'5'],[8,'8']]
      .map(([value,label]) => `<option value="${value}" ${Number(selected) === value ? 'selected' : ''}>${label}</option>`).join('');
  }

  function updatePreview() {
    const out = byId('srPreview');
    if (!out) return;
    if (simpleDraft.kind === 'app_browse') out.textContent = `Abrirá ${friendlyApp(simpleDraft.package_name)}, esperará ${simpleDraft.active_seconds} s y hará ${simpleDraft.scroll_count} desplazamientos.`;
    else if (simpleDraft.kind === 'web_read') out.textContent = `Buscará “${simpleDraft.search_topic || 'tema pendiente'}”, abrirá un resultado, esperará ${simpleDraft.active_seconds} s y hará ${simpleDraft.scroll_count} desplazamientos.`;
    else out.textContent = 'Ejecutará estabilización, salud del dispositivo y diagnóstico de red.';
  }

  function friendlyApp(pkg) { return APP_CHOICES.find(app => app.pkg === pkg)?.name || pkg; }

  function buildStepsForDraft(draft) {
    const preset = PACE_PRESETS[draft.pace] || PACE_PRESETS.careful;
    const pace = { ...preset, lock_portrait: draft.lock_portrait !== false };
    const repeatPause = pace.pace === 'careful' ? 1300 : 900;
    if (draft.kind === 'maintenance') return [
      { type: 'DEVICE_STABILIZE', keep_awake: 'true', screen_timeout_minutes: 30, animation_scale: '1', sync_time: 'false' },
      { type: 'DEVICE_HEALTH' }, { type: 'DEVICE_NETWORK_STATUS' },
    ];
    const result = [];
    if (draft.return_to_original !== false) result.push({ type: 'CAPTURE_FOREGROUND_APP' });
    if (draft.kind === 'web_read') {
      result.push({ type: 'PRESS_HOME' }, { type: 'OPEN_WEB_SEARCH', query: String(draft.search_topic || '').trim() },
        { type: 'WAIT', duration: 4000 },
        { type: 'CLICK_FIRST_ACTIONABLE', min_y: 350, max_y: 1800, exclude_text: 'Search,Google,More,Sign in' },
        { type: 'WAIT', duration: 3000 });
    } else {
      result.push({ type: 'OPEN_APP', package_name: draft.package_name }, { type: 'WAIT', duration: 4000 });
    }
    if (Number(draft.scroll_count) > 0) result.push({ type: 'REPEAT_SCROLL', direction: 'down', count: Number(draft.scroll_count), pause_ms: repeatPause });
    result.push({ type: 'WAIT', duration: Number(draft.active_seconds) * 1000 });
    if (draft.return_to_original !== false) result.push({ type: 'RESTORE_FOREGROUND_APP' });
    return result;
  }
  function buildSteps() { return buildStepsForDraft(simpleDraft); }

  window.srNewRoutine = function () {
    simpleEditingId = null; simpleDraft = freshDraft(); simpleSavedTargets = [];
    simpleTargetMode = 'selection'; simpleSourceCanonical = true; simpleConversionApproved = false;
    renderSimpleEditor(); refreshSimpleWorkflowList();
  };

  async function refreshSimpleWorkflowList() {
    const select = byId('srWorkflow');
    if (!select) return;
    try {
      const response = await apiFetch('/workflows?per_page=100');
      const list = Array.isArray(response.data)
        ? response.data
        : (Array.isArray(response.data?.data) ? response.data.data : (response.data?.items || []));
      select.innerHTML = '<option value="">Nueva rutina…</option>' + list.map(wf => `<option value="${wf.id}" ${Number(simpleEditingId) === Number(wf.id) ? 'selected' : ''}>${escapeHtml(wf.name)}</option>`).join('');
    } catch (_) {}
  }

  window.srLoadWorkflow = async function (value) {
    if (!value) { srNewRoutine(); return; }
    const msg = byId('srMessage');
    try {
      const response = await apiFetch(`/workflows/${Number(value)}`);
      const workflow = response.data;
      simpleEditingId = workflow.id;
      simpleDraft = inferSimpleDraft(workflow);
      simpleDraft._sourceSteps = Array.isArray(workflow.steps) ? JSON.parse(JSON.stringify(workflow.steps)) : [];
      simpleSavedTargets = Array.isArray(workflow.target_devices) ? workflow.target_devices.map(target => ({ id: Number(target.id), name: target.name, serial_number: target.serial_number })) : [];
      simpleTargetMode = 'preserve';
      simpleSourceCanonical = isCanonicalSimpleWorkflow(workflow, simpleDraft);
      simpleConversionApproved = false;
      renderSimpleEditor();
      await refreshSimpleWorkflowList();
    } catch (error) { msg.textContent = `No se pudo abrir: ${error.message}`; msg.className = 'sr-msg err'; }
  };

  function inferSimpleDraft(workflow) {
    const draft = freshDraft();
    const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
    draft.name = workflow.name || '';
    draft.description = workflow.description || '';
    const options = normalizedOptions(workflow.execution_options);
    draft.pace = options.pace;
    draft.lock_portrait = options.lock_portrait;
    if (steps.some(step => step.type === 'DEVICE_STABILIZE')) draft.kind = 'maintenance';
    else if (steps.some(step => step.type === 'OPEN_WEB_SEARCH')) {
      draft.kind = 'web_read'; draft.search_topic = steps.find(step => step.type === 'OPEN_WEB_SEARCH')?.query || '';
    } else {
      draft.kind = 'app_browse'; draft.package_name = steps.find(step => step.type === 'OPEN_APP')?.package_name || draft.package_name;
    }
    draft.scroll_count = Number(steps.find(step => step.type === 'REPEAT_SCROLL')?.count || 0);
    const waits = steps.filter(step => step.type === 'WAIT').map(step => Number(step.duration || 0)).filter(value => value >= 10000);
    if (waits.length) draft.active_seconds = Math.round(Math.max(...waits) / 1000);
    draft.return_to_original = steps.some(step => step.type === 'RESTORE_FOREGROUND_APP');
    return draft;
  }

  function sameExactShape(actual, expected) {
    if (actual === expected) return true;
    if (Array.isArray(actual) || Array.isArray(expected)) {
      return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length && actual.every((value, index) => sameExactShape(value, expected[index]));
    }
    if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') return false;
    const actualKeys = Object.keys(actual).sort();
    const expectedKeys = Object.keys(expected).sort();
    return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index] && sameExactShape(actual[key], expected[key]));
  }

  function isCanonicalSimpleWorkflow(workflow, draft) {
    if (!Array.isArray(workflow.steps)) return false;
    if (Array.isArray(workflow.parameter_schema) && workflow.parameter_schema.length) return false;
    return sameExactShape(workflow.steps, buildStepsForDraft(draft));
  }

  function targetPlanForSave(ids) {
    if (!simpleEditingId) return simpleTargetMode === 'none'
      ? { include: true, ids: [], confirmation: null }
      : { include: true, ids, error: ids.length ? null : 'Selecciona dispositivos o elige Guardar sin dispositivos.' };
    if (simpleTargetMode === 'preserve') return { include: false, ids: simpleSavedTargets.map(target => target.id), confirmation: null };
    if (simpleTargetMode === 'replace') return {
      include: true, ids,
      error: ids.length ? null : 'Selecciona al menos un dispositivo para reemplazar los destinos.',
      confirmation: `Reemplazar los destinos guardados [${simpleSavedTargets.map(target => target.id).join(', ') || 'ninguno'}] por la selección actual [${ids.join(', ')}]?`,
    };
    if (simpleTargetMode === 'clear') return { include: true, ids: [], confirmation: `Quitar todos los destinos guardados de esta rutina?\n\nSe enviará device_ids: [] de forma intencional.` };
    return { include: false, ids: simpleSavedTargets.map(target => target.id), confirmation: null };
  }

  window.srSave = async function (runAfterSave) {
    const name = String(byId('srName')?.value || '').trim();
    const description = String(byId('srDescription')?.value || '').trim();
    const ids = selectedIds();
    const msg = byId('srMessage');
    simpleDraft.name = name; simpleDraft.description = description;
    if (!simpleSourceCanonical && !simpleConversionApproved) { msg.textContent = 'Esta rutina avanzada está protegida. Ábrela en Avanzado o conviértela explícitamente.'; msg.className = 'sr-msg err'; return; }
    if (!name) { msg.textContent = 'Escribe un nombre para la rutina.'; msg.className = 'sr-msg err'; return; }
    if (simpleDraft.kind === 'web_read' && !String(simpleDraft.search_topic || '').trim()) { msg.textContent = 'Escribe el tema que se buscará.'; msg.className = 'sr-msg err'; return; }
    if (runAfterSave && !ids.length) { msg.textContent = 'Selecciona uno o más dispositivos antes de ejecutar.'; msg.className = 'sr-msg err'; return; }
    const targetPlan = targetPlanForSave(ids);
    if (targetPlan.error) { msg.textContent = targetPlan.error; msg.className = 'sr-msg err'; return; }
    if (targetPlan.confirmation && !confirm(targetPlan.confirmation)) { msg.textContent = 'Cambio de destinos cancelado.'; msg.className = 'sr-msg err'; return; }
    const payload = {
      name, description, steps: buildSteps(), parameter_schema: [],
      execution_options: executionOptionsFromSimple(),
    };
    if (targetPlan.include) payload.device_ids = targetPlan.ids;
    try {
      let workflow;
      if (simpleEditingId) workflow = (await apiFetch(`/workflows/${simpleEditingId}`, { method: 'PUT', body: JSON.stringify({ ...payload, status: 'active' }) })).data;
      else {
        workflow = (await apiFetch('/workflows', { method: 'POST', body: JSON.stringify(payload) })).data;
        await apiFetch(`/workflows/${workflow.id}`, { method: 'PUT', body: JSON.stringify({ status: 'active', execution_options: payload.execution_options }) });
        simpleEditingId = workflow.id;
      }
      if (targetPlan.include) simpleSavedTargets = targetPlan.ids.map(id => {
        try { const device = devices.find(item => Number(item.id) === Number(id)); return { id: Number(id), name: device?.name, serial_number: device?.serial_number }; }
        catch (_) { return { id: Number(id) }; }
      });
      simpleTargetMode = 'preserve';
      simpleConversionApproved = false;
      msg.textContent = 'Guardada y activada.'; msg.className = 'sr-msg ok';
      await refreshSimpleWorkflowList();
      if (runAfterSave) {
        if (!confirm(`Ejecutar “${name}” ahora en ${ids.length} dispositivo(s)?`)) return;
        const response = await apiFetch(`/workflows/${simpleEditingId}/execute`, { method: 'POST', body: JSON.stringify({ device_ids: ids, params: {}, execution_options: payload.execution_options }) });
        msg.textContent = `▶ ${response.message || 'Rutina iniciada'}`; msg.className = 'sr-msg ok';
      }
    } catch (error) { msg.textContent = `Error: ${error.message}`; msg.className = 'sr-msg err'; }
  };

  function wrapRoutineButtons() {
    if (typeof window.openRoutineBuilder === 'function' && !window.openRoutineBuilder._simpleWrapped) {
      const originalOpen = window.openRoutineBuilder;
      const wrapped = async function (...args) { const result = await originalOpen.apply(this, args); patchOverlay(); await srShowSimple(); return result; };
      wrapped._simpleWrapped = true;
      window.openRoutineBuilder = wrapped;
    }
    if (typeof window.rtNewRoutine === 'function' && !window.rtNewRoutine._paceWrapped) {
      const originalNew = window.rtNewRoutine;
      const wrappedNew = function (...args) { advancedOptions = { ...PACE_PRESETS.careful }; const result = originalNew.apply(this, args); queueMicrotask(installAdvancedControls); return result; };
      wrappedNew._paceWrapped = true; window.rtNewRoutine = wrappedNew;
    }
    if (typeof window.rtLoadTemplate === 'function' && !window.rtLoadTemplate._paceWrapped) {
      const originalTemplate = window.rtLoadTemplate;
      const wrappedTemplate = function (...args) { advancedOptions = { ...PACE_PRESETS.careful }; const result = originalTemplate.apply(this, args); queueMicrotask(installAdvancedControls); return result; };
      wrappedTemplate._paceWrapped = true; window.rtLoadTemplate = wrappedTemplate;
    }
  }

  function initialize() {
    installStyles();
    wrapWorkflowApi();
    wrapRoutineButtons();
    const observer = new MutationObserver(() => { if (byId('routinesOverlay')) patchOverlay(); });
    observer.observe(document.body, { childList: true, subtree: true });
    patchOverlay();
  }

  initialize();
})();
