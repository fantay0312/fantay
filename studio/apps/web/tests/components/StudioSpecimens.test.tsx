// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { emptyStudioDocument, parseStudioTokens, type StudioTokenGroup } from '@open-design/contracts';
import { StudioSpecimens, StudioTokenMini, studioSpecimenNames, specimenTokenLabel, specimenTokenNote } from '../../src/components/StudioSpecimens';
import { StudioTokenDock } from '../../src/components/StudioTokenDock';

const css = `:root {
  --bg: #ffffff; --surface: #fafafa; --fg: #202020; --border-soft: #ededed; --accent: var(--fg);
  --font-display: "Albert Sans", sans-serif; --font-body: Inter, sans-serif; --font-mono: ui-monospace, monospace;
  --text-xs: 12px; --text-4xl: 96px; --leading-body: 1.5; --tracking-display: -0.02em; --font-weight-bold: 700;
  --space-1: 4px; --space-4: 16px;
  --radius-sm: 8px; --radius-pill: 9999px;
  --elev-flat: none; --elev-raised: 0 6px 24px rgba(0, 0, 0, 0.1); --focus-ring: 0 0 0 2px #1a74ff;
  --motion-fast: 140ms; --ease-standard: cubic-bezier(0.2, 0, 0, 1); --ease-steps: steps(4);
  --container-max: 1280px; --container-gutter-desktop: 24px; --breakpoint-md: 768px;
  --section-y-desktop: 96px;
  --measure-body: 65ch; --z-modal: 100; --z-toast: 200; --tm-header-height: 82px;
  --size-8: 2rem; --size-hero: 160px; --icon-size-sm: 16px; --control-height-md: 40px; --target-min: 24px;
  --aspect-video: 16 / 9; --aspect-square: 1; --ratio-golden: 1.618/1; --aspect-auto: auto;
}
[data-theme="dark"] { --bg: #111111; --fg: #fafafa; --elev-raised: 0 6px 24px rgba(0, 0, 0, 0.4); }`;
const tokens = parseStudioTokens(css);
const notes = {};
const dark = '[data-theme="dark"]';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function specimen(group: Exclude<StudioTokenGroup, 'colors'>, selected: string | null = null) {
  const onSelect = vi.fn();
  render(<StudioSpecimens group={group} tokens={tokens} scope=":root" notes={notes} chinese selected={selected} onSelect={onSelect} />);
  return onSelect;
}
const tile = (name: string) => screen.getByRole('button', { name: new RegExp('^' + name + ' ') });

describe('font families', () => {
  it('labels an uploaded font as another family and reads its file name as a family name', () => {
    const uploaded = parseStudioTokens(':root { --font-display: Georgia, serif; --font-albertsans-variablefont-wght-mvoubhlw: "AlbertSans-VariableFont_wght"; }');
    render(<StudioSpecimens group="typography" tokens={uploaded} scope=":root" notes={notes} chinese selected={null} onSelect={vi.fn()} />);
    expect(screen.getByText('其他字体')).toBeTruthy();
    expect(screen.getByText('Albert Sans')).toBeTruthy();
    expect(screen.getByText('标题字体')).toBeTruthy();
    expect(screen.queryByText(/variablefont wght/)).toBeNull();
  });
});

