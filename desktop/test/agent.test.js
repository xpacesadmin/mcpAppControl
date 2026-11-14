'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const agent = require('../adb/agent');

test('default UI-agent policy contains only XSAlpha packages', () => {
  assert.deepEqual(
    agent.AGENTES_POR_DEFECTO.map(candidate => ({
      package: candidate.paquete,
      port: candidate.puertoRemoto,
      own: candidate.propio,
    })),
    [
      { package: 'dev.mcp.agent', port: 9009, own: true },
      { package: 'dev.mcp.agent.debug', port: 9009, own: true },
    ],
  );
  assert.equal(agent.AGENTES_POR_DEFECTO.some(candidate =>
    candidate.paquete === 'com.github.tikmatrix' || candidate.propio === false), false);
});

test('accessibility parser recognizes a bound XSAlpha service', () => {
  const dump = `
User state[0]
  Bound services:{
    Service[label=XSAlpha, componentName=dev.mcp.agent.debug/dev.mcp.agent.AgentAccessibilityService]
  }
  Enabled services:{dev.mcp.agent.debug/dev.mcp.agent.AgentAccessibilityService}
`;

  assert.deepEqual(agent.accessibilityRuntimeState(dump, 'dev.mcp.agent.debug'), {
    bound: true,
    uiAutomation: false,
  });
});

test('accessibility parser reports external UiAutomation separately from binding', () => {
  const dump = `
User state[0]
  Bound services:{}
  Ui Automation[service=android.accessibilityservice.IAccessibilityServiceClient]
`;

  assert.deepEqual(agent.accessibilityRuntimeState(dump, 'dev.mcp.agent.debug'), {
    bound: false,
    uiAutomation: true,
  });
});

test('accessibility parser recognizes Samsung packageName-format bound service only in bound section', () => {
  const bound = `
installed services: { 5 : dev.mcp.agent.debug/dev.mcp.agent.MCPAccessibilityService }
enabled services: { 0 : dev.mcp.agent.debug/dev.mcp.agent.MCPAccessibilityService }
bound services:{
1 - Service[label=XSAlpha Agent, packageName=dev.mcp.agent.debug, feedbackType[FEEDBACK_GENERIC]]
}`;
  assert.deepEqual(agent.accessibilityRuntimeState(bound, 'dev.mcp.agent.debug'), {
    bound: true,
    uiAutomation: false,
  });
  assert.equal(agent.accessibilityRuntimeState(bound.replace('bound services:{\n1 - Service[label=XSAlpha Agent, packageName=dev.mcp.agent.debug, feedbackType[FEEDBACK_GENERIC]]\n}', 'bound services:{}'), 'dev.mcp.agent.debug').bound, false);
});

test('readiness summary exposes only bounded non-screen agent state', () => {
  const summary = agent._readinessSummary({
    instalado: 'dev.mcp.agent.debug',
    version: '2.1.2-lab-debug',
    accesibilidad: true,
    accesibilidad_vinculada: true,
    ui_automation_activa: false,
    listo: true,
    screen_text: 'must not escape',
    account_email: 'must-not-escape@example.test',
  }, true);

  assert.deepEqual(summary, {
    installed: true,
    version: '2.1.2-lab-debug',
    accessibility_enabled: true,
    accessibility_bound: true,
    external_ui_automation: false,
    endpoint_reachable: true,
    ready: true,
  });
  assert.equal(JSON.stringify(summary).includes('must not escape'), false);
  assert.equal(JSON.stringify(summary).includes('example.test'), false);
});

test('dashboard rollout uses install-if-missing and confirms every install command', () => {
  const dashboard = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'js', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard', 'index.html'), 'utf8');
  const readinessBlock = dashboard.slice(
    dashboard.indexOf('async function checkAgentReadiness()'),
    dashboard.indexOf('function showInputModal(', dashboard.indexOf('async function checkAgentReadiness()')),
  );

  for (const command of ['INSTALL_APK', 'INSTALL_AGENT_IF_MISSING', 'INSTALL_AGENT', 'TIKTOK_INSTALL_AGENT']) {
    assert.match(dashboard, new RegExp(`['"]${command}['"]`));
  }
  assert.match(html, /quickAction\('INSTALL_AGENT_IF_MISSING'\)/);
  assert.doesNotMatch(html, /quickAction\('INSTALL_AGENT'\)/);
  assert.match(readinessBlock, /command: 'AGENT_PING'/);
  assert.doesNotMatch(readinessBlock, /command: 'AGENT_STATUS'/);
  for (const field of ['installed', 'version', 'accessibility_enabled', 'accessibility_bound', 'external_ui_automation', 'endpoint_reachable', 'ready']) {
    assert.match(readinessBlock, new RegExp(`state\\.${field}\\b`));
  }
  assert.match(readinessBlock, /sesión UiAutomation externa activa/);
  assert.doesNotMatch(readinessBlock, /TikMatrix ocupa UiAutomation/);
});
