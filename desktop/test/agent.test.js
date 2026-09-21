'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
