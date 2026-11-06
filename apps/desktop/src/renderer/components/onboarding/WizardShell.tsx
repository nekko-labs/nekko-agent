import React, { useEffect, useRef } from 'react';

export interface WizardStepDef {
  id: string;
  title: string;
}

/**
 * The onboarding wizard frame: a calm, centered column laid over the whole
 * app, with step dots up top and Back / Skip step / Next at the bottom.
 *
 * Owns the keyboard model: ArrowRight/ArrowLeft step through, Escape skips
 * setup entirely (skipping is non-destructive - it writes the same
 * "don't auto-show again" flag as finishing, and every step stays reachable
 * later from its real home in Settings).
 *
 * Rendered `absolute` inside the area below the title bar so the window's own
 * controls stay reachable while the wizard is up.
 */
export function WizardShell({
  steps,
  index,
  onBack,
  onNext,
  onSkipStep,
  onSkipAll,
  onGoTo,
  nextLabel = 'Next',
  showSkipStep = true,
  children,
}: {
  steps: WizardStepDef[];
  index: number;
  onBack: () => void;
  onNext: () => void;
  onSkipStep: () => void;
  onSkipAll: () => void;
  onGoTo: (index: number) => void;
  nextLabel?: string;
  showSkipStep?: boolean;
  children: React.ReactNode;
}) {
  const stepRef = useRef<HTMLElement>(null);
  const step = steps[index];

  // Move focus to the new step's region so keyboard and screen-reader users
  // land on the content that just appeared rather than staying on a footer
  // button from the previous step.
  useEffect(() => {
    stepRef.current?.focus({ preventScroll: true });
  }, [index]);

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Stop wizard keys from bubbling up to global shortcut listeners.
    e.stopPropagation();

    const target = e.target as HTMLElement | null;
    if (!target) return;

    // Let inputs, contenteditable regions, grids, and single-choice groups
    // handle their own arrow keys.
    if (target.isContentEditable) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
    if (target.closest('[role="grid"], [role="radiogroup"], [contenteditable]')) return;

    if (e.key === 'ArrowRight') {
      e.preventDefault();
      onNext();
    } else if (e.key === 'ArrowLeft') {
      if (index > 0) {
        e.preventDefault();
        onBack();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onSkipAll();
    }
  };

  return (
    <div
      className="absolute inset-0 z-50 flex flex-col bg-paper"
      role="dialog"
      aria-modal="true"
      aria-label="Nekko Agent setup"
      onKeyDown={handleKey}
    >
      {/* Header: step dots centered, Skip setup tucked in the trailing corner. */}
      <div className="flex items-center px-6 py-5">
        <div className="w-24" aria-hidden="true" />
        <div className="flex flex-1 items-center justify-center gap-2" role="group" aria-label="Setup progress">
          {steps.map((s, i) => {
            const current = i === index;
            const visited = i < index;
            return (
              <button
                key={s.id}
                onClick={() => onGoTo(i)}
                aria-label={`Step ${i + 1} of ${steps.length}: ${s.title}`}
                aria-current={current ? 'step' : undefined}
                className={`h-2.5 rounded-full transition-colors ${
                  current ? 'w-6 bg-accent' : visited ? 'w-2.5 bg-accent-soft' : 'w-2.5 bg-line hover:bg-surface-2'
                }`}
              />
            );
          })}
        </div>
        <div className="flex w-24 justify-end">
          <button className="btn btn-ghost px-2 py-1 text-xs" onClick={onSkipAll}>
            Skip setup
          </button>
        </div>
      </div>

      {/* Step content: a single centered column, scrolled if it ever overflows. */}
      <section
        ref={stepRef}
        tabIndex={-1}
        aria-label={step.title}
        className="flex flex-1 justify-center overflow-y-auto px-6 py-4 outline-none"
      >
        {/* `my-auto` centers a short step but collapses to top-aligned when the
            content overflows, so nothing is clipped above the scroll area (a
            justify-center column would push the top out of reach). */}
        <div className="my-auto flex w-full max-w-xl flex-col items-center">{children}</div>
      </section>

      {/* Footer: Back on the left, Skip step + Next on the right. */}
      <div className="flex items-center justify-between px-6 py-5">
        <button className="btn btn-ghost" onClick={onBack} disabled={index === 0} aria-disabled={index === 0}>
          Back
        </button>
        <div className="flex items-center gap-2">
          {showSkipStep && (
            <button className="btn btn-ghost" onClick={onSkipStep}>
              Skip step
            </button>
          )}
          <button className="btn btn-primary" onClick={onNext}>
            {nextLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
