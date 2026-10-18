const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkSandboxSyntax } = require('./check-sandbox-syntax.cjs');

test('rejects the nested quote regression without launching Electron', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nekko-syntax-'));
  try {
    const file = path.join(dir, 'sandbox.cjs');
    fs.writeFileSync(file, "async function main() { await run('window.integration.inbox('Reply while sleeping')'); }");
    assert.throws(() => checkSandboxSyntax(file), /SyntaxError/);
    fs.writeFileSync(file, `async function main() { await run("window.integration.inbox('Reply while sleeping')"); }`);
    assert.doesNotThrow(() => checkSandboxSyntax(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tracked subagent launchers and sandboxes parse', () => {
  for (const file of ['subagent-integration.cjs', 'subagent-sandbox.cjs', 'subagent-component-integration.cjs', 'subagent-component-sandbox.cjs']) {
    assert.doesNotThrow(() => checkSandboxSyntax(path.join(__dirname, file)));
  }
});

test('repository action launcher and sandbox parse without launching Electron', () => {
  for (const file of ['agent-sidebar-integration.cjs', 'repo-actions-sandbox.cjs', '../e2e/electron-main.cjs']) {
    assert.doesNotThrow(() => checkSandboxSyntax(path.join(__dirname, file)));
  }
});
