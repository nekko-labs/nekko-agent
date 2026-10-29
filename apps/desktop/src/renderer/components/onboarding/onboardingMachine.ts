import type { WizardStepDef } from './WizardShell.js';

export type StepOutcome = 'done' | 'skipped';

export const ONBOARDING_STEPS: WizardStepDef[] = [
  { id: 'welcome', title: 'Welcome' },
  { id: 'theme', title: 'Theme' },
  { id: 'providers', title: 'Providers' },
  { id: 'integrations', title: 'Integrations' },
  { id: 'tracking', title: 'Work tracking' },
  { id: 'help', title: 'Help improve' },
  { id: 'done', title: 'All set' },
];

export const SKIPPABLE_STEP_IDS = new Set(['theme', 'providers', 'integrations', 'tracking', 'help']);

export interface WizardState {
  index: number;
  steps: Record<string, StepOutcome>;
}

export type WizardAction =
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'goTo'; to: number }
  | { type: 'skipStep' }
  | { type: 'skipAll' }
  | { type: 'finish' };

interface WizardResult {
  state: WizardState;
  complete: boolean;
}

/**
 * Pure step transition logic for the first-run wizard. The caller owns the
 * current `index` and the `steps` outcome map; this returns the next state and
 * whether the wizard should write `completedAt` and close.
 */
export function wizardTransition(state: WizardState, action: WizardAction): WizardResult {
  const lastIndex = ONBOARDING_STEPS.length - 1;

  switch (action.type) {
    case 'back':
      return { state: { ...state, index: Math.max(0, state.index - 1) }, complete: false };

    case 'next': {
      const currentId = ONBOARDING_STEPS[state.index].id;
      const steps: Record<string, StepOutcome> = { ...state.steps, [currentId]: 'done' };
      if (state.index >= lastIndex) {
        return { state: { ...state, steps }, complete: true };
      }
      return { state: { ...state, index: state.index + 1, steps }, complete: false };
    }

    case 'skipStep': {
      const currentId = ONBOARDING_STEPS[state.index].id;
      const steps: Record<string, StepOutcome> = { ...state.steps, [currentId]: 'skipped' };
      if (state.index >= lastIndex) {
        return { state: { ...state, steps }, complete: true };
      }
      return { state: { ...state, index: state.index + 1, steps }, complete: false };
    }

    case 'skipAll': {
      const currentId = ONBOARDING_STEPS[state.index].id;
      const steps: Record<string, StepOutcome> = { ...state.steps, [currentId]: 'skipped' };
      return { state: { ...state, steps }, complete: true };
    }

    case 'finish': {
      const lastId = ONBOARDING_STEPS[lastIndex].id;
      const steps: Record<string, StepOutcome> = { ...state.steps, [lastId]: 'done' };
      return { state: { ...state, steps }, complete: true };
    }

    case 'goTo': {
      const to = Math.min(lastIndex, Math.max(0, action.to));
      if (to > state.index) {
        const steps: Record<string, StepOutcome> = { ...state.steps };
        for (let i = state.index; i < to; i++) {
          const id = ONBOARDING_STEPS[i].id;
          if (!(id in steps)) {
            steps[id] = 'skipped';
          }
        }
        return { state: { ...state, index: to, steps }, complete: false };
      }
      return { state: { ...state, index: to }, complete: false };
    }
  }
}
