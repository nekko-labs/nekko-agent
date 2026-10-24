import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { OnboardingState } from '@nekko-agent/shared';
import { ONBOARDING_VERSION } from '@nekko-agent/shared';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store.js';
import { WizardShell } from '../components/onboarding/WizardShell.js';
import {
  ONBOARDING_STEPS,
  SKIPPABLE_STEP_IDS,
  wizardTransition,
  type WizardState,
} from '../components/onboarding/onboardingMachine.js';
import { WelcomeStep } from '../components/onboarding/WelcomeStep.js';
import { ThemeStep } from '../components/onboarding/ThemeStep.js';
import { ProvidersStep } from '../components/onboarding/ProvidersStep.js';
import { IntegrationsStep } from '../components/onboarding/IntegrationsStep.js';
import { WorkTrackingStep } from '../components/onboarding/WorkTrackingStep.js';
import { HelpImproveStep } from '../components/onboarding/HelpImproveStep.js';
import { DoneStep } from '../components/onboarding/DoneStep.js';

export function OnboardingView() {
  const { settings, setOnboardingOpen } = useStore(useShallow((s) => ({ settings: s.settings, setOnboardingOpen: s.setOnboardingOpen })));
  const [index, setIndex] = useState(0);
  const stepsRef = useRef<Record<string, 'done' | 'skipped'>>({});
  const runningRef = useRef(false);
  // The current step's confirm action, if it registered one.
  const stepCommitRef = useRef<(() => Promise<void>) | null>(null);

  // Seed the in-memory outcome map once on mount; do not read the store during
  // render (it can be stale or missing in SSR/strict mode).
  useEffect(() => {
    const onboarding = useStore.getState().settings?.onboarding;
    stepsRef.current = onboarding?.steps ? { ...onboarding.steps } : {};
  }, []);

  const persist = useCallback(
    async (steps: Record<string, 'done' | 'skipped'>, complete: boolean) => {
      const prev = useStore.getState().settings?.onboarding;
      const onboarding: OnboardingState = {
        ...(prev ?? {}),
        version: ONBOARDING_VERSION,
        steps,
        ...(complete ? { completedAt: Date.now() } : {}),
      };
      const next = await window.nekko.updateSettings({ onboarding });
      useStore.setState({ settings: next });
      return next;
    },
    [],
  );

  const close = useCallback(
    (after?: () => void) => {
      setOnboardingOpen(false);
      after?.();
    },
    [setOnboardingOpen],
  );

  const back = useCallback(() => {
    if (runningRef.current) return;
    const { state } = wizardTransition({ index, steps: stepsRef.current }, { type: 'back' });
    setIndex(state.index);
  }, [index]);

  const goTo = useCallback(
    async (i: number) => {
      if (runningRef.current) return;
      if (i === index) return;
      if (i > index) {
        runningRef.current = true;
        try {
          const prev: WizardState = { index, steps: stepsRef.current };
          const { state } = wizardTransition(prev, { type: 'goTo', to: i });
          stepsRef.current = state.steps;
          await persist(state.steps, false);
          setIndex(state.index);
        } finally {
          runningRef.current = false;
        }
      } else {
        setIndex(i);
      }
    },
    [index, persist],
  );

  const next = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      // A step with something to apply on confirm (the integrations step adds
      // the checked MCP entries) does it before the wizard moves on.
      await stepCommitRef.current?.();
      const prev: WizardState = { index, steps: stepsRef.current };
      const { state, complete } = wizardTransition(prev, { type: 'next' });
      stepsRef.current = state.steps;
      await persist(state.steps, complete);
      if (complete) {
        close();
      } else {
        setIndex(state.index);
      }
    } finally {
      runningRef.current = false;
    }
  }, [index, persist, close]);

  const skipStep = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      const prev: WizardState = { index, steps: stepsRef.current };
      const { state, complete } = wizardTransition(prev, { type: 'skipStep' });
      stepsRef.current = state.steps;
      await persist(state.steps, complete);
      if (complete) {
        close();
      } else {
        setIndex(state.index);
      }
    } finally {
      runningRef.current = false;
    }
  }, [index, persist, close]);

  const skipAll = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    try {
      const prev: WizardState = { index, steps: stepsRef.current };
      const { state, complete } = wizardTransition(prev, { type: 'skipAll' });
      stepsRef.current = state.steps;
      await persist(state.steps, complete);
      close();
    } finally {
      runningRef.current = false;
    }
  }, [index, persist, close]);

  const finish = useCallback(
    async (after?: () => void) => {
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        const prev: WizardState = { index, steps: stepsRef.current };
        const { state, complete } = wizardTransition(prev, { type: 'finish' });
        stepsRef.current = state.steps;
        await persist(state.steps, complete);
        close(after);
      } finally {
        runningRef.current = false;
      }
    },
    [persist, close],
  );

  if (!settings) return null;
  const step = ONBOARDING_STEPS[index];

  return (
    <WizardShell
      steps={ONBOARDING_STEPS}
      index={index}
      onBack={back}
      onNext={next}
      onSkipStep={skipStep}
      onSkipAll={skipAll}
      onGoTo={goTo}
      nextLabel={index === ONBOARDING_STEPS.length - 1 ? 'Finish' : 'Next'}
      showSkipStep={SKIPPABLE_STEP_IDS.has(step.id)}
    >
      {step.id === 'welcome' && <WelcomeStep />}
      {step.id === 'theme' && <ThemeStep />}
      {step.id === 'providers' && <ProvidersStep onExit={close} />}
      {step.id === 'integrations' && <IntegrationsStep commitRef={stepCommitRef} />}
      {step.id === 'tracking' && <WorkTrackingStep commitRef={stepCommitRef} />}
      {step.id === 'help' && <HelpImproveStep commitRef={stepCommitRef} />}
      {step.id === 'done' && <DoneStep onFinish={finish} />}
    </WizardShell>
  );
}
