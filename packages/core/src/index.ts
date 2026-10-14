/**
 * @nekko-agent/core, the pure-TS engine behind Nekko Agent. No Electron imports, so it
 * is unit-testable and could be reused in a CLI or server. The Electron main
 * process wires these modules to the filesystem, shell, and IPC.
 */

export * from './providers/index.js';
export * from './capacity/index.js';
export * from './readiness/index.js';
export * from './agent/loop.js';
export * from './agent/runaway.js';
export * from './agent/progress.js';
export * from './agent/resume.js';
export * from './agent/fit.js';
export * from './agent/tools.js';
export * from './agent/prompt.js';
export * from './guardrails/classifier.js';
export * from './guardrails/rules.js';
export * from './context/assembler.js';
export * from './indexer/index.js';
export * from './memory/store.js';
export * from './connectors/index.js';
export * from './connectors/actions.js';
