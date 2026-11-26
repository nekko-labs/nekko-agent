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
  return (
    <section aria-label="Strategy" className="rounded-md border border-line px-3 py-2 text-xs">
      <h3 className="m-0 font-medium">Strategy</h3>
      <p className="m-0 mt-1 text-ink-muted">
        {strategy.orchestration === 'external' ? orchestra.external : `${tools[strategy.tools]} · ${orchestra[strategy.orchestration]}`}
        {strategy.reason && <> · {reasons[strategy.reason]}</>}
      </p>
    </section>
  );
}
