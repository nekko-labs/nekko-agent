import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AppSettings, OAuthStatus, ProviderConfig } from '@nekko-agent/shared';
import { ONBOARDING_VERSION } from '@nekko-agent/shared';
import { WizardShell } from './WizardShell.js';
import { WelcomeStep } from './WelcomeStep.js';
import { ProvidersStep } from './ProvidersStep.js';
import { IntegrationsStep } from './IntegrationsStep.js';
import { DoneStep } from './DoneStep.js';
import { WorkTrackingStep } from './WorkTrackingStep.js';
import { ProjectManagementToggles } from '../WorkTrackingToggles.js';
import { ONBOARDING_STEPS, wizardTransition, type WizardState } from './onboardingMachine.js';

// The step components and the store read browser globals at import time;
// node has none, so provide the minimum first (hoisted above module imports
// and mock factories).
vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = {
    innerWidth: 1280,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  };
});

// The wizard steps read slices of the store; tests seed the slices they assert
// on (e.g. an existing provider for the dedup check). Effects never run under
// renderToStaticMarkup, so IPC methods are never needed here.
const mockStoreState = vi.hoisted(() => ({
  settings: null as AppSettings | null,
  providers: [] as ProviderConfig[],
  setView: () => {},
  newChat: () => Promise.resolve(),
  applyTheme: () => {},
  refreshProviders: () => Promise.resolve(),
  refreshSettings: () => Promise.resolve(),
  pushToast: () => {},
  setOnboardingOpen: () => {},
}));

vi.mock('../../store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store.js')>()
  return {
    ...actual,
    useStore: (selector?: (s: unknown) => unknown) =>
      selector ? selector(mockStoreState) : mockStoreState,
  };
});

const { shouldAutoOpenOnboarding } = await import('../../store.js');

const TEST_STEPS = [
  { id: 'welcome', title: 'Welcome' },
  { id: 'theme', title: 'Theme' },
  { id: 'done', title: 'All set' },
];

function shell(index: number, extra: { nextLabel?: string; showSkipStep?: boolean } = {}) {
  return renderToStaticMarkup(
    <WizardShell
      steps={TEST_STEPS}
      index={index}
      onBack={() => {}}
      onNext={() => {}}
      onSkipStep={() => {}}
      onSkipAll={() => {}}
      onGoTo={() => {}}
      nextLabel={extra.nextLabel}
      showSkipStep={extra.showSkipStep}
    >
      <p>step body</p>
    </WizardShell>,
  );
}

const baseSettings = { providers: [] } as unknown as AppSettings;

describe('shouldAutoOpenOnboarding', () => {
  it('opens on a genuinely fresh install and not once setup is done', () => {
    expect(shouldAutoOpenOnboarding(baseSettings)).toBe(true);
    expect(
      shouldAutoOpenOnboarding({
        ...baseSettings,
        onboarding: { version: ONBOARDING_VERSION, completedAt: 1 },
      }),
    ).toBe(false);
    // Skipping writes the same flag: "don't auto-show again," not "did everything."
    expect(
      shouldAutoOpenOnboarding({
        ...baseSettings,
        onboarding: { version: ONBOARDING_VERSION, completedAt: 1, steps: { theme: 'skipped' } },
      }),
    ).toBe(false);
  });

  it('stays closed for installs that predate the wizard', () => {
    // completedAt is unset on every upgrade; a configured provider is the
    // signal that setup already happened, so the wizard must not ambush them.
    expect(
      shouldAutoOpenOnboarding({ ...baseSettings, providers: [{ id: 'p1' }] as AppSettings['providers'] }),
    ).toBe(false);
  });

  it('stays closed until settings have loaded', () => {
    expect(shouldAutoOpenOnboarding(null)).toBe(false);
    expect(shouldAutoOpenOnboarding(undefined)).toBe(false);
  });
});