describe('specimens', () => {
  it.each([
    ['typography', ['--font-display', '--font-body', '--font-mono', '--text-xs', '--text-4xl', '--leading-body', '--tracking-display', '--font-weight-bold']],
    ['spacing', ['--space-1', '--space-4']],
    ['radius', ['--radius-sm', '--radius-pill']],
    ['shadows', ['--elev-flat', '--elev-raised', '--focus-ring']],
    ['motion', ['--motion-fast', '--ease-standard', '--ease-steps']],
    ['layout', ['--container-max', '--container-gutter-desktop', '--breakpoint-md', '--section-y-desktop']],
    ['measure', ['--measure-body']],
    ['sizing', ['--size-8', '--size-hero', '--icon-size-sm', '--control-height-md', '--target-min', '--aspect-video', '--aspect-square', '--ratio-golden', '--aspect-auto']],
    ['layers', ['--z-modal', '--z-toast']],
    ['other', ['--tm-header-height']],
  ] as const)('%s draws every token as a selectable tile', (group, names) => {
    const onSelect = specimen(group, names[1] ?? null);
    expect(screen.getAllByRole('button')).toHaveLength(names.length);
    for (const name of names) expect(tile(name).getAttribute('aria-pressed')).toBe(String(name === (names[1] ?? null)));
    fireEvent.click(tile(names[0]));
    expect(onSelect).toHaveBeenLastCalledWith(names[0]);
  });

  it('clears the selection when the selected tile is pressed again', () => {
    const onSelect = specimen('radius', '--radius-sm');
    fireEvent.click(tile('--radius-sm'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('keeps families out of the size ladder, largest size first, clamped but truthfully labelled', () => {
    specimen('typography');
    const ladder = within(screen.getByRole('heading', { name: '字号' }).closest('section')!).getAllByRole('button');
    expect(ladder.map((button) => button.getAttribute('data-token'))).toEqual(['--text-4xl', '--text-xs']);
    expect(ladder[0]!.textContent).toContain('96px');
    expect(ladder[0]!.querySelector('[style*="font-size"]')!.getAttribute('style')).toContain('font-size: 64px');
  });

  it('files the focus ring under shadows and section spacing under layout', () => {
    expect(studioSpecimenNames('shadows', tokens)).toContain('--focus-ring');
    expect(studioSpecimenNames('layout', tokens)).toContain('--section-y-desktop');
    expect(studioSpecimenNames('other', tokens)).toEqual(['--tm-header-height']);
  });

  it('draws values for the theme in view', () => {
    render(<StudioSpecimens group="shadows" tokens={tokens} scope={dark} notes={notes} chinese={false} selected={null} onSelect={() => {}} />);
    expect(tile('--elev-raised').getAttribute('aria-label')).toContain('0.4');
  });

  it('draws sizes smallest first at true size, capped but truthfully labelled, ratios as frames and the rest compact', () => {
    specimen('sizing');
    const scale = screen.getByRole('heading', { name: '尺寸档位' }).closest('section')!;
    expect(within(scale).getAllByRole('button').map((button) => button.getAttribute('data-token'))).toEqual(['--icon-size-sm', '--target-min', '--size-8', '--control-height-md', '--size-hero']);
    expect(scale.textContent).toContain('超过 96px 的缩小显示');
    const drawing = (name: string, kind: string) => tile(name).querySelector(`[data-kind="${kind}"]`);
    expect(drawing('--icon-size-sm', 'icon')!.querySelector('svg')).not.toBeNull();
    expect(drawing('--icon-size-sm', 'icon')!.getAttribute('style')).toContain('width: 16px');
    expect(drawing('--target-min', 'target')!.getAttribute('style')).toContain('height: 24px');
    expect(drawing('--control-height-md', 'control')!.getAttribute('style')).toContain('height: 40px');
    expect(drawing('--size-8', 'square')!.getAttribute('style')).toContain('width: 32px');
    expect(drawing('--size-hero', 'square')!.getAttribute('style')).toContain('width: 96px');
    expect(tile('--size-hero').textContent).toContain('160px · 60%');
    expect(tile('--target-min').textContent).toContain('最小点击目标');
    const ratios = within(screen.getByRole('heading', { name: '宽高比' }).closest('section')!).getAllByRole('button');
    expect(ratios.map((button) => button.getAttribute('data-token'))).toEqual(['--aspect-square', '--ratio-golden', '--aspect-video']);
    expect(drawing('--aspect-video', 'ratio')!.getAttribute('style')).toContain('aspect-ratio: 16 / 9');
    expect(drawing('--ratio-golden', 'ratio')!.getAttribute('style')).toContain('aspect-ratio: 1.618 / 1');
    expect(tile('--aspect-video').textContent).toContain('16 / 9');
    expect(tile('--aspect-auto').closest('section')).toBeNull();
    expect(tile('--aspect-auto').querySelector('[data-kind]')).toBeNull();
  });

  it('says about how many characters a measure holds, for character units only', () => {
    const lines = parseStudioTokens(':root { --measure-prose: 65ch; --measure-cjk: 36ic; --measure-wide: 30em; --measure-fixed: 640px; }');
    const view = (chinese: boolean) => <StudioSpecimens group="measure" tokens={lines} scope=":root" notes={notes} chinese={chinese} selected={null} onSelect={vi.fn()} />;
    const { rerender } = render(view(true));
    expect(tile('--measure-prose').textContent).toContain('约 65 个西文字符');
    expect(tile('--measure-cjk').textContent).toContain('约 36 个汉字');
    expect(tile('--measure-wide').textContent).toContain('约 30 个汉字');
    expect(tile('--measure-fixed').textContent).not.toMatch(/约 \d+ 个/);
    rerender(view(false));
    expect(tile('--measure-prose').textContent).toContain('≈ 65 Latin characters');
    expect(tile('--measure-cjk').textContent).toContain('≈ 36 CJK characters');
  });

  it('draws a ratio in the dock mini with its longer side filling the frame', () => {
    const { container, rerender } = render(<StudioTokenMini name="--aspect-portrait" group="sizing" value="3 / 4" ink="#202020" ground="#ffffff" />);
    expect(container.querySelector('[style*="aspect-ratio"]')!.getAttribute('style')).toContain('height: 28px');
    rerender(<StudioTokenMini name="--aspect-video" group="sizing" value="16 / 9" ink="#202020" ground="#ffffff" />);
    expect(container.querySelector('[style*="aspect-ratio"]')!.getAttribute('style')).toContain('width: 28px');
    rerender(<StudioTokenMini name="--aspect-auto" group="sizing" value="auto" ink="#202020" ground="#ffffff" />);
    expect(container.querySelector('[style*="aspect-ratio"]')).toBeNull();
  });

  it('orders layers by z-index and prints the value on each plane', () => {
    specimen('layers');
    const planes = screen.getAllByRole('button');
    expect(planes.map((plane) => plane.getAttribute('data-token'))).toEqual(['--z-modal', '--z-toast']);
    expect(planes[1]!.textContent).toContain('200');
  });

  it('has a plain line for an empty group', () => {
    render(<StudioSpecimens group="spacing" tokens={[]} scope=":root" notes={notes} chinese selected={null} onSelect={() => {}} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('这一组还没有设计变量。')).toBeTruthy();
  });

  it('names the shared schema in Chinese and falls back to the variable', () => {
    expect(specimenTokenLabel('--radius-pill', true)).toBe('胶囊');
    expect(specimenTokenLabel('--text-xs', true)).toBe('字号 XS');
    expect(specimenTokenLabel('--space-4', false)).toBe('Space 4');
    expect(specimenTokenLabel('--tm-header-height', false)).toBe('Tm header height');
    expect(specimenTokenNote('--focus-ring', {}, true)).toBe('键盘焦点的标记');
    expect(specimenTokenNote('--focus-ring', { '--focus-ring': { description: 'Own note', group: '', layer: 'semantic' } }, true)).toBe('Own note');
  });

  it('names size families, keeps font sizes as type, and calls a measure a line length', () => {
    expect(specimenTokenLabel('--icon-size-sm', true)).toBe('小图标');
    expect(specimenTokenLabel('--icon-size-xl', true)).toBe('图标 XL');
    expect(specimenTokenLabel('--control-height-xl', false)).toBe('Control XL');
    expect(specimenTokenLabel('--target-comfort', true)).toBe('舒适触控目标');
    expect(specimenTokenLabel('--touch-lg', true)).toBe('点击目标 LG');
    expect(specimenTokenLabel('--aspect-cinema', false)).toBe('Ratio cinema');
    expect(specimenTokenLabel('--base-size-4', true)).toBe('尺寸 4');
    expect(specimenTokenLabel('--font-size-sm', true)).toBe('字号 SM');
    expect(specimenTokenLabel('--measure-body', true)).toBe('行宽 body');
    expect(specimenTokenNote('--target-min', {}, true)).toContain('WCAG 2.5.8');
    expect(specimenTokenNote('--measure-cjk', {}, false)).toContain('40 CJK');
  });
});

describe('token dock', () => {
  const document = () => ({ ...emptyStudioDocument(), themes: [{ name: 'Dark', selector: dark }] }) as ReturnType<typeof emptyStudioDocument>;
  function dock(overrides: Partial<Parameters<typeof StudioTokenDock>[0]> = {}) {
    const onSave = vi.fn(async (_css: string) => {});
    const onClose = vi.fn();
    const onNote = vi.fn();
    const view = render(<StudioTokenDock name="--bg" css={css} document={document()} editable busy={false} chinese={false} onSave={onSave} onNote={onNote} onClose={onClose} {...overrides} />);
    return { onSave, onClose, onNote, ...view };
  }

  it('stays mounted but hidden from assistive tech while nothing is selected', () => {
    const { container } = dock({ name: null });
    expect(container.querySelector('section')).not.toBeNull();
    expect(container.querySelector('section')!.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('section')!.hasAttribute('inert')).toBe(true);
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('keeps the last token visible while it closes', () => {
    const { rerender, container } = dock();
    rerender(<StudioTokenDock name={null} css={css} document={document()} editable busy={false} chinese={false} onSave={async () => {}} onNote={() => {}} onClose={() => {}} />);
    expect(container.textContent).toContain('--bg');
    expect(container.querySelector('[data-open]')).toBeNull();
  });

  it('shows one field per theme, with the inherited value as a placeholder', () => {
    dock({ name: '--surface' });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '--surface · :root' }).value).toBe('#fafafa');
    const inherited = screen.getByRole<HTMLInputElement>('textbox', { name: `--surface · ${dark}` });
    expect(inherited.value).toBe('');
    expect(inherited.placeholder).toBe('Inherits #fafafa');
  });

  it('saves on enter through the shared edit path', async () => {
    const { onSave } = dock();
    const input = screen.getByRole('textbox', { name: '--bg · :root' });
    fireEvent.change(input, { target: { value: '#eeeeee' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toContain('--bg: #eeeeee');
  });

  it('escape cancels the draft without saving or closing', () => {
    const { onSave, onClose } = dock();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '--bg · :root' });
    fireEvent.change(input, { target: { value: '#eeeeee' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(input.value).toBe('#ffffff');
  });

  it('escape outside an input closes, unless a dialog owns it', () => {
    const { onClose } = dock();
    const dialog = window.document.body.appendChild(window.document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    dialog.remove();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clearing an override restores inheritance', async () => {
    const { onSave } = dock();
    const input = screen.getByRole('textbox', { name: `--bg · ${dark}` });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(parseStudioTokens(onSave.mock.calls[0]![0]).filter((token) => token.name === '--bg')).toEqual([expect.objectContaining({ value: '#ffffff', scope: ':root' })]);
  });

  it('shows a refused value in an alert and keeps what was typed', async () => {
    const { onSave } = dock({ name: '--accent' });
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '--accent · :root' });
    fireEvent.change(input, { target: { value: 'var(--missing)' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('alias'));
    expect(onSave).not.toHaveBeenCalled();
    expect(input.value).toBe('var(--missing)');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('keeps the typed value when the save itself fails', async () => {
    const input = () => screen.getByRole<HTMLInputElement>('textbox', { name: '--bg · :root' });
    dock({ onSave: vi.fn(async () => { throw new Error('offline'); }) });
    fireEvent.change(input(), { target: { value: '#eeeeee' } });
    fireEvent.blur(input());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Not saved'));
    expect(input().value).toBe('#eeeeee');
  });

  it('refuses to empty the base value', async () => {
    dock();
    const input = screen.getByRole('textbox', { name: '--bg · :root' });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('base theme'));
  });

  it('read-only presets expose values and copying, but no way to edit', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { ...window.navigator, clipboard: { writeText } });
    const { onSave } = dock({ editable: false });
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '--bg · :root' });
    expect(input.readOnly).toBe(true);
    fireEvent.change(input, { target: { value: '#eeeeee' } });
    fireEvent.blur(input);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Delete --bg' })).toBeNull();
    expect(screen.queryByLabelText(/^Pick colour/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy variable' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy value' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(writeText.mock.calls.map((call) => call[0])).toEqual(['var(--bg)', '#ffffff']);
    vi.unstubAllGlobals();
  });

  it('the swatch picker saves the settled colour', async () => {
    const { onSave } = dock();
    const picker = screen.getByLabelText('Pick colour --bg · :root');
    fireEvent.input(picker, { target: { value: '#112233' } });
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '--bg · :root' }).value).toBe('#112233');
    expect(onSave).not.toHaveBeenCalled();
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]![0]).toContain('--bg: #112233');
  });

  it('prints the resolved alias', () => {
    dock({ name: '--accent' });
    expect(screen.getAllByText('↳ #202020')).toHaveLength(1);
  });

  it('grades text against the ground, but never a surface', () => {
    const { unmount } = dock({ name: '--fg' });
    expect(screen.getAllByText(/^AAA \d/).length).toBeGreaterThan(0);
    unmount();
    dock({ name: '--border-soft' });
    expect(screen.getAllByText(/:1$/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^(AAA|AA|Large|Low) /)).toBeNull();
  });

  it('shows a multi-line value on one line without treating that as an edit', () => {
    const multi = ':root {\n  --elev-raised:\n    0 1px 2px red,\n    0 2px 4px blue;\n}';
    const { onSave } = dock({ name: '--elev-raised', css: multi });
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '--elev-raised · :root' });
    expect(input.value).toBe('0 1px 2px red, 0 2px 4px blue');
    fireEvent.blur(input);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('scrolls the picked tile clear of the panel and returns focus to it on close', () => {
    const tile = window.document.body.appendChild(window.document.createElement('button'));
    tile.setAttribute('data-token', '--bg');
    tile.scrollIntoView = vi.fn();
    const { onClose } = dock();
    expect(tile.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(window.document.activeElement).toBe(tile);
    expect(onClose).toHaveBeenCalled();
    tile.remove();
  });

  it('deletes in every theme after confirming, then closes', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onSave, onClose } = dock();
    fireEvent.click(screen.getByRole('button', { name: 'Delete --bg' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(parseStudioTokens(onSave.mock.calls[0]![0]).some((token) => token.name === '--bg')).toBe(false);
  });

  it('explains a delete refused by a reference', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onSave, onClose } = dock({ name: '--fg' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete --fg' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('still reference'));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('close and notes reach the host', () => {
    const { onClose, onNote } = dock();
    fireEvent.click(screen.getByRole('button', { name: 'Edit notes --bg' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(onNote).toHaveBeenCalledWith('--bg');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('swapping tokens crossfades without doubling the live fields', () => {
    const { rerender } = dock();
    rerender(<StudioTokenDock name="--surface" css={css} document={document()} editable busy={false} chinese={false} onSave={async () => {}} onNote={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('textbox', { name: '--bg · :root' })).toBeNull();
    expect(screen.getByRole('textbox', { name: '--surface · :root' })).toBeTruthy();
  });
});
