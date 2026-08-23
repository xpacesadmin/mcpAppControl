(function () {
    const defaults = ['com.android.settings', 'com.android.vending', 'com.google.android.gm'];
    let formDirty = false;
    let formLoaded = false;

    function selectedIds() {
        return [...selectedDeviceIds].map(Number).filter(Number.isInteger);
    }

    function element(id) {
        return document.getElementById(id);
    }

    function nextLabel(value) {
        if (!value) return '—';
        const date = new Date(value.replace(' ', 'T') + 'Z');
        return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
    }

    function packagesFromForm() {
        return [...new Set(String(element('antiIdlePackages')?.value || '')
            .split(/[\n,]+/)
            .map(item => item.trim())
            .filter(Boolean))];
    }

    function numberFromForm(id) {
        return Number(element(id)?.value);
    }

    function populateForm(state, force = false) {
        if ((!force && (formDirty || formLoaded)) || !element('antiIdlePackages')) return;
        element('antiIdlePackages').value = (state.package_names?.length ? state.package_names : defaults).join('\n');
        element('antiIdleDuration').value = Number(state.action_duration_seconds || 45);
        element('antiIdleWaitMinutes').value = Math.max(1, Math.round(Number(state.interval_seconds || 480) / 60));
        element('antiIdleNaturalScrolls').checked = state.natural_scrolls_enabled !== false;
        element('antiIdleScrollCadence').value = Number(state.gesture_interval_seconds || 4);
        formLoaded = true;
        formDirty = false;
    }

    function configurationSummary(state) {
        const scroll = state.natural_scrolls_enabled === false
            ? 'scroll natural apagado'
            : `scroll natural cada ${state.gesture_interval_seconds || 4} s`;
        return `${state.action_duration_seconds || 45} s por ciclo · espera ${Math.round((state.interval_seconds || 480) / 60)} min · ${scroll}`;
    }

    window.refreshAntiIdleStatus = async function (forceForm = false) {
        const box = element('antiIdleStatus');
        if (!box) return;
        try {
            const response = await apiFetch('/anti-idle');
            const state = response.data || {};
            const mode = state.running ? 'Ejecutando' : (state.enabled ? 'Activo' : 'Apagado');
            box.textContent = `${mode} · ${state.device_ids?.length || 0} dispositivos · ${configurationSummary(state)} · próximo: ${nextLabel(state.next_run_at)}`;
            box.style.color = state.running ? '#f59e0b' : (state.enabled ? '#22c55e' : '#94a3b8');
            const scope = element('antiIdleConfiguredDevices');
            if (scope) scope.textContent = state.device_ids?.length
                ? `Configurado para IDs: ${state.device_ids.join(', ')}`
                : 'Aún no hay dispositivos configurados.';
            populateForm(state, forceForm);
            return state;
        } catch (error) {
            box.textContent = `Estado no disponible: ${error.message}`;
            box.style.color = '#ef4444';
            return null;
        }
    };

    window.saveAntiIdleConfiguration = async function () {
        const ids = selectedIds();
        if (!ids.length) {
            alert('Seleccione explícitamente los dispositivos ya enrolados antes de guardar.');
            return false;
        }
        const packages = packagesFromForm();
        const duration = numberFromForm('antiIdleDuration');
        const waitMinutes = numberFromForm('antiIdleWaitMinutes');
        const cadence = numberFromForm('antiIdleScrollCadence');
        const naturalScrolls = !!element('antiIdleNaturalScrolls')?.checked;
        if (packages.length < 2 || packages.length > 5) {
            alert('Ingrese entre 2 y 5 nombres de paquete Android.');
            return false;
        }
        if (!Number.isInteger(duration) || duration < 10 || duration > 300) {
            alert('La ejecución debe durar entre 10 y 300 segundos.');
            return false;
        }
        if (!Number.isInteger(waitMinutes) || waitMinutes < 1 || waitMinutes > 60) {
            alert('La espera debe ser entre 1 y 60 minutos.');
            return false;
        }
        if (!Number.isInteger(cadence) || cadence < 3 || cadence > 15) {
            alert('La cadencia de scroll debe ser entre 3 y 15 segundos.');
            return false;
        }
        if (!confirm(`Guardar anti-idle para ${ids.length} dispositivos seleccionados?\n\n${duration} s por ciclo, espera ${waitMinutes} min, scroll natural ${naturalScrolls ? 'activo' : 'apagado'}.`)) return false;
        try {
            await apiFetch('/anti-idle/config', {
                method: 'PUT',
                body: JSON.stringify({
                    confirm: true,
                    device_ids: ids,
                    package_names: packages,
                    interval_seconds: waitMinutes * 60,
                    action_duration_seconds: duration,
                    gesture_interval_seconds: cadence,
                    natural_scrolls_enabled: naturalScrolls,
                    idempotency_key: `anti-idle-ui-config-${Date.now()}`,
                }),
            });
            formDirty = false;
            formLoaded = false;
            addLog(`Configuración anti-idle guardada para ${ids.length} dispositivos`, 'info');
            await refreshAntiIdleStatus(true);
            return true;
        } catch (error) {
            addLog(`No se guardó anti-idle: ${error.message}`, 'error');
            alert(error.message);
            return false;
        }
    };

    window.startAntiIdleMode = async function () {
        const state = await refreshAntiIdleStatus();
        if (!state?.device_ids?.length) {
            alert('Guarde primero la configuración con los dispositivos seleccionados.');
            return;
        }
        if (formDirty) {
            alert('Hay cambios sin guardar. Use Guardar configuración antes de activar.');
            return;
        }
        if (!confirm(`Activar anti-idle en ${state.device_ids.length} dispositivos?\n\n${configurationSummary(state)}. La primera ejecución comienza ahora.`)) return;
        try {
            await apiFetch('/anti-idle/start', {
                method: 'POST',
                body: JSON.stringify({ confirm: true, run_immediately: true, idempotency_key: `anti-idle-ui-start-${Date.now()}` }),
            });
            addLog(`Anti-idle activado en ${state.device_ids.length} dispositivos configurados`, 'info');
            await refreshAntiIdleStatus();
        } catch (error) {
            addLog(`Anti-idle no se activó: ${error.message}`, 'error');
            alert(error.message);
        }
    };

    window.stopAntiIdleMode = async function () {
        if (!confirm('Detener anti-idle? El ciclo activo se cancelará en el siguiente paso seguro.')) return;
        try {
            await apiFetch('/anti-idle/stop', {
                method: 'POST',
                body: JSON.stringify({ confirm: true, reason: 'operator stop from desktop', idempotency_key: `anti-idle-ui-stop-${Date.now()}` }),
            });
            addLog('Anti-idle detenido', 'info');
            await refreshAntiIdleStatus();
        } catch (error) {
            addLog(`No se pudo detener anti-idle: ${error.message}`, 'error');
        }
    };

    window.runAntiIdleNow = async function () {
        const state = await refreshAntiIdleStatus();
        if (!state?.enabled) {
            alert('Active anti-idle antes de ejecutar un ciclo manual.');
            return;
        }
        if (!confirm(`Ejecutar ahora un ciclo de ${state.action_duration_seconds} segundos?`)) return;
        try {
            await apiFetch('/anti-idle/run-now', {
                method: 'POST',
                body: JSON.stringify({ confirm: true, idempotency_key: `anti-idle-ui-now-${Date.now()}` }),
            });
            addLog('Ciclo anti-idle solicitado', 'info');
            await refreshAntiIdleStatus();
        } catch (error) {
            addLog(`No se pudo ejecutar anti-idle: ${error.message}`, 'error');
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        ['antiIdlePackages', 'antiIdleDuration', 'antiIdleWaitMinutes', 'antiIdleNaturalScrolls', 'antiIdleScrollCadence']
            .forEach(id => element(id)?.addEventListener('input', () => { formDirty = true; }));
        refreshAntiIdleStatus(true);
        setInterval(() => refreshAntiIdleStatus(false), 10000);
    });
})();
