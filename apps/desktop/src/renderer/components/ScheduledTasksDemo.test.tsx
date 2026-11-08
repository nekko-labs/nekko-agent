import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SCHEDULED_DEMO_FPS, SCHEDULED_DEMO_FRAMES, SCHEDULED_DEMO_SCENES, ScheduledTasksDemo, ScheduledTasksDemoVideo } from './ScheduledTasksDemo.js';

const clock = vi.hoisted(() => ({ frame: 0 }));
const player = vi.hoisted(() => vi.fn((_props: Record<string, unknown>) => null));
vi.mock('@remotion/player', () => ({ Player: player }));
vi.mock('remotion', async importOriginal => ({ ...await importOriginal<typeof import('remotion')>(), useCurrentFrame: () => clock.frame }));

describe('Scheduled Tasks overview', () => {
  it('has a contiguous 42-second timeline with reading time for every caption', () => {
    let next = 0;
    for (const scene of SCHEDULED_DEMO_SCENES) {
      expect(scene.start).toBe(next);
      expect(scene.seconds).toBeGreaterThanOrEqual(6);
      expect(scene.caption.split(/\s+/).length / scene.seconds).toBeLessThan(3.5);
      next += scene.seconds * SCHEDULED_DEMO_FPS;
    }
    expect(next).toBe(SCHEDULED_DEMO_FRAMES);
    expect(next / SCHEDULED_DEMO_FPS).toBe(42);
  });

  it('renders every scene, caption and mascot at its held frame and boundaries', () => {
    for (const scene of SCHEDULED_DEMO_SCENES) {
      for (const offset of [0, 60, scene.seconds * SCHEDULED_DEMO_FPS - 1]) {
        clock.frame = scene.start + offset;
        const html = renderToStaticMarkup(<ScheduledTasksDemoVideo />);
        expect(html).toContain(scene.title);
        expect(html).toContain(scene.caption.replaceAll('&', '&amp;'));
        expect(html).toContain('scheduled-demo-nekko');
        expect(html).toContain('Illustrated walkthrough');
        expect(html).not.toContain('<button');
        expect(html).not.toContain('<iframe');
      }
    }
  });

  it('provides opt-in controls, a visible opening frame and an equivalent transcript', () => {
    const html = renderToStaticMarkup(<ScheduledTasksDemo />);
    const props = player.mock.calls.at(-1)?.[0] as unknown as Record<string, unknown>;
    expect(props).toMatchObject({ controls: true, clickToPlay: true, initialFrame: 15, durationInFrames: 1260 });
    expect(props.autoPlay).not.toBe(true);
    expect(props.loop).not.toBe(true);
    expect(html).toContain('Read the walkthrough transcript');
    for (const scene of SCHEDULED_DEMO_SCENES) expect(html).toContain(scene.title);
    expect(html).toContain('No task is created or run');
    expect(html).toContain('tool permissions control access');
    expect(html).toContain('Keep Nekko running');
  });
});
