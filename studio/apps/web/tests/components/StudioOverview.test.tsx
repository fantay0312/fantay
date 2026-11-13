// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyStudioDocument, parseStudioTokens } from '@open-design/contracts';
import { StudioOverview, type StudioOverviewProps } from '../../src/components/StudioOverview';

afterEach(cleanup);

const FULL_CSS = `:root {
  --bg: #ffffff; --surface: #fafafa; --fg: #202020; --muted: #5c5c5c; --accent: #ff385c; --border: #dbdbdb;
  --font-display: "Albert Sans", sans-serif; --font-body: "Inter", sans-serif; --font-mono: ui-monospace, monospace;
  --space-1: 4px; --space-2: 8px; --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px;
}`;
const layers: StudioOverviewProps['layers'] = [
  { id: 'principles', label: '原则', done: true, target: { chapter: 'overview' } },
  { id: 'foundations', label: '基础', done: true, target: { chapter: 'foundations' } },
  { id: 'components', label: '组件', done: false, target: { chapter: 'library', section: 'components' } },
  { id: 'patterns', label: '模式', done: false, target: { chapter: 'library', section: 'patterns' } },
  { id: 'templates', label: '模板', done: false, target: { chapter: 'library', section: 'templates' } },
];
function setup(overrides: Partial<StudioOverviewProps> & { css?: string } = {}) {
  const { css = FULL_CSS, ...props } = overrides;
  const onJump = vi.fn();
  render(<StudioOverview name="Fantay" intro="> Monochrome **ink** on white." book={'Monochrome **ink** on white.\n\n## Principles\n\n1. Paper is flat\n2. One seal per screen'} blocks={[]} placeholderBlocks={false} tokens={parseStudioTokens(css)} scope=":root" document={emptyStudioDocument()} chinese starter={false} canEdit={false} busy={false} layers={layers} version="1.2.0" onJump={onJump} {...props} />);
  return { onJump };
}
const coverStyle = () => screen.getByTestId('studio-overview-cover').getAttribute('data-cover-style');

describe('StudioOverview cover', () => {
  it('names the system once, without the preset title boilerplate', () => {
    setup({ name: 'Design System Inspired by Airbnb' });
    expect(screen.getByRole('heading', { level: 1, name: 'Airbnb' })).toBeTruthy();
    expect(screen.getByTestId('studio-overview-cover').querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('paints the cover ground with the system ground and the name in its ink', () => {
    setup();
    const cover = screen.getByTestId('studio-overview-cover');
    expect(cover.style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(cover.querySelector('text')?.getAttribute('fill')).toBe('#202020');
  });

  it('picks its pattern from what the system says about itself', () => {
    setup();
    expect(coverStyle()).toBe('modular');
    cleanup();
    setup({ css: FULL_CSS.replace('"Albert Sans", sans-serif', '"Source Serif 4", Georgia, serif') });
    expect(coverStyle()).toBe('editorial');
    cleanup();
    setup({ css: FULL_CSS.replace('"Albert Sans", sans-serif', '"JetBrains Mono", monospace') });
    expect(coverStyle()).toBe('technical');
    cleanup();
    setup({ css: FULL_CSS.replace('--radius-lg: 12px', '--radius-lg: 24px') });
    expect(coverStyle()).toBe('soft');
  });

  it('still draws a cover when the system has no tokens at all', () => {
    setup({ css: '' });
    expect(screen.getByTestId('studio-overview-cover')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Fantay' })).toBeTruthy();
  });
});

describe('StudioOverview brand book', () => {
  it('prints DESIGN.md whole as prose under the cover', () => {
    setup();
    expect(screen.getByRole('heading', { level: 2, name: 'Principles' })).toBeTruthy();
    expect(screen.getByRole('list').tagName).toBe('OL');
    expect(screen.getByText('ink').tagName).toBe('STRONG');
  });

  it('falls back to the intro when DESIGN.md has nothing else', () => {
    setup({ book: '' });
    expect(screen.getByText('ink').tagName).toBe('STRONG');
  });

  it('shows placeholders as one quiet block only when the brand book is empty', () => {
    setup({ book: '', intro: '', placeholderBlocks: true, blocks: [{ title: '设计原则', body: '写下原则' }] });
    expect(screen.getByRole('heading', { level: 2, name: '尚未填写的说明' })).toBeTruthy();
    expect(screen.getByText('写下原则').tagName).toBe('DD');
    cleanup();
    setup({ placeholderBlocks: true, blocks: [{ title: '设计原则', body: '写下原则' }] });
    expect(screen.queryByText('写下原则')).toBeNull();
  });

  it('offers editing DESIGN.md to an author only', () => {
    const onEditDocument = vi.fn();
    setup({ canEdit: true, onEditDocument });
    fireEvent.click(screen.getByRole('button', { name: '编辑手册' }));
    expect(onEditDocument).toHaveBeenCalled();
    cleanup();
    setup({ onEditDocument });
    expect(screen.queryByRole('button', { name: '编辑手册' })).toBeNull();
  });
});

describe('StudioOverview layers', () => {
  it('marks the layer meter and jumps to each target', () => {
    const { onJump } = setup({ canEdit: true });
    const meter = screen.getByRole('group', { name: '内容层级' });
    expect(within(meter).getByRole('button', { name: '原则 · 已有内容' }).getAttribute('title')).toBe('原则 · 已有内容');
    fireEvent.click(within(meter).getByRole('button', { name: '模板 · 尚未填写' }));
    expect(onJump).toHaveBeenCalledWith({ chapter: 'library', section: 'templates' });
  });

  it('shows the meter only to an author with something left to write', () => {
    setup();
    expect(screen.queryByRole('group', { name: '内容层级' })).toBeNull();
    cleanup();
    setup({ canEdit: true, layers: layers.map((layer) => ({ ...layer, done: true })) });
    expect(screen.queryByRole('group', { name: '内容层级' })).toBeNull();
  });

  it('shows only the title, the create action and start for a starter', () => {
    setup({ css: '', starter: true, actions: <button type="button">创建空白体系</button>, start: <p>从哪里开始</p>, blocks: [{ title: '设计原则', body: '写下原则' }], placeholderBlocks: true });
    expect(screen.getByRole('heading', { level: 1, name: 'Fantay' })).toBeTruthy();
    expect(screen.queryByTestId('studio-overview-cover')).toBeNull();
    expect(screen.queryByText('v1.2.0')).toBeNull();
    expect(screen.queryByText('写下原则')).toBeNull();
    expect(screen.getByRole('button', { name: '创建空白体系' })).toBeTruthy();
    expect(screen.getByTestId('studio-overview').lastElementChild?.textContent).toBe('从哪里开始');
  });
});
