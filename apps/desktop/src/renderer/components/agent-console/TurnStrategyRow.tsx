import { useId } from 'react';
import type { TurnStrategy } from '@nekko-agent/shared';

const tools = { code: 'Code mode', list: 'Tool list', none: 'No tools', 'claude-code': 'Claude Code' };
const orchestra = { direct: 'Direct', coordinator: 'Orchestration', worker: 'Worker', external: 'Managed by Claude Code' };
const reasons = {
  'not-needed': 'No coordination needed',
  requested: 'Coordination requested',
  separable: 'Independent work identified',
  unavailable: 'Coordination unavailable on this route',
  off: 'Orchestrate is off',
};

export function TurnStrategyRow({ strategy }: { strategy: TurnStrategy }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-turn-strategy className="py-2 text-xs [overflow-wrap:anywhere]">
      <h3 id={headingId} className="m-0 font-medium text-ink-soft">Strategy</h3>
      <p className="m-0 mt-1 text-ink-faint">
        {strategy.orchestration === 'external' ? orchestra.external : `${tools[strategy.tools]} · ${orchestra[strategy.orchestration]}`}
        {strategy.reason && <> · {reasons[strategy.reason]}</>}
      </p>
      {strategy.modelId && <p className="m-0 text-ink-faint">Model: {strategy.modelId}</p>}
      {(strategy.subagentModelId || strategy.subagentsDeferred) && (
        <p className="m-0 text-ink-faint">Planned sub-agent model: {strategy.subagentModelId || 'Chosen at delegation'}</p>
      )}
    </section>
  );
}