describe('WizardShell', () => {
  it('renders as a modal dialog with step dots, controls, and focusable step region', () => {
    const html = shell(1);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="Nekko Agent setup"');
    expect(html).toContain('aria-label="Setup progress"');
    expect(html).toContain('aria-current="step"');
    expect(html.match(/aria-label="Step \d of 3:/g)).toHaveLength(3);
    for (const label of ['Back', 'Skip step', 'Skip setup', 'Next']) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-label="Theme"');
    expect(html).toContain('step body');
  });

  it('disables Back on the first step and swaps the label on the last', () => {
    const first = shell(0);
    expect(first).toContain('disabled=""');
    const last = shell(2, { nextLabel: 'Finish', showSkipStep: false });
    expect(last).toContain('>Finish<');
    expect(last).not.toContain('>Skip step<');
    expect(last).toContain('>Skip setup<');
  });
});

describe('onboarding step content', () => {
  it('greets with the mascot and the Nekko Agent name', () => {
    const html = renderToStaticMarkup(<WelcomeStep />);
    expect(html).toContain('Welcome to Nekko Agent');
    expect(html).toContain('aria-label="Nekko"');
  });

  it('offers the online options, a local scan, and the Nekko Agent deep link', () => {
    mockStoreState.providers = [];
    const html = renderToStaticMarkup(<ProvidersStep />);
    expect(html).toContain('Connect a model');
    expect(html).toContain('>Claude<');
    expect(html).toContain('>ChatGPT / OpenAI<');
    expect(html).toContain('OpenRouter');
    expect(html).toContain('OpenAI-compatible');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Nekko Agent');
    expect(html).toContain('Open Model Server');
    expect(html).toContain('Models');
    // The local probe runs on mount; SSR shows the in-flight state.
    expect(html).toContain('Checking for Ollama, LM Studio, and vLLM');
  });

  it('shows a configured provider kind as connected instead of offering a re-add', () => {
    mockStoreState.providers = [
      {
        id: 'p1',
        kind: 'anthropic',
        label: 'Claude (subscription)',
        baseUrl: 'https://api.anthropic.com',
        auth: 'subscription',
        enabled: true,
      } as ProviderConfig,
    ];
    try {
      const html = renderToStaticMarkup(<ProvidersStep />);
      expect(html).toContain('Connected');
      expect(html).toContain('Claude (subscription)');
      // The subscription sign-in only renders inside a card that isn't
      // connected, so it can't appear for the already-configured kind.
      expect(html).not.toContain('Sign in with Claude');
      // Other kinds still offer setup, and the default-provider offer appears.
      expect(html).toContain('Set up');
      expect(html).toContain('Use one as your default?');
    } finally {
      mockStoreState.providers = [];
    }
  });

  it('labels a saved OpenAI API key honestly under the shared ChatGPT card', () => {
    // The card covers both paths, so a plain API key must not read as a
    // ChatGPT subscription in the connected state.
    mockStoreState.providers = [
      {
        id: 'p1',
        kind: 'openai',
        label: 'OpenAI',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        enabled: true,
      } as ProviderConfig,
    ];
    try {
      const html = renderToStaticMarkup(<ProvidersStep />);
      expect(html).toContain('>ChatGPT / OpenAI<');
      expect(html).toContain('Connected');
      expect(html).toContain('OpenAI (API key)');
      expect(html).not.toContain('Sign in with ChatGPT');
    } finally {
      mockStoreState.providers = [];
    }
  });

  it('offers subagent installs and the app connector grid', () => {
    const html = renderToStaticMarkup(<IntegrationsStep />);
    expect(html).toContain('Meet your tools');
    expect(html).toContain('Use Nekko inside other tools');
    expect(html).toContain('Connect your apps');
    // Detection runs in an effect; SSR shows the in-flight scan.
    expect(html).toContain('Checking for Claude Code, Codex, Cursor, and Windsurf');
    for (const label of ['GitHub', 'Linear', 'Slack', 'Discord', 'Jira', 'Microsoft Teams', 'Gmail', 'Google Drive']) {
      expect(html).toContain(label);
    }
  });

  it('maps a subscription sign-in to a provider config without secrets', async () => {
    const { subscriptionProviderConfig, matchingProviders } = await import('../providers/AddProvider.js');
    const cfg = subscriptionProviderConfig({
      tokenKey: 'chatgpt',
      provider: 'chatgpt',
      connected: true,
      state: 'success',
      accountId: 'acct_1',
    } as OAuthStatus);
    expect(cfg.kind).toBe('chatgpt');
    expect(cfg.auth).toBe('subscription');
    expect(cfg.tokenKey).toBe('chatgpt');
    expect(cfg.accountId).toBe('acct_1');
    expect(cfg).not.toHaveProperty('apiKey');
    expect(matchingProviders([cfg], ['chatgpt', 'openai'])).toHaveLength(1);
    expect(matchingProviders([cfg], ['anthropic'])).toHaveLength(0);
  });

  it('offers three first moves on the done step', () => {
    const html = renderToStaticMarkup(<DoneStep onFinish={() => {}} />);
    expect(html).toContain('You&#x27;re set');
    expect(html).toContain('Start your first chat');
    expect(html).toContain('Connect a model provider');
    expect(html).toContain('Wire up your apps');
  });
});

describe('onboarding state machine', () => {
  const initial: WizardState = { index: 0, steps: {} };

  it('advances through steps and marks each done on Next', () => {
    let state = initial;
    for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
      const { state: next, complete } = wizardTransition(state, { type: 'next' });
      expect(complete).toBe(i === ONBOARDING_STEPS.length - 1);
      if (i < ONBOARDING_STEPS.length - 1) {
        expect(next.index).toBe(i + 1);
        expect(next.steps[ONBOARDING_STEPS[i].id]).toBe('done');
      } else {
        expect(next.steps[ONBOARDING_STEPS[i].id]).toBe('done');
      }
      state = next;
    }
  });

  it('moves back one step without mutating the outcome map', () => {
    const forward = wizardTransition(initial, { type: 'next' }).state;
    const back = wizardTransition(forward, { type: 'back' }).state;
    expect(back.index).toBe(0);
    expect(back.steps).toEqual(forward.steps);
  });

  it('marks intermediate steps skipped when jumping forward via dots', () => {
    const { state } = wizardTransition(initial, { type: 'goTo', to: 3 });
    expect(state.index).toBe(3);
    expect(state.steps['welcome']).toBe('skipped');
    expect(state.steps['theme']).toBe('skipped');
    expect(state.steps['providers']).toBe('skipped');
    expect(state.steps['integrations']).toBeUndefined();
  });

  it('does not override done outcomes when jumping forward', () => {
    const atProviders = wizardTransition(
      wizardTransition(initial, { type: 'next' }).state,
      { type: 'next' },
    ).state;
    const jumped = wizardTransition(atProviders, { type: 'goTo', to: 3 }).state;
    expect(jumped.steps['welcome']).toBe('done');
    expect(jumped.steps['theme']).toBe('done');
    expect(jumped.steps['providers']).toBe('skipped');
  });

  it('completes with done on finish', () => {
    const { state, complete } = wizardTransition({ index: ONBOARDING_STEPS.length - 1, steps: { theme: 'done' } } as WizardState, { type: 'finish' });
    expect(complete).toBe(true);
    expect(state.steps['done']).toBe('done');
  });

  it('completes with skipped on skip-all', () => {
    const { state, complete } = wizardTransition({ index: 2, steps: { theme: 'done' } } as WizardState, { type: 'skipAll' });
    expect(complete).toBe(true);
    expect(state.steps['providers']).toBe('skipped');
  });

  it('keeps the final step outcome on skip from the last step', () => {
    const { state, complete } = wizardTransition({ index: ONBOARDING_STEPS.length - 1, steps: {} } as WizardState, { type: 'skipStep' });
    expect(complete).toBe(true);
    expect(state.steps['done']).toBe('skipped');
  });

  it('does not leave an incomplete outcome map after skipping forward and finishing', () => {
    let state = initial;
    state = wizardTransition(state, { type: 'goTo', to: ONBOARDING_STEPS.length - 1 }).state;
    expect(state.steps['welcome']).toBe('skipped');
    expect(state.steps['theme']).toBe('skipped');
    expect(state.steps['providers']).toBe('skipped');
    expect(state.steps['integrations']).toBe('skipped');
    const { state: finished, complete } = wizardTransition(state, { type: 'finish' });
    expect(complete).toBe(true);
    expect(finished.steps['done']).toBe('done');
    for (const s of ONBOARDING_STEPS) {
      expect(finished.steps[s.id]).toBeDefined();
    }
  });
});

describe('work tracking', () => {
  const checkbox = (html: string, label: string) => html.match(new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';

  it('asks with issues and PR links on and every include opt-in', () => {
    mockStoreState.settings = null;
    const html = renderToStaticMarkup(<WorkTrackingStep />);
    expect(checkbox(html, 'File an issue for each change')).toContain('checked');
    expect(checkbox(html, 'Link each PR to its issue')).toContain('checked');
    expect(checkbox(html, 'Include my prompt in issues')).not.toContain('checked');
    expect(checkbox(html, 'Include my screenshots in PR descriptions')).not.toContain('checked');
    // The step itself is the question, so it never shows the "asks later" note.
    expect(html).not.toContain('Nekko asks the first time');
  });

  it('starts from saved choices on a replay', () => {
    mockStoreState.settings = { projectManagement: { createIssue: false }, pullRequests: { includeScreenshots: true } } as unknown as AppSettings;
    const html = renderToStaticMarkup(<WorkTrackingStep />);
    expect(checkbox(html, 'File an issue for each change')).not.toContain('checked');
    expect(checkbox(html, 'Include my screenshots in PR descriptions')).toContain('checked');
    mockStoreState.settings = null;
  });

  it('marks unanswered includes in Settings as asked the first time', () => {
    const html = renderToStaticMarkup(<ProjectManagementToggles value={{ includePrompt: false }} onChange={() => {}} />);
    expect(html.match(/Nekko asks the first time/g)).toHaveLength(2);
    expect(checkbox(html, 'File an issue for each change')).toContain('checked');
  });
});
