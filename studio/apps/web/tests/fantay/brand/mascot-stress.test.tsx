// @vitest-environment jsdom
import { cleanup, fireEvent, render, act } from '@testing-library/react';
import React, { Profiler } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FantayMascot, FantayMascotStill, focusPoint } from '../../../src/fantay/brand/FantayMascot';
import { createFlight, type Flight } from '../../../src/fantay/brand/mascot-flight';
import { sheetFor } from '../../../src/fantay/brand/mascot-sheet';
import type { ActorOptions } from '../../../src/fantay/brand/mascot-stage';

/** A stand-in for the stage, which needs WebGL: it keeps a real flight and records what the mascot asks of it. */
const stage = vi.hoisted(() => ({
  actors: [] as { options: unknown; flight: unknown; shown: boolean; gone: boolean; sizes: number[] }[],
}));
vi.mock('../../../src/fantay/brand/mascot-stage', () => ({
  createActor: (options: ActorOptions) => {
    const actor = {
      options,
      flight: createFlight(sheetFor(48), 1, options.small),
      shown: false,
      gone: false,
      sizes: [options.size],
      resize(size: number) {
        actor.sizes.push(size);
      },
      show(on: boolean) {
        actor.shown = on;
      },
      advance() {},
      dispose() {
        actor.gone = true;
      },
    };
    stage.actors.push(actor);
    return actor;
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  stage.actors.length = 0;
});

function reducedMotion(matches: boolean) {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: matches && query.includes('prefers-reduced-motion: reduce'),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as any;
  return () => {
    window.matchMedia = original;
  };
}

/** Gives the page what the living mascot needs, and lets the test say when it is on screen. */
function liveStage() {
  const observers: { callback: IntersectionObserverCallback; disconnected: boolean }[] = [];
  vi.stubGlobal('WebGL2RenderingContext', class {});
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      entry: { callback: IntersectionObserverCallback; disconnected: boolean };
      constructor(callback: IntersectionObserverCallback) {
        this.entry = { callback, disconnected: false };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.callback(
          [{ isIntersecting: true, boundingClientRect: target.getBoundingClientRect() } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      unobserve() {}
      disconnect() {
        this.entry.disconnected = true;
      }
    },
  );
  return {
    observers,
    leaveScreen() {
      for (const observer of observers) {
        observer.callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
      }
    },
    /** The stage is fetched on demand: wait for it to arrive. */
    async arrive() {
      await act(async () => {
        await vi.dynamicImportSettled();
      });
    },
  };
}

describe('Feature 21: the living mascot on the page', () => {
  describe('the approved artwork', () => {
    it.each([
      [16, '/fantay-sprite-small.svg'],
      [48, '/fantay-sprite.svg'],
    ] as const)('uses the splash sprite artwork at %d px', (size, src) => {
      const { getByTestId } = render(<FantayMascotStill size={size} />);
      expect(getByTestId('fantay-mascot-still').getAttribute('src')).toBe(src);
    });

    it('is what shows where the page cannot draw the living one', async () => {
      const restore = reducedMotion(false);
      const addEventSpy = vi.spyOn(window, 'addEventListener');
      const { container } = render(<FantayMascot size={128} tracking interactive />);
      await act(async () => {
        await vi.dynamicImportSettled();
      });
      const root = container.querySelector('[data-testid="fantay-mascot"]')!;
      expect(root.hasAttribute('data-live')).toBe(false);
      expect(root.querySelector('img')?.getAttribute('src')).toBe('/fantay-sprite.svg');
      expect(stage.actors).toHaveLength(0);
      expect(addEventSpy.mock.calls.map(([event]) => event)).not.toContain('pointermove');
      restore();
    });
  });

  describe('prefers-reduced-motion', () => {
    it('suppresses the stage, the listeners, lifts and pointer stirs altogether', async () => {
      const restore = reducedMotion(true);
      const live = liveStage();
      const addEventSpy = vi.spyOn(window, 'addEventListener');

      const { container } = render(<FantayMascot tracking appear interactive grounded pulse={1} flip={1} />);
      await live.arrive();
      const root = container.querySelector('[data-testid="fantay-mascot"]')!;
      expect(stage.actors).toHaveLength(0);
      expect(root.hasAttribute('data-live')).toBe(false);
      expect(root.hasAttribute('data-wait')).toBe(false);
      expect(root.querySelector('img')?.getAttribute('src')).toBe('/fantay-sprite.svg');

      const attachedEvents = addEventSpy.mock.calls.map(([event]) => event);
      expect(attachedEvents).not.toContain('pointermove');
      expect(attachedEvents).not.toContain('focusin');

      fireEvent.click(root);
      fireEvent.pointerEnter(root);
      expect(stage.actors).toHaveLength(0);
      restore();
    });

    it('hands back to the artwork when the stage can no longer draw it', async () => {
      const restore = reducedMotion(false);
      const live = liveStage();
      const { container } = render(<FantayMascot size={128} grounded />);
      await live.arrive();
      const root = container.querySelector('[data-testid="fantay-mascot"]')!;
      expect(root.hasAttribute('data-live')).toBe(true);
      act(() => {
        (stage.actors[0]!.options as ActorOptions).rest!();
      });
      expect(root.hasAttribute('data-live')).toBe(false);
      expect(stage.actors[0]!.shown).toBe(false);
      restore();
    });
  });

  describe('going live', () => {
    it('takes over from the artwork once the stage has drawn it, without re-rendering React', async () => {
      const restore = reducedMotion(false);
      const live = liveStage();
      const commits = vi.fn();
      const { container } = render(
        <Profiler id="mascot" onRender={commits}>
          <FantayMascot size={128} />
        </Profiler>,
      );
      const mounted = commits.mock.calls.length;
      await live.arrive();
      const root = container.querySelector('[data-testid="fantay-mascot"]')!;
      expect(root.hasAttribute('data-live')).toBe(true);
      expect(stage.actors).toHaveLength(1);
      expect(stage.actors[0]!.shown).toBe(true);
      expect((stage.actors[0]!.options as ActorOptions).canvas).toBe(root.querySelector('canvas'));
      expect(commits.mock.calls.length).toBe(mounted);
      restore();
    });

    it('keeps the mark out of sight while the stage loads, entrance or not', async () => {
      const restore = reducedMotion(false);
      const live = liveStage();
      const plain = render(<FantayMascot size={56} />);
      expect(plain.container.querySelector('[data-testid="fantay-mascot"]')!.hasAttribute('data-wait')).toBe(true);
      plain.unmount();
      const { container } = render(<FantayMascot size={128} appear />);
      const root = container.querySelector('[data-testid="fantay-mascot"]')!;
      expect(root.hasAttribute('data-wait')).toBe(true);
      await live.arrive();
      expect(root.hasAttribute('data-wait')).toBe(false);
      expect(root.hasAttribute('data-live')).toBe(true);
      expect((stage.actors.at(-1)!.options as ActorOptions).appear).toBe(true);
      restore();
    });

    it('uses the small cut at small sizes and follows the box it fills', async () => {
      const restore = reducedMotion(false);
      const live = liveStage();
      const { container } = render(
        <>
          <FantayMascot size={24} />
          <FantayMascot />
        </>,
      );
      await live.arrive();
      expect(container.querySelectorAll('[data-small]')).toHaveLength(1);
      expect((stage.actors[0]!.options as ActorOptions).small).toBe(true);
      expect((stage.actors[1]!.options as ActorOptions).small).toBe(false);
      restore();
    });

    it('rests off screen, and is gone when it unmounts', async () => {
      const restore = reducedMotion(false);
      const live = liveStage();
      const { unmount } = render(<FantayMascot size={128} />);
      await live.arrive();
      expect(stage.actors[0]!.shown).toBe(true);
      live.leaveScreen();
      expect(stage.actors[0]!.shown).toBe(false);
      unmount();
      expect(stage.actors[0]!.gone).toBe(true);
      expect(live.observers.every((observer) => observer.disconnected)).toBe(true);
      restore();
    });

    it('never makes a stage for a mascot that unmounted while it was loading', async () => {
      const restore = reducedMotion(false);
      const live = liveStage();
      const { unmount } = render(<FantayMascot size={128} />);
      unmount();
      await live.arrive();
      expect(stage.actors).toHaveLength(0);
      restore();
    });
  });

  describe('what is asked of it', () => {
    it('springs up on a pulse and goes head over heels on a flip, even when asked before the stage had loaded', async () => {
      const restore = reducedMotion(false);
      const live = liveStage();
      render(<FantayMascot size={128} pulse={1} flip={1} />);
      await live.arrive();
      const flight = stage.actors[0]!.flight as Flight;
      // A pulse is a crouch first, with the lift owed at the end of it.
      expect(flight.crouch).toBeGreaterThan(0);
      expect(flight.owed).toBeGreaterThan(0);
      expect(flight.rollWaiting).toBeGreaterThanOrEqual(0);
      restore();
    });

    it('springs up again each time the pulse is raised', async () => {
      const restore = reducedMotion(false);
      const live = liveStage();
      const { rerender } = render(<FantayMascot size={128} />);
      await live.arrive();
      const flight = stage.actors[0]!.flight as Flight;
      expect(flight.owed).toBe(0);
      rerender(<FantayMascot size={128} pulse={1} />);
      expect(flight.owed).toBeGreaterThan(0);
      expect(flight.joyHold).toBeGreaterThan(0);
      expect(flight.rollWaiting).toBeLessThan(0);
      restore();
    });

    it('survives 100 clicks, and three quick ones roll it over', async () => {
      const restore = reducedMotion(false);
      const live = liveStage();
      const { container } = render(<FantayMascot size={128} interactive grounded />);
      await live.arrive();
      const root = container.querySelector('[data-testid="fantay-mascot"]')!;
      const flight = stage.actors[0]!.flight as Flight;
      for (let i = 0; i < 100; i += 1) {
        act(() => {
          fireEvent.click(root);
        });
      }
      expect(stage.actors).toHaveLength(1);
      expect(flight.rollWaiting).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(flight.airGoal)).toBe(true);
      restore();
    });
  });

  describe('what it watches', () => {
    it('tracks focused inputs and the composer card while ignoring anything else', () => {
      const input = document.createElement('input');
      input.getBoundingClientRect = () => ({ left: 200, top: 300, width: 100, height: 40, right: 300, bottom: 340, x: 200, y: 300, toJSON: () => {} });
      const button = document.createElement('button');
      const card = document.createElement('div');
      card.setAttribute('data-testid', 'home-hero-composer-card');
      const inner = document.createElement('span');
      card.appendChild(inner);
      document.body.append(input, button, card);

      expect(focusPoint(input)).toEqual({ x: 250, y: 320 });
      expect(focusPoint(inner)).not.toBeNull();
      expect(focusPoint(button)).toBeNull();
      expect(focusPoint(null)).toBeNull();

      input.remove();
      button.remove();
      card.remove();
    });

    it('brings the pointer to the stage only when the stage asks for it', async () => {
      const restore = reducedMotion(false);
      const live = liveStage();
      render(<FantayMascot size={128} tracking interactive />);
      await live.arrive();
      act(() => {
        for (let i = 0; i < 40; i += 1) window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300 + i, clientY: 40 }));
      });
      const options = stage.actors[0]!.options as ActorOptions;
      const input = { lookX: 0, lookY: 0, look: 0, gustX: 0, gustY: 0, near: 0, atX: 0, atY: 0 };
      options.read!(1 / 60, input);
      expect(input.look).toBe(1);
      expect(input.lookX).toBeGreaterThan(0);
      // Nothing new since: the next frame has no air from it.
      options.read!(1 / 60, input);
      expect(input.gustX).toBe(0);
      restore();
    });
  });
});
