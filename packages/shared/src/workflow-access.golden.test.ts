import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandAllowed, tokenizeCommand, workflowDisabledTools, workflowToolDecision } from './workflow-access.js';

/**
 * The cases the daemon's port (crates/nekko-turn/src/workflow_access.rs) is
 * checked against too: both copies must give these answers.
 */
const shared = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'crates', 'nekko-turn', 'tests', 'golden', 'workflow-access.json'), 'utf8'));

describe('shared cases with the daemon', () => {
  it('tokenizes, matches, disables and decides alike', () => {
    for (const c of shared.tokens) expect(tokenizeCommand(c.command)).toEqual(c.words);
    for (const c of shared.matches) expect(commandAllowed(c.command, c.allowed)).toEqual(c.verdict);
    for (const c of shared.disabled) expect(workflowDisabledTools(c.access ?? undefined, c.allowed ?? undefined)).toEqual(c.disabled);
    for (const c of shared.decisions) expect(workflowToolDecision(c.session, c.call)).toEqual(c.decision);
  });
});
