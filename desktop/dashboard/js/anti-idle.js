(function () {
    const defaults = ['com.android.settings', 'com.android.vending', 'com.google.android.gm'];

    function selectedIds() {
        return [...selectedDeviceIds].map(Number).filter(Number.isInteger);
    }

    function nextLabel(value) {
        if (!value) return '—';
        const date = new Date(value.replace(' ', 'T') + 'Z');
        return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
    }

    window.refreshAntiIdleStatus = async function () {
        const box = document.getElementById('antiIdleStatus');
        if (!box) return;
        try {
            const response = await apiFetch('/anti-idle');
            const state = response.data || {};
            const mode = state.running ? 'Ejecutando 45 s' : (state.enabled ? 'Activo' : 'Apagado');
            box.textContent = `${mode} · ${state.device_ids?.length || 0} dispositivos · próximo: ${nextLabel(state.next_run_at)}`;
            box.style.color = state.running ? '#f59e0b' : (state.enabled ? '#22c55e' : '#94a3b8');
        } catch (error) {
            box.textContent = `Estado no disponible: ${error.message}`;
            box.style.color = '#ef4444';
        }
    };

    window.startAntiIdleMode = async function () {
        const ids = selectedIds();
        if (!ids.length) {
            alert('Seleccione explícitamente los dispositivos ya enrolados. Anti-idle nunca usa selección implícita.');
            return;
        }
        let current = null;
        try { current = (await apiFetch('/anti-idle')).data; } catch (_) {}
        const value = await customPrompt(
            'Apps para anti-idle',
            'Ingrese de 2 a 5 nombres de paquete separados por coma. Solo se abrirán y desplazarán; no se harán likes, follows ni cambios de cuenta.',
            (current?.package_names || defaults).join(', '),
            defaults.join(', ')
        );
        if (value == null) return;
        const packages = [...new Set(String(value).split(',').map(item => item.trim()).filter(Boolean))];
        if (packages.length < 2 || packages.length > 5) {
            alert('Seleccione entre 2 y 5 paquetes.');
            return;
        }
        if (!confirm(`Activar anti-idle en ${ids.length} dispositivos seleccionados?\n\n45 s de actividad, luego 8 min de espera. La primera ejecución comienza ahora.`)) return;
        const stamp = Date.now();
        try {
            await apiFetch('/anti-idle/config', {
                method: 'PUT',
                body: JSON.stringify({
                    confirm: true,
                    device_ids: ids,
                    package_names: packages,
                    interval_seconds: 480,
                    action_duration_seconds: 45,
                    gesture_interval_seconds: 4,
                    idempotency_key: `anti-idle-ui-config-${stamp}`,
                }),
            });
            await apiFetch('/anti-idle/start', {
                method: 'POST',
                body: JSON.stringify({ confirm: true, run_immediately: true, idempotency_key: `anti-idle-ui-start-${stamp}` }),
            });
            addLog(`Anti-idle activado en ${ids.length} dispositivos seleccionados`, 'info');
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
        if (!confirm('Ejecutar ahora un ciclo anti-idle de 45 segundos en la selección configurada?')) return;
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
        refreshAntiIdleStatus();
        setInterval(refreshAntiIdleStatus, 10000);
    });
})();
