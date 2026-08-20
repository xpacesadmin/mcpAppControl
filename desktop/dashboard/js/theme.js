(function initializeColorTheme() {
    'use strict';

    const STORAGE_KEY = 'mcp_color_theme';
    const DARK = 'dark';
    const LIGHT = 'light';

    function savedTheme() {
        return localStorage.getItem(STORAGE_KEY) === LIGHT ? LIGHT : DARK;
    }

    function updateThemeControl(theme) {
        const dark = theme === DARK;
        const button = document.getElementById('themeToggle');
        const icon = document.getElementById('themeToggleIcon');
        const label = document.getElementById('themeToggleLabel');
        if (button) {
            button.setAttribute('aria-checked', String(dark));
            button.setAttribute('title', dark ? 'Desactivar modo oscuro' : 'Activar modo oscuro');
        }
        if (icon) icon.textContent = dark ? '🌙' : '☀️';
        if (label) label.textContent = dark ? 'Oscuro' : 'Claro';
    }

    function applyColorTheme(theme, persist) {
        const normalized = theme === LIGHT ? LIGHT : DARK;
        document.documentElement.dataset.theme = normalized;
        document.documentElement.style.colorScheme = normalized;
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', normalized === DARK ? '#0f172a' : '#4f46e5');
        if (persist !== false) localStorage.setItem(STORAGE_KEY, normalized);
        updateThemeControl(normalized);
        return normalized;
    }

    window.toggleColorTheme = function toggleColorTheme() {
        const current = document.documentElement.dataset.theme === LIGHT ? LIGHT : DARK;
        applyColorTheme(current === DARK ? LIGHT : DARK, true);
    };
    window.applyColorTheme = applyColorTheme;

    applyColorTheme(savedTheme(), false);
    document.addEventListener('DOMContentLoaded', function () {
        applyColorTheme(savedTheme(), false);
    });
})();
