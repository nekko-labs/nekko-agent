import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  ASK_CANCELLED,
  ASK_UNATTENDED,
  CONNECTOR_CATALOG,
  DEFAULT_ACCENT,
  DEFAULT_ORCHESTRATION,
  DEFAULT_TURN_WRAPPER,
  LEGACY_ACCENTS,
  MARKET_SKILLS,
  MODEL_PRICING,
  OFFLINE_BLOCKED_AGENT_TOOLS,
  ORCHESTRATION_STRATEGIES,
  SKILLS,
  SPEC_METHODOLOGIES,
  TOOL_CATEGORY_OF,
  VAIZER_CATALOG_URL,
  VAIZER_REPO,
  VAIZER_SNAPSHOT,
  WORKFLOW_ACTIONS,
  workModePrompts,
} from './index.js';
import { MODEL_PRICING_SNAPSHOT } from './model-pricing-snapshot.js';

/**
 * Data the engine crates embed whose source is this package: the skills
 * catalog, the spec methodologies, the accents, model pricing, the turn
 * catalog's shared parts and the workflow catalog. Each crate file must hold
 * these keys exactly as this package defines them; its other keys are the
 * engine's own (recorded from the deleted TS engine) and are not checked here.
 * Fails when a crate copy is stale; UPDATE_GOLDEN=1 rewrites just these keys.
 */
const crates = join(__dirname, '..', '..', '..', 'crates');

function embedded(file: string, keys: Record<string, unknown>): void {
  const path = join(crates, file);
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const data = JSON.parse(text) as Record<string, unknown>;
  const want = JSON.parse(JSON.stringify(keys)) as Record<string, unknown>;
  if (process.env.UPDATE_GOLDEN) {
    const indent = /^\{\n( +)/.exec(text)?.[1].length ?? 2;
    writeFileSync(path, `${JSON.stringify({ ...data, ...want }, null, indent)}\n`);
    return;
  }
  for (const [key, value] of Object.entries(want)) expect(data[key], `${file}: ${key}`).toEqual(value);
}

describe('engine data from this package', () => {
  it('skills: the catalog, the built-ins and the Vaizer snapshot', () => {
    embedded('nekko-workspace/src/skills-data.json', {
      market: MARKET_SKILLS,
      builtin: SKILLS,
      builtinNames: SKILLS.map((s) => s.name),
      vaizerSnapshot: VAIZER_SNAPSHOT,
      vaizerCatalogUrl: VAIZER_CATALOG_URL,
      vaizerRepo: VAIZER_REPO,
    });
  });

  it('spec methodologies', () => {
    embedded('nekko-workspace/src/spec-data.json', { methodologies: SPEC_METHODOLOGIES });
  });

  it('accents', () => {
    embedded('nekko-settings/src/defaults.json', { defaultAccent: DEFAULT_ACCENT, legacyAccents: LEGACY_ACCENTS });
  });

  it('model pricing', () => {
    embedded('nekko-usage/src/pricing.json', { family: MODEL_PRICING, published: MODEL_PRICING_SNAPSHOT.models });
  });

  it("the turn catalog's shared parts", () => {
    embedded('nekko-turn/src/catalog.json', {
      defaultTurnWrapper: DEFAULT_TURN_WRAPPER,
      strategies: ORCHESTRATION_STRATEGIES.map((s) => ({ id: s.id, allowsSpawn: s.allowsSpawn, promptHint: s.promptHint })),
      defaultOrchestration: DEFAULT_ORCHESTRATION,
      askCancelled: ASK_CANCELLED,
      askUnattended: ASK_UNATTENDED,
      toolCategories: TOOL_CATEGORY_OF,
      offlineBlockedTools: OFFLINE_BLOCKED_AGENT_TOOLS,
      workModePrompts: workModePrompts(),
    });
  });

  it('the workflow catalog', () => {
    embedded('nekko-automation/src/catalog.json', {
      actions: WORKFLOW_ACTIONS.map((a) => ({ op: a.op, connector: a.connector ?? null })),
      connectors: CONNECTOR_CATALOG.map((c) => ({ kind: c.kind, label: c.label })),
    });
  });
});
