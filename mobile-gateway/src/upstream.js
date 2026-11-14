'use strict';

const fs = require('node:fs');

class UpstreamError extends Error {
  constructor(message, status = 502, code = 'upstream_error') {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
  }
}

function tokenFromFile(filePath) {
  return () => {
    const value = fs.readFileSync(filePath, 'utf8').trim();
    if (!value) throw new UpstreamError('Desktop API credential is unavailable', 503, 'upstream_unavailable');
    return value;
  };
}

class DesktopClient {
  constructor({ baseUrl, tokenProvider, timeoutMs = 5000, fetchImpl = globalThis.fetch }) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.baseUrl = baseUrl;
    this.tokenProvider = tokenProvider;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  async #request(path, options = {}) {
    if (!/^\/[A-Za-z0-9?&=._~%/-]*$/.test(path) || path.includes('..')) {
      throw new Error('Unsafe internal desktop path');
    }
    const token = this.tokenProvider();
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: options.method || 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError('Desktop API is unavailable', 503, 'upstream_unavailable');
    }
    let payload;
    try { payload = await response.json(); }
    catch (_) { throw new UpstreamError('Desktop API returned an invalid response'); }
    if (!response.ok || payload?.success === false) {
      const status = response.status >= 400 && response.status < 500 ? 422 : 502;
      throw new UpstreamError('Desktop API rejected the mapped operation', status, 'upstream_rejected');
    }
    return payload?.data;
  }

  getLabStatus() { return this.#request('/lab/status'); }
  getDashboardStats() { return this.#request('/dashboard/stats'); }
  getTaskStats() { return this.#request('/tasks/stats'); }
  getRoutes() { return this.#request('/proxy-routes'); }
  getAccountInventory() { return this.#request('/accounts/inventory'); }
  getAntiIdle() { return this.#request('/anti-idle'); }

  async getDevices() {
    const result = [];
    let page = 1;
    do {
      const payload = await this.#request(`/devices?page=${page}&per_page=200`);
      const rows = Array.isArray(payload?.data) ? payload.data : [];
      result.push(...rows);
      const lastPage = Math.max(1, Number(payload?.last_page) || 1);
      if (page >= lastPage) break;
      page += 1;
      if (page > 100) throw new UpstreamError('Desktop device pagination exceeded safety limit');
    } while (true);
    return result;
  }

  async getRecentTasks(limit = 25) {
    const payload = await this.#request(`/tasks?page=1&per_page=${Math.min(100, Math.max(1, Number(limit) || 25))}`);
    return Array.isArray(payload?.data) ? payload.data : [];
  }

  async getNotifications() {
    const payload = await this.#request('/notifications');
    return Array.isArray(payload?.notifications) ? payload.notifications : [];
  }

  getAudit(limit = 50) {
    return this.#request(`/lab/audit?limit=${Math.min(100, Math.max(1, Number(limit) || 50))}`);
  }

  dispatchDeviceCommand(deviceIds, command, params) {
    return this.#request('/devices/batch-command', {
      method: 'POST',
      body: { device_ids: deviceIds, command, params },
    });
  }

  stopTasks(deviceIds) {
    return this.#request('/tasks/stop', { method: 'POST', body: { device_ids: deviceIds } });
  }

  startAntiIdle(input) {
    return this.#request('/anti-idle/start', { method: 'POST', body: input });
  }

  stopAntiIdle(input) {
    return this.#request('/anti-idle/stop', { method: 'POST', body: input });
  }

  emergencyStop(input) {
    return this.#request('/lab/emergency-stop', { method: 'POST', body: input });
  }

  resume(input) {
    return this.#request('/lab/resume', { method: 'POST', body: input });
  }
}

module.exports = { DesktopClient, UpstreamError, tokenFromFile };

