// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryToast } from '../../src/components/MemoryToast';
import { I18nProvider } from '../../src/i18n';
import { navigate } from '../../src/router';

vi.mock('../../src/router', () => ({ navigate: vi.fn() }));

type Listener = (event: MessageEvent) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly listeners = new Map<string, Set<Listener>>();
  closed = false;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: EventListener): void {
    const listeners = this.listeners.get(name) ?? new Set<Listener>();
    listeners.add(listener as Listener);
    this.listeners.set(name, listeners);
  }

  close(): void {
    this.closed = true;
  }

  dispatch(name: string, data: unknown): void {
    const event = new MessageEvent(name, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
}

function renderToast(locale: 'en' | 'zh-CN', onOpenMemory?: () => void) {
  render(
    <I18nProvider initial={locale}>
      <MemoryToast subscriptionMode="always" onOpenMemory={onOpenMemory} />
    </I18nProvider>,
  );
  return MockEventSource.instances[0]!;
}

function emitChange(source: MockEventSource, data: Record<string, unknown>) {
  act(() => source.dispatch('change', { at: Date.now(), ...data }));
}

const ruleEvent = {
  kind: 'design-system-rule',
  source: 'correction',
  count: 1,
  designSystemId: 'user:acme',
  designSystemTitle: 'Acme UI',
  rules: ['Never use a red primary button.'],
};

beforeEach(() => {
  MockEventSource.instances = [];
  vi.mocked(navigate).mockClear();
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('MemoryToast design-system-rule event', () => {
  it('names the design system and the learnt rule in English', () => {
    const source = renderToast('en');
    expect(source.url).toBe('/api/memory/events');
    emitChange(source, ruleEvent);

    const pill = screen.getByRole('button');
    expect(pill).toHaveTextContent('Learnt as a rule of “Acme UI”');
    expect(pill).toHaveTextContent('Never use a red primary button.');
    expect(pill).toHaveTextContent('View rules');
    expect(screen.queryByText('Memory updated')).not.toBeInTheDocument();
  });

  it('names the design system in Chinese and counts extra rules', () => {
    const source = renderToast('zh-CN');
    emitChange(source, { ...ruleEvent, count: 3, rules: ['规则一', '规则二', '规则三'] });

    const pill = screen.getByRole('button');
    expect(pill).toHaveTextContent('已记入设计体系「Acme UI」的规则');
    expect(pill).toHaveTextContent('规则一 等 3 条');
    expect(pill).toHaveTextContent('查看规则');
    expect(screen.queryByText('记忆已更新')).not.toBeInTheDocument();
  });

  it('counts extra rules as +N in English', () => {
    const source = renderToast('en');
    emitChange(source, { ...ruleEvent, count: 3, rules: ['One', 'Two', 'Three'] });
    expect(screen.getByRole('button')).toHaveTextContent('One +2');
  });

  it('falls back to the design-system id when the title is missing', () => {
    const source = renderToast('en');
    emitChange(source, { ...ruleEvent, designSystemTitle: undefined });
    expect(screen.getByRole('button')).toHaveTextContent('Learnt as a rule of “user:acme”');
  });

  it('opens the design system detail page on click and dismisses the pill', () => {
    const onOpenMemory = vi.fn();
    const source = renderToast('en', onOpenMemory);
    emitChange(source, ruleEvent);

    fireEvent.click(screen.getByRole('button'));

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ kind: 'design-system-detail', designSystemId: 'user:acme' });
    expect(onOpenMemory).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('ignores a design-system-rule event with no system id or no rules written', () => {
    const source = renderToast('en');
    emitChange(source, { ...ruleEvent, designSystemId: undefined });
    emitChange(source, { ...ruleEvent, count: 0 });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('still shows the generic memory label for an ordinary extract event', () => {
    const onOpenMemory = vi.fn();
    const source = renderToast('en', onOpenMemory);
    emitChange(source, { kind: 'extract', source: 'llm', count: 2 });

    const pill = screen.getByRole('button');
    expect(pill).toHaveTextContent('Memory updated');
    expect(pill).toHaveTextContent('(2 · LLM)');
    expect(pill).not.toHaveTextContent('Learnt as a rule');

    fireEvent.click(pill);
    expect(onOpenMemory).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the generic memory label in Chinese for an ordinary extract event', () => {
    const source = renderToast('zh-CN');
    emitChange(source, { kind: 'extract', source: 'heuristic', count: 1 });
    expect(screen.getByRole('status')).toHaveTextContent('记忆已更新');
    expect(screen.queryByText(/已记入设计体系/)).not.toBeInTheDocument();
  });

  it('replaces the generic label when a design-system-rule event follows an extract', () => {
    const source = renderToast('en');
    emitChange(source, { kind: 'extract', source: 'llm', count: 1 });
    expect(screen.getByRole('status')).toHaveTextContent('Memory updated');

    emitChange(source, ruleEvent);
    expect(screen.getByRole('button')).toHaveTextContent('Learnt as a rule of “Acme UI”');
  });
});
