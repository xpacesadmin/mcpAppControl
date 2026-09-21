(function () {
    'use strict';

    const DEFAULT_PACKAGES = ['com.google.android.gm', 'com.google.android.youtube', 'com.zhiliaoapp.musically'];
    const BASE_CATALOG = [
        { name: 'Gmail', pkg: 'com.google.android.gm' },
        { name: 'YouTube', pkg: 'com.google.android.youtube' },
        { name: 'TikTok', pkg: 'com.zhiliaoapp.musically' },
        { name: 'Spotify', pkg: 'com.spotify.music' },
        { name: 'Instagram', pkg: 'com.instagram.android' },
        { name: 'Facebook', pkg: 'com.facebook.katana' },
        { name: 'Chrome', pkg: 'com.android.chrome' },
        { name: 'Play Store', pkg: 'com.android.vending' },
        { name: 'Ajustes', pkg: 'com.android.settings' },
    ];

    let formDirty = false;
    let formLoaded = false;
    let selectedPackages = new Set(DEFAULT_PACKAGES);
    let extraPackages = new Set();
    let availability = new Map();
    let lastScanSize = 0;
    let lastScanSuccessful = 0;
    let lastScanFailed = 0;
    let lastScanKey = '';
    let appFilter = '';

    const element = id => document.getElementById(id);

    function selectedIds() {
        try { return [...selectedDeviceIds].map(Number).filter(Number.isInteger); }
        catch (_) { return []; }
    }

    function installCompactPanel() {
        const host = element('actionSubTab-antiidle');
        if (!host || host.dataset.compactUi === 'true') return;
        host.dataset.compactUi = 'true';
        host.classList.add('anti-idle-panel');
        host.innerHTML = `
            <div id="antiIdleStatus" class="anti-idle-status">Consultando…</div>
            <div id="antiIdleConfiguredDevices" class="sub-tab-hint anti-idle-scope">Aún no hay dispositivos configurados.</div>
            <section class="anti-idle-card">
              <div class="anti-idle-card-head">
                <div><strong>1. Apps del ciclo</strong><small>Elige entre 2 y 5 apps.</small></div>
                <button type="button" class="anti-idle-link" onclick="scanAntiIdleApps()">🔎 Escanear apps instaladas</button>
              </div>
              <details id="antiIdleAppPicker" class="anti-idle-app-picker">
                <summary><span id="antiIdleAppsSummary">Seleccionar apps</span><span aria-hidden="true">⌄</span></summary>
                <input id="antiIdleAppSearch" class="anti-idle-app-search" type="search" placeholder="Buscar por nombre o paquete…" aria-label="Buscar apps instaladas">
                <div id="antiIdleAppOptions" class="anti-idle-app-options"></div>
                <div class="anti-idle-custom-row">
                  <input id="antiIdleCustomPackage" type="text" placeholder="Paquete adicional, p. ej. com.ejemplo.app" aria-label="Paquete Android adicional">
                  <button type="button" class="anti-idle-link" onclick="addAntiIdleCustomPackage()">+ Añadir</button>
                </div>
                <p id="antiIdleAppsScanStatus" class="rt-hint">El escaneo es de solo lectura y comprueba únicamente los dispositivos seleccionados.</p>
              </details>
            </section>
            <section class="anti-idle-card">
              <div class="anti-idle-card-head"><div><strong>2. Tiempos y comportamiento</strong><small>Opciones comunes, sin valores técnicos innecesarios.</small></div></div>
              <div class="anti-idle-timing-grid">
                <label>Actividad por ciclo<select id="antiIdleDuration"><option value="30">30 segundos</option><option value="45">45 segundos</option><option value="60">1 minuto</option><option value="90">1 min 30 s</option><option value="120" selected>2 minutos</option><option value="300">5 minutos</option></select></label>
                <label>Espera entre ciclos<select id="antiIdleWaitMinutes"><option value="2">2 minutos</option><option value="5" selected>5 minutos</option><option value="8">8 minutos</option><option value="10">10 minutos</option><option value="15">15 minutos</option><option value="30">30 minutos</option><option value="60">1 hora</option></select></label>
                <label>Ritmo de acciones<select id="antiIdlePace"><option value="careful" selected>Cuidadoso (recomendado)</option><option value="standard">Normal</option></select></label>
                <label>Espera entre desplazamientos<select id="antiIdleScrollCadence"><option value="4" selected>4 segundos</option><option value="6">6 segundos</option><option value="8">8 segundos</option><option value="10">10 segundos</option><option value="15">15 segundos</option></select></label>
                <label>Desplazamientos antes de pausa<select id="antiIdleScrollsBeforeDwell"><option value="1">1</option><option value="2">2</option><option value="3" selected>3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option></select></label>
                <label>Pausa de video en TikTok<select id="antiIdleVideoDwellSeconds"><option value="60">1 minuto</option><option value="120">2 minutos</option><option value="180" selected>3 minutos</option><option value="300">5 minutos</option></select></label>
              </div>
              <div class="anti-idle-checks">
                <label><input id="antiIdleNaturalScrolls" type="checkbox" checked> Deslizar hacia arriba (próximo contenido)</label>
                <label><input id="antiIdleLockPortrait" type="checkbox" checked> Mantener pantalla vertical</label>
              </div>
              <p class="rt-hint anti-idle-timing-note">TikTok hará una pausa larga después del número indicado de desplazamientos. Esa pausa puede extender una actividad configurada en 2 minutos.</p>
            </section>
            <button class="action-btn blue anti-idle-wide" onclick="saveAntiIdleConfiguration()">💾 Guardar para dispositivos seleccionados</button>
            <button class="action-btn" style="background:#15803d;color:#fff;font-weight:700" onclick="startAntiIdleMode()">▶ Activar</button>
            <button class="action-btn blue" onclick="runAntiIdleNow()">⚡ Ejecutar ahora</button>
            <button class="action-btn anti-idle-wide" style="background:#b91c1c;color:#fff;font-weight:700" onclick="stopAntiIdleMode()">⏹ Detener</button>
            <p class="sub-tab-hint">Solo abre las apps elegidas y, si está activo, desliza hacia arriba para avanzar contenido. No publica, cambia cuentas ni interactúa con contenido.</p>`;
        installStyles();
        renderAppOptions();
        ['antiIdleDuration', 'antiIdleWaitMinutes', 'antiIdlePace', 'antiIdleScrollCadence',
            'antiIdleScrollsBeforeDwell', 'antiIdleVideoDwellSeconds',
            'antiIdleNaturalScrolls', 'antiIdleLockPortrait']
            .forEach(id => element(id)?.addEventListener('input', markDirty));
        element('antiIdleAppSearch')?.addEventListener('input', event => {
            appFilter = String(event.target.value || '').trim().toLowerCase();
            renderAppOptions();
        });
    }

    function installStyles() {
        if (element('antiIdleCompactStyles')) return;
        const style = document.createElement('style');
        style.id = 'antiIdleCompactStyles';
        style.textContent = `
          .anti-idle-panel{align-content:start}.anti-idle-status,.anti-idle-scope,.anti-idle-card,.anti-idle-wide{grid-column:1/-1}.anti-idle-status{font-size:12px;color:#94a3b8;padding:4px 0}.anti-idle-card{border:1px solid var(--border-color,#e2e8f0);border-radius:12px;background:var(--panel-bg,#fff);padding:12px}.anti-idle-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.anti-idle-card-head strong{display:block;font-size:13px}.anti-idle-card-head small{display:block;color:var(--text-muted,#64748b);font-size:11px;margin-top:2px}.anti-idle-link{border:1px solid var(--border-color,#cbd5e1);background:var(--theme-surface-2,#f8fafc);color:var(--text-dark,#334155);border-radius:8px;padding:6px 9px;font-size:11.5px;font-weight:700;cursor:pointer}.anti-idle-app-picker>summary{display:flex;justify-content:space-between;align-items:center;cursor:pointer;padding:8px 10px;background:var(--theme-surface-2,#f8fafc);border-radius:8px;font-size:12.5px;font-weight:700;list-style:none}.anti-idle-app-picker>summary::-webkit-details-marker{display:none}.anti-idle-app-search{box-sizing:border-box;width:100%;margin-top:9px;padding:7px 9px;border:1px solid var(--border-color,#cbd5e1);border-radius:8px;background:var(--theme-input-bg,#fff);color:var(--theme-input-text,#111827)}.anti-idle-app-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin:9px 0;max-height:260px;overflow:auto}.anti-idle-app-option{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:7px;border:1px solid var(--border-color,#e2e8f0);border-radius:8px;padding:7px 8px;font-size:12px;cursor:pointer;min-width:0}.anti-idle-app-option span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.anti-idle-app-option small{font-size:10px;color:var(--text-muted,#64748b)}.anti-idle-app-option.partial small{color:#d97706}.anti-idle-custom-row{display:flex;gap:7px;margin-top:7px}.anti-idle-custom-row input{flex:1;min-width:0;padding:7px 9px;border:1px solid var(--border-color,#cbd5e1);border-radius:8px;background:var(--theme-input-bg,#fff);color:var(--theme-input-text,#111827)}.anti-idle-timing-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.anti-idle-timing-grid label{font-size:11.5px;font-weight:700;color:var(--text-dark,#334155)}.anti-idle-timing-grid select{display:block;width:100%;margin-top:4px;padding:7px 8px;border:1px solid var(--border-color,#cbd5e1);border-radius:8px}.anti-idle-checks{display:flex;gap:14px;flex-wrap:wrap;margin-top:11px}.anti-idle-checks label{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:650}.anti-idle-app-picker .rt-hint,.anti-idle-timing-note{margin:6px 1px 0}.anti-idle-link:focus-visible,.anti-idle-app-option:focus-within{outline:2px solid var(--primary,#6366f1);outline-offset:2px}@media(max-width:620px){.anti-idle-app-options,.anti-idle-timing-grid{grid-template-columns:1fr}}`;
        document.head.appendChild(style);
    }

    function markDirty() { formDirty = true; }

    function catalog() {
        const items = new Map(BASE_CATALOG.map(app => [app.pkg, app]));
        try {
            if (Array.isArray(APP_CATALOG)) APP_CATALOG.forEach(app => items.set(app.pkg, { name: app.name, pkg: app.pkg }));
        } catch (_) {}
        extraPackages.forEach(pkg => { if (!items.has(pkg)) items.set(pkg, { name: pkg, pkg }); });
        return [...items.values()];
    }

    function selectedDeviceKey(ids = selectedIds()) {
        return [...ids].map(Number).filter(Number.isInteger).sort((a, b) => a - b).join(',');
    }

    function renderAppOptions() {
        const box = element('antiIdleAppOptions');
        if (!box) return;
        box.replaceChildren();
        const visibleApps = catalog().filter(app => {
            if (!appFilter) return true;
            return app.name.toLowerCase().includes(appFilter) || app.pkg.toLowerCase().includes(appFilter);
        });
        visibleApps.forEach(app => {
            const label = document.createElement('label');
            label.className = 'anti-idle-app-option';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'anti-idle-app-check';
            checkbox.value = app.pkg;
            checkbox.checked = selectedPackages.has(app.pkg);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) selectedPackages.add(app.pkg); else selectedPackages.delete(app.pkg);
                markDirty(); updateAppsSummary();
            });
            const name = document.createElement('span');
            name.textContent = app.name;
            name.title = app.pkg;
            const state = document.createElement('small');
            if (availability.has(app.pkg)) {
                const count = availability.get(app.pkg);
                state.textContent = `${count}/${lastScanSize}`;
                if (count < lastScanSize) label.classList.add('partial');
            } else state.textContent = '—';
            label.append(checkbox, name, state);
            box.appendChild(label);
        });
        if (!visibleApps.length) {
            const empty = document.createElement('p');
            empty.className = 'rt-hint';
            empty.textContent = 'Ninguna app coincide con la búsqueda.';
            box.appendChild(empty);
        }
        updateAppsSummary();
    }

    function updateAppsSummary() {
        const summary = element('antiIdleAppsSummary');
        if (!summary) return;
        const names = catalog().filter(app => selectedPackages.has(app.pkg)).map(app => app.name);
        summary.textContent = names.length ? `${names.length} seleccionadas · ${names.join(', ')}` : 'Seleccionar apps';
    }

    function setSelectValue(id, value, suffix) {
        const select = element(id);
        if (!select) return;
        const wanted = String(value);
        if (![...select.options].some(option => option.value === wanted)) {
            const option = document.createElement('option');
            option.value = wanted;
            option.textContent = `${wanted}${suffix || ''} (guardado)`;
            select.appendChild(option);
        }
        select.value = wanted;
    }

    function nextLabel(value) {
        if (!value) return '—';
        const date = new Date(value.replace(' ', 'T') + 'Z');
        return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
    }

    function populateForm(state, force) {
        if (!force && (formDirty || formLoaded)) return;
        selectedPackages = new Set(state.package_names?.length ? state.package_names : DEFAULT_PACKAGES);
        selectedPackages.forEach(pkg => { if (!BASE_CATALOG.some(app => app.pkg === pkg)) extraPackages.add(pkg); });
        setSelectValue('antiIdleDuration', Number(state.action_duration_seconds || 120), ' segundos');
        setSelectValue('antiIdleWaitMinutes', Math.max(1, Math.round(Number(state.interval_seconds || 300) / 60)), ' minutos');
        setSelectValue('antiIdleScrollCadence', Number(state.gesture_interval_seconds || 4), ' segundos');
        setSelectValue('antiIdleScrollsBeforeDwell', Number(state.scrolls_before_dwell || 3), '');
        setSelectValue('antiIdleVideoDwellSeconds', Number(state.video_dwell_seconds || 180), ' segundos');
        element('antiIdlePace').value = state.pace === 'standard' ? 'standard' : 'careful';
        element('antiIdleNaturalScrolls').checked = state.natural_scrolls_enabled !== false;
        element('antiIdleLockPortrait').checked = state.lock_portrait !== false;
        renderAppOptions();
        formLoaded = true;
        formDirty = false;
    }

    function packagesFromForm() { return [...selectedPackages]; }
    function numberFromForm(id) { return Number(element(id)?.value); }
    function configurationSummary(state) {
        const scroll = state.natural_scrolls_enabled === false
            ? 'sin desplazamiento'
            : `deslizar arriba cada ${state.gesture_interval_seconds || 4} s; pausa tras ${state.scrolls_before_dwell || 3}`;
        const portrait = state.lock_portrait === false ? 'orientación libre' : 'vertical fija';
        const pace = state.pace === 'standard' ? 'ritmo normal' : 'ritmo cuidadoso';
        const dwell = state.package_names?.includes('com.zhiliaoapp.musically')
            ? ` · TikTok permanece ${state.video_dwell_seconds || 180} s`
            : '';
        return `${state.action_duration_seconds || 120} s por ciclo · espera ${Math.round((state.interval_seconds || 300) / 60)} min · ${pace} · ${scroll}${dwell} · ${portrait}`;
    }

    window.scanAntiIdleApps = async function () {
        const ids = selectedIds().sort((a, b) => a - b);
        const status = element('antiIdleAppsScanStatus');
        if (!ids.length) { status.textContent = 'Selecciona uno o más dispositivos para comprobar sus apps.'; return; }
        status.textContent = `Comprobando ${ids.length} dispositivos…`;
        try {
            const packages = catalog().map(app => app.pkg);
            const response = await apiFetch('/devices/batch-command', {
                method: 'POST',
                body: JSON.stringify({
                    device_ids: ids,
                    command: 'LIST_PACKAGES',
                    params: { packages, discover_launchable: true },
                }),
            });
            const rows = response.data?.results || [];
            const successful = rows.filter(row => row.success && row.data?.launchable_scan_ok !== false);
            const discovered = new Set();
            for (const row of successful) {
                for (const pkg of (row.data?.launchable || [])) {
                    if (/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(pkg)) discovered.add(pkg);
                }
            }
            discovered.forEach(pkg => {
                if (!BASE_CATALOG.some(app => app.pkg === pkg)) extraPackages.add(pkg);
            });
            availability = new Map(catalog().map(app => [app.pkg, 0]));
            for (const row of successful) {
                for (const pkg of (row.data?.launchable || [])) {
                    availability.set(pkg, (availability.get(pkg) || 0) + 1);
                }
            }
            lastScanSuccessful = successful.length;
            lastScanFailed = Math.max(0, ids.length - successful.length);
            lastScanSize = ids.length;
            lastScanKey = selectedDeviceKey(ids);
            renderAppOptions();
            const picker = element('antiIdleAppPicker');
            if (picker) picker.open = true;
            const failureNote = lastScanFailed ? ` · ${lastScanFailed} sin respuesta` : '';
            status.textContent = `${discovered.size} apps ejecutables encontradas · ${lastScanSuccessful}/${ids.length} dispositivos comprobados${failureNote}.`;
        } catch (error) { status.textContent = `No se pudo comprobar: ${error.message}`; }
    };

    window.addAntiIdleCustomPackage = function () {
        const input = element('antiIdleCustomPackage');
        const pkg = String(input?.value || '').trim();
        if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(pkg)) {
            alert('Escribe un nombre de paquete Android válido, por ejemplo com.ejemplo.app.'); return;
        }
        extraPackages.add(pkg); selectedPackages.add(pkg); input.value = ''; markDirty(); renderAppOptions();
    };

    window.refreshAntiIdleStatus = async function (forceForm = false) {
        const box = element('antiIdleStatus');
        if (!box) return null;
        try {
            const response = await apiFetch('/anti-idle');
            const state = response.data || {};
            const mode = state.running ? 'Ejecutando' : (state.enabled ? 'Activo' : 'Apagado');
            box.textContent = `${mode} · ${state.device_ids?.length || 0} dispositivos · ${configurationSummary(state)} · próximo: ${nextLabel(state.next_run_at)}`;
            box.style.color = state.running ? '#f59e0b' : (state.enabled ? '#22c55e' : '#94a3b8');
            const scope = element('antiIdleConfiguredDevices');
            if (scope) scope.textContent = state.device_ids?.length ? `Configurado para IDs: ${state.device_ids.join(', ')}` : 'Aún no hay dispositivos configurados.';
            populateForm(state, forceForm);
            return state;
        } catch (error) {
            box.textContent = `Estado no disponible: ${error.message}`; box.style.color = '#ef4444'; return null;
        }
    };

    window.saveAntiIdleConfiguration = async function () {
        const ids = selectedIds();
        if (!ids.length) { alert('Selecciona explícitamente los dispositivos ya enrolados antes de guardar.'); return false; }
        const packages = packagesFromForm();
        const duration = numberFromForm('antiIdleDuration');
        const waitMinutes = numberFromForm('antiIdleWaitMinutes');
        const cadence = numberFromForm('antiIdleScrollCadence');
        const scrollsBeforeDwell = numberFromForm('antiIdleScrollsBeforeDwell');
        const videoDwellSeconds = numberFromForm('antiIdleVideoDwellSeconds');
        const naturalScrolls = !!element('antiIdleNaturalScrolls')?.checked;
        const pace = element('antiIdlePace')?.value === 'standard' ? 'standard' : 'careful';
        const lockPortrait = !!element('antiIdleLockPortrait')?.checked;
        if (packages.length < 2 || packages.length > 5) { alert('Elige entre 2 y 5 apps.'); return false; }
        if (!Number.isInteger(duration) || duration < 10 || duration > 300) { alert('La ejecución debe durar entre 10 y 300 segundos.'); return false; }
        if (!Number.isInteger(waitMinutes) || waitMinutes < 1 || waitMinutes > 60) { alert('La espera debe ser entre 1 y 60 minutos.'); return false; }
        if (!Number.isInteger(cadence) || cadence < 3 || cadence > 15) { alert('El intervalo de desplazamiento debe ser entre 3 y 15 segundos.'); return false; }
        if (!Number.isInteger(scrollsBeforeDwell) || scrollsBeforeDwell < 1 || scrollsBeforeDwell > 6) { alert('Los desplazamientos antes de la pausa deben estar entre 1 y 6.'); return false; }
        if (!Number.isInteger(videoDwellSeconds) || videoDwellSeconds < 30 || videoDwellSeconds > 600) { alert('La pausa de video debe estar entre 30 y 600 segundos.'); return false; }
        const scanMatchesSelection = !!lastScanKey && lastScanKey === selectedDeviceKey(ids);
        const partial = scanMatchesSelection && packages.filter(pkg => (availability.get(pkg) || 0) < ids.length);
        const partialNote = partial.length ? `\n\nAviso: ${partial.length} app(s) no aparecen en todos los dispositivos seleccionados.` : '';
        const scanNote = scanMatchesSelection && lastScanFailed
            ? `\nAviso: ${lastScanFailed} dispositivo(s) no respondieron al último escaneo.`
            : '';
        if (!confirm(`Guardar anti-idle para ${ids.length} dispositivos?\n\n${duration} s por ciclo, espera ${waitMinutes} min, deslizar arriba cada ${cadence} s, pausa TikTok de ${videoDwellSeconds} s tras ${scrollsBeforeDwell} desplazamientos, pantalla ${lockPortrait ? 'vertical' : 'libre'}.${partialNote}${scanNote}`)) return false;
        try {
            await apiFetch('/anti-idle/config', {
                method: 'PUT',
                body: JSON.stringify({
                    confirm: true, device_ids: ids, package_names: packages,
                    interval_seconds: waitMinutes * 60, action_duration_seconds: duration,
                    gesture_interval_seconds: cadence, natural_scrolls_enabled: naturalScrolls,
                    scrolls_before_dwell: scrollsBeforeDwell, video_dwell_seconds: videoDwellSeconds,
                    pace, lock_portrait: lockPortrait,
                    idempotency_key: `anti-idle-ui-config-${Date.now()}`,
                }),
            });
            formDirty = false; formLoaded = false;
            addLog(`Configuración anti-idle guardada para ${ids.length} dispositivos`, 'info');
            await refreshAntiIdleStatus(true); return true;
        } catch (error) { addLog(`No se guardó anti-idle: ${error.message}`, 'error'); alert(error.message); return false; }
    };

    window.startAntiIdleMode = async function () {
        const state = await refreshAntiIdleStatus();
        if (!state?.device_ids?.length) { alert('Guarda primero la configuración con los dispositivos seleccionados.'); return; }
        if (formDirty) { alert('Hay cambios sin guardar. Usa Guardar antes de activar.'); return; }
        if (!confirm(`Activar anti-idle en ${state.device_ids.length} dispositivos?\n\n${configurationSummary(state)}. La primera ejecución comienza ahora.`)) return;
        try {
            await apiFetch('/anti-idle/start', { method: 'POST', body: JSON.stringify({ confirm: true, run_immediately: true, idempotency_key: `anti-idle-ui-start-${Date.now()}` }) });
            addLog(`Anti-idle activado en ${state.device_ids.length} dispositivos configurados`, 'info'); await refreshAntiIdleStatus();
        } catch (error) { addLog(`Anti-idle no se activó: ${error.message}`, 'error'); alert(error.message); }
    };

    window.stopAntiIdleMode = async function () {
        if (!confirm('¿Detener anti-idle? El ciclo activo se cancelará en el siguiente paso seguro.')) return;
        try {
            await apiFetch('/anti-idle/stop', { method: 'POST', body: JSON.stringify({ confirm: true, reason: 'operator stop from desktop', idempotency_key: `anti-idle-ui-stop-${Date.now()}` }) });
            addLog('Anti-idle detenido', 'info'); await refreshAntiIdleStatus();
        } catch (error) { addLog(`No se pudo detener anti-idle: ${error.message}`, 'error'); }
    };

    window.runAntiIdleNow = async function () {
        const state = await refreshAntiIdleStatus();
        if (!state?.enabled) { alert('Activa anti-idle antes de ejecutar un ciclo manual.'); return; }
        if (!confirm(`¿Ejecutar ahora un ciclo de ${state.action_duration_seconds} segundos?`)) return;
        try {
            await apiFetch('/anti-idle/run-now', { method: 'POST', body: JSON.stringify({ confirm: true, idempotency_key: `anti-idle-ui-now-${Date.now()}` }) });
            addLog('Ciclo anti-idle solicitado', 'info'); await refreshAntiIdleStatus();
        } catch (error) { addLog(`No se pudo ejecutar anti-idle: ${error.message}`, 'error'); }
    };

    function loadSimpleRoutineUi() {
        if (document.querySelector('script[data-xsalpha-simple-routines]')) return;
        const script = document.createElement('script');
        script.src = '/dashboard/js/routines-simple.js?v=20260828-v1';
        script.dataset.xsalphaSimpleRoutines = 'true';
        document.head.appendChild(script);
    }

    document.addEventListener('DOMContentLoaded', () => {
        installCompactPanel();
        loadSimpleRoutineUi();
        refreshAntiIdleStatus(true);
        setInterval(() => refreshAntiIdleStatus(false), 10000);
    });
})();
