(function () {
  function selectedDevice() {
    const ids = [...selectedDeviceIds];
    if (ids.length !== 1) {
      alert('Selecciona exactamente un dispositivo para controles de ruta o cuenta.');
      return null;
    }
    return devices.find(device => Number(device.id) === Number(ids[0])) || null;
  }

  function operationKey(action, deviceId) {
    const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `desktop-${action}-device-${deviceId}-${suffix}`;
  }

  async function assignedRoute(deviceId) {
    const response = await apiFetch('/proxy-routes');
    return (response.data || []).find(route => Number(route.assigned_device_id) === Number(deviceId)) || null;
  }

  window.fleetProxyGoDirect = async () => {
    const device = selectedDevice();
    if (!device) return;
    if (!confirm(`Quitar la ruta asignada y dejar ${device.name || device.serial_number} SIN proxy global?`)) return;
    try {
      await apiFetch(`/devices/${device.id}/proxy-control/direct`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true, idempotency_key: operationKey('proxy-direct', device.id) }),
      });
      addLog(`✓ ${device.name || device.serial_number}: proxy global desactivado`, 'info');
      await loadAll();
    } catch (error) { addLog(`Error quitando proxy: ${error.message}`, 'error'); }
  };

  window.fleetProxyApplyRoute = async () => {
    const device = selectedDevice();
    if (!device) return;
    try {
      const current = await assignedRoute(device.id);
      const routeId = await customPrompt('Aplicar ruta dedicada', 'Route ID:', current?.route_id || 'fleet60-fleet1-dc01');
      if (!routeId || !routeId.trim()) return;
      if (current?.route_id === routeId.trim()) return alert(`La ruta ${routeId.trim()} ya está asignada.`);
      if (current && !confirm(`Cambiar ${current.route_id} por ${routeId.trim()}?`)) return;
      await apiFetch(`/proxy-routes/${encodeURIComponent(routeId.trim())}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          device_id: device.id,
          expected_previous_route_id: current?.route_id || null,
          confirm: true,
          idempotency_key: operationKey('proxy-assign', device.id),
        }),
      });
      addLog(`✓ ${device.name || device.serial_number}: ruta ${routeId.trim()} aplicada`, 'info');
      await loadAll();
    } catch (error) { addLog(`Error aplicando ruta: ${error.message}`, 'error'); }
  };

  window.fleetProxyVerifyRoute = async () => {
    const device = selectedDevice();
    if (!device) return;
    try {
      const current = await assignedRoute(device.id);
      if (!current) throw new Error('El dispositivo no tiene una ruta dedicada activa');
      const response = await apiFetch(`/proxy-routes/${encodeURIComponent(current.route_id)}/verify-device-egress`, {
        method: 'POST',
        body: JSON.stringify({ device_id: device.id, confirm: true, idempotency_key: operationKey('proxy-verify', device.id) }),
      });
      addLog(`✓ Egreso verificado: ${response.data?.observed_public_ip || 'IP esperada'}`, 'info');
    } catch (error) { addLog(`Error verificando ruta: ${error.message}`, 'error'); }
  };

  window.startGoogleEnrollment = async () => {
    const device = selectedDevice();
    if (!device) return;
    if (!confirm('Abrir el alta nativa de Google? Las credenciales se introducen únicamente en el teléfono.')) return;
    try {
      await apiFetch(`/devices/${device.id}/google-accounts/enrollment/start`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true, idempotency_key: operationKey('google-enroll', device.id) }),
      });
      addLog(`✓ Alta Google abierta en ${device.name || device.serial_number}; completa el inicio de sesión en TikMatrix`, 'info');
    } catch (error) { addLog(`Error abriendo alta Google: ${error.message}`, 'error'); }
  };

  window.verifyGoogleEnrollment = async () => {
    const device = selectedDevice();
    if (!device) return;
    try {
      const response = await apiFetch(`/devices/${device.id}/google-accounts/enrollment/verify`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true, idempotency_key: operationKey('google-verify', device.id) }),
      });
      const data = response.data || {};
      addLog(data.enrollment_verified ? `✓ Cuenta Google verificada (${data.google_account_count})` : `Cuenta Google aún no detectada (${data.google_account_count})`, data.enrollment_verified ? 'info' : 'warning');
    } catch (error) { addLog(`Error verificando cuenta Google: ${error.message}`, 'error'); }
  };

  window.toggleGoogleRotation = async () => {
    const device = selectedDevice();
    if (!device) return;
    try {
      const current = (await apiFetch(`/devices/${device.id}/google-accounts`)).data || {};
      const enabled = !current.rotation_allowed;
      await apiFetch(`/devices/${device.id}/google-accounts/rotation`, {
        method: 'PUT',
        body: JSON.stringify({ enabled, confirm: true, idempotency_key: operationKey('google-rotation-policy', device.id) }),
      });
      addLog(`✓ Rotación Google ${enabled ? 'permitida' : 'bloqueada'} para ${device.name || device.serial_number}`, 'info');
    } catch (error) { addLog(`Error cambiando rotación Google: ${error.message}`, 'error'); }
  };

  window.openGoogleRotation = async () => {
    const device = selectedDevice();
    if (!device) return;
    try {
      await apiFetch(`/devices/${device.id}/google-accounts/rotation/open`, {
        method: 'POST',
        body: JSON.stringify({ confirm: true, idempotency_key: operationKey('google-rotation-open', device.id) }),
      });
      addLog('✓ Selector nativo de cuentas Google abierto; completa la rotación en el teléfono', 'info');
    } catch (error) { addLog(`No se pudo abrir la rotación: ${error.message}`, 'warning'); }
  };

  function installControls() {
    const panel = document.getElementById('actionSubTab-adb');
    if (!panel || document.getElementById('fleetLabControls')) return;
    const controls = document.createElement('div');
    controls.id = 'fleetLabControls';
    controls.style.cssText = 'grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;border-top:1px solid var(--border-color);padding-top:10px;margin-top:4px';
    controls.innerHTML = `
      <button class="action-btn blue" onclick="fleetProxyApplyRoute()">🌐 Aplicar ruta</button>
      <button class="action-btn blue" onclick="fleetProxyGoDirect()">⏸️ Sin proxy</button>
      <button class="action-btn blue" onclick="fleetProxyVerifyRoute()">✅ Verificar ruta</button>
      <button class="action-btn blue" onclick="startGoogleEnrollment()">📧 Agregar Gmail</button>
      <button class="action-btn blue" onclick="verifyGoogleEnrollment()">🔎 Verificar Gmail</button>
      <button class="action-btn blue" onclick="toggleGoogleRotation()">🔄 Permitir rotación</button>
      <button class="action-btn blue" style="grid-column:1/-1" onclick="openGoogleRotation()">👥 Abrir rotación Google</button>`;
    panel.appendChild(controls);
  }

  document.addEventListener('DOMContentLoaded', installControls);
})();
