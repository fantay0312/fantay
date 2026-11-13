// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignSystemStudio } from '../../src/components/DesignSystemStudio';
import { readStudioFile, saveStudioFile } from '../../src/runtime/design-system-studio';

vi.mock('../../src/components/DesignKitView', () => ({ useBrandFonts: () => {}, HeaderActionsMenu: () => null }));
vi.mock('../../src/runtime/design-system-studio', async () => ({
  ...await vi.importActual('../../src/runtime/design-system-studio'),
  // Only the token file exists: a package page in components.html would count as a components layer.
  readStudioFile: vi.fn(async (url:string) => /studio\.json|components\.html/.test(url)?null:':root { --accent: #123456; --space-md: 16px; --radius-sm: 4px; --shadow-sm: 0 2px 4px #0002; }'),
  saveStudioFile: vi.fn(async () => 'p1'),
}));
vi.mock('../../src/providers/registry', async () => ({
  ...await vi.importActual('../../src/providers/registry'),
  fetchProjectFiles: vi.fn(async () => [{ name: 'tokens.css', path: 'tokens.css' }]),
}));
const kit = { name: 'Example', designSystemId: 'user:example', projectId: 'p1', editable: true, canUpload: true, colors: [], fonts: [], typography: {}, logoAlternates: [] };
// Chapters are reached through the section menu: each opens on its first section.
const FIRST_SECTION: Record<string, string> = { Overview: 'Overview', Foundations: 'Colors', Library: 'Components', Guidelines: 'Content guidelines', Files: 'Files' };
const sectionMenu = () => screen.findByRole('button', { name: /^Go to section: / });
const currentSection = () => screen.getByRole('button', { name: /^Go to section: / }).getAttribute('aria-label')?.replace(/^Go to section: /, '');
const openChapter = async (name: string) => {
  fireEvent.click(await sectionMenu());
  fireEvent.click(await screen.findByRole('option', { name: new RegExp('^' + (FIRST_SECTION[name] ?? name)) }));
};
const accentCard = () => screen.findByRole('button', { name: /^Accent 123456/ });
// The board shows its accent card open by default, and a click on an open card closes it.
const selectAccent = async () => {
  fireEvent.click(await accentCard());
  const card = await accentCard();
  if (card.getAttribute('aria-pressed') !== 'true') fireEvent.click(card);
};
// jsdom lays nothing out: every box sits at the top, so the studio's scroll spy would read the whole
// continuous page as already passed and name its last section. Chapters and sections are stacked
// 600px apart in document order instead, offset by the scroller's scrollTop.
const MARKERS = '[data-chapter], [data-section]';
let restoreLayout: (() => void) | null = null;
function stackStudioLayout() {
  const original = HTMLElement.prototype.getBoundingClientRect;
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const scroller = this.closest<HTMLElement>('[data-studio-scroll]');
    const index = scroller && this !== scroller && this.matches(MARKERS) ? Array.from(scroller.querySelectorAll(MARKERS)).indexOf(this) : -1;
    if (!scroller || index < 0) return original.call(this);
    const top = index * 600 - scroller.scrollTop;
    return { x: 0, y: top, top, left: 0, right: 800, bottom: top + 600, width: 800, height: 600, toJSON: () => ({}) } as DOMRect;
  });
  restoreLayout = () => spy.mockRestore();
}
const studioScroller = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-studio-scroll]')!;
/** Scrolls the page so `node` sits at the scroller's top, past the reading line. */
const scrollTo = (scroller: HTMLElement, node: Element) => {
  scroller.scrollTop += node.getBoundingClientRect().top;
  fireEvent.scroll(scroller);
};
afterEach(() => { cleanup(); restoreLayout?.(); restoreLayout = null; vi.clearAllMocks(); vi.unstubAllGlobals(); window.localStorage.clear(); });

describe('design system studio', () => {
  beforeEach(() => stackStudioLayout());
  it('opens on the overview, with the section menu naming it and listing every section', async () => {
    render(<DesignSystemStudio kit={kit} body={'# Example\n\nA clear system.'} editable />);
    fireEvent.click(await sectionMenu());
    expect(currentSection()).toBe('Overview');
    const options = screen.getAllByRole('option').map((option) => option.querySelector('[class*="optionLabel"]')?.textContent ?? '');
    expect(options[0]).toBe('Overview');
    expect(options).toEqual(expect.arrayContaining(['Colors', 'Corner radius', 'Components', 'Governance']));
    expect(options.at(-1)).toMatch(/^Files/);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search' }), { key: 'Escape' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Example' })).toBeInTheDocument();
    // Every chapter is on one continuous page, the overview first.
    expect(document.querySelector('[data-chapter]')).toHaveAttribute('data-chapter', 'overview');
  });
  it('names the section the reader has scrolled to, and hands over once the previous one leaves', async () => {
    const view = render(<DesignSystemStudio kit={kit} body="# Example" editable />);
    await accentCard();
    const scroller = studioScroller(view.container);
    // A tall page, so a scroll short of the end is not read as having reached it.
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 100_000 });
    expect(currentSection()).toBe('Overview');
    scrollTo(scroller, view.container.querySelector('[data-section="colors"]')!);
    await waitFor(() => expect(currentSection()).toBe('Colors'));
    // Typography sits between them; once spacing reaches the reading line it is what is being read.
    scrollTo(scroller, view.container.querySelector('[data-section="spacing"]')!);
    await waitFor(() => expect(currentSection()).toBe('Spacing'));
  });
  it('edits the actual token source through the card and the dock, and says so in the header', async () => {
    const view = render(<DesignSystemStudio kit={kit} body={'# Example\n\nA clear system.'} editable />);
    await openChapter('Foundations');
    await selectAccent();
    const token = await screen.findByRole('textbox',{name:'--accent · :root'});
    await waitFor(() => expect(token).not.toHaveAttribute('readonly'));
    fireEvent.change(token,{target:{value:'#abcdef'}});fireEvent.blur(token);
    await waitFor(() => expect(saveStudioFile).toHaveBeenCalledWith(expect.objectContaining({ path: 'tokens.css', content: expect.stringContaining('--accent: #abcdef') })));
    await waitFor(() => expect(view.container.querySelector('header [aria-live]')).toHaveTextContent('Saved'));
  });
  it('reads a file without claiming a save, and closes it with Close', async () => {
    const view = render(<DesignSystemStudio kit={kit} body="# Example" editable />);
    await openChapter('Files');
    fireEvent.click(await screen.findByRole('button', { name: 'tokens.css' }));
    const dialog = await screen.findByRole('dialog', { name: 'tokens.css' });
    expect(view.container.querySelector('header [aria-live]')).toHaveTextContent('');
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(view.container.querySelector('header [aria-live]')).toHaveTextContent('');
  });
  it('keeps typography open on an editable system that has no type tokens yet', async () => {
    render(<DesignSystemStudio kit={kit} body="# Example" editable />);
    await openChapter('Foundations');
    expect(await screen.findByRole('heading', { name: 'Typography' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload font' })).toBeInTheDocument();
  });
  it('does not offer a file upload to the starter, which has no system to put files in', async () => {
    render(<DesignSystemStudio kit={{ ...kit, designSystemId: undefined, editable: false }} body="" />);
    expect((await screen.findByText('Upload brand files')).closest('button')).toBeDisabled();
  });
  it('gives every chapter its own sections on the one page', async () => {
    const view = render(<DesignSystemStudio kit={kit} body={'# Example\n\nA clear system.'} editable />);
    await accentCard();
    const chapterBlock = (chapterId: string) => view.container.querySelector<HTMLElement>(`[data-chapter="${chapterId}"]`)!;
    const foundations = chapterBlock('foundations');
    expect(within(foundations).getByRole('heading', { name: 'Corner radius' })).toBeInTheDocument();
    expect(within(foundations).getByRole('heading', { name: 'Shadows' })).toBeInTheDocument();
    expect(within(foundations).queryByRole('heading', { name: 'Patterns' })).not.toBeInTheDocument();
    const library = chapterBlock('library');
    expect(within(library).getByRole('heading', { name: 'Patterns' })).toBeInTheDocument();
    expect(within(library).getByRole('heading', { name: 'Templates' })).toBeInTheDocument();
    expect(within(chapterBlock('guidelines')).getByRole('heading', { name: 'Governance' })).toBeInTheDocument();
    expect(await within(chapterBlock('files')).findByRole('button', { name: 'tokens.css' })).toBeInTheDocument();
    expect(screen.queryByText('No logo yet')).not.toBeInTheDocument();
  });
  it('keeps an undefined section in place and empty, adding from its heading only while editable', async () => {
    const view = render(<DesignSystemStudio kit={kit} body="# Example" editable />);
    await openChapter('Foundations');
    await accentCard();
    const motion = (await screen.findByRole('heading', { name: 'Motion' })).closest('section')!;
    expect(within(motion).getByText('No tokens in this group yet. Use Add to create one.')).toBeInTheDocument();
    fireEvent.click(within(motion).getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('dialog', { name: 'Motion' })).toBeInTheDocument();
    view.unmount();
    render(<DesignSystemStudio kit={kit} body="# Example" editable={false} />);
    await openChapter('Foundations');
    await accentCard();
    const preset = (await screen.findByRole('heading', { name: 'Motion' })).closest('section')!;
    expect(within(preset).getByText('This design system does not define this section; it is left empty.')).toBeInTheDocument();
    expect(within(preset).queryByRole('button', { name: 'Add' })).not.toBeInTheDocument();
  });
  it('lists every section of a preset in the menu, the empty ones marked, never dropped', async () => {
    render(<DesignSystemStudio kit={kit} body="# Example" editable={false} />);
    fireEvent.click(await sectionMenu());
    const options = screen.getAllByRole('option');
    const labels = options.map((option) => option.querySelector('[class*="optionLabel"]')?.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Measure', 'Sizing & ratios', 'Blocks', 'Rules & review', 'Assets', 'Patterns', 'Templates', 'Content guidelines', 'Code & design', 'Governance']));
    // Reading order: line length, then sizes; rules open the guidelines.
    expect(labels.indexOf('Sizing & ratios')).toBe(labels.indexOf('Measure') + 1);
    expect(labels.indexOf('Blocks')).toBe(labels.indexOf('Components') + 1);
    expect(labels.indexOf('Rules & review')).toBeLessThan(labels.indexOf('Content guidelines'));
    expect(labels).not.toContain('Other tokens');
    const measure = options.find((option) => option.textContent?.startsWith('Measure'))!;
    expect(measure).toHaveAttribute('data-empty');
    expect(measure).toHaveTextContent('Empty');
    expect(options.find((option) => option.textContent?.startsWith('Colors'))).not.toHaveAttribute('data-empty');
  });
  it('switches foundations to the table and remembers the choice', async () => {
    const view = render(<DesignSystemStudio kit={kit} body="# Example" editable />);
    await openChapter('Foundations');
    await accentCard();
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(await screen.findByRole('textbox', { name: '--accent · :root' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Accent 123456/ })).not.toBeInTheDocument();
    view.unmount();
    render(<DesignSystemStudio kit={kit} body="# Example" editable />);
    await openChapter('Foundations');
    expect(await screen.findByRole('radio', { name: 'Table' })).toHaveAttribute('aria-checked', 'true');
  });
  it('only offers the getting-started sources to a system that has barely begun', async () => {
    const view = render(<DesignSystemStudio kit={kit} body="# Example" editable />);
    expect(await screen.findByText('Sync from GitHub')).toBeInTheDocument();
    view.unmount();
    render(<DesignSystemStudio kit={kit} body={'# Example\n\n## Principles\n\nClarity first.'} editable={false} />);
    await screen.findByRole('button', { name: 'Create an editable copy' });
    expect(screen.queryByText('Sync from GitHub')).not.toBeInTheDocument();
  });
  it('withholds source mutation controls on read-only systems', async () => {
    render(<DesignSystemStudio kit={kit} body="# Example" editable={false} />);
    expect(await screen.findByRole('button', { name: 'Create an editable copy' })).toBeInTheDocument();
    await openChapter('Foundations');
    await selectAccent();
    expect(await screen.findByRole('textbox',{name:'--accent · :root'})).toHaveAttribute('readonly');
    expect(screen.queryByRole('button', { name: /^Add$/ })).not.toBeInTheDocument();
  });
  it('reports a failed inline save without discarding the entered value', async () => {
    vi.mocked(saveStudioFile).mockRejectedValueOnce(new Error('SYNC_FAILED'));
    render(<DesignSystemStudio kit={kit} body="# Example" editable />);
    await openChapter('Foundations');
    await selectAccent();
    const token = await screen.findByRole('textbox',{name:'--accent · :root'});
    await waitFor(() => expect(token).not.toHaveAttribute('readonly'));
    fireEvent.change(token,{target:{value:'#abcdef'}});fireEvent.blur(token);
    expect(await screen.findByRole('alert')).toHaveTextContent('Not saved');
    expect(token).toHaveValue('#abcdef');
  });
  it('leaves the name to a host that already shows it, until full screen hides that host', async () => {
    render(<DesignSystemStudio kit={kit} body="# Example" editable={false} embedded />);
    await sectionMenu();
    expect(screen.queryByTitle('Example')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(await screen.findByTitle('Example')).toBeInTheDocument();
  });
  it('lands on the last chapter asked for when jumps outrun the scroll', async () => {
    const view = render(<DesignSystemStudio kit={kit} body="# Example" editable />);
    await screen.findByRole('heading', { level: 1, name: 'Example' });
    // A jump is a scroll on the one page: record where each one aims, without moving.
    const scroller = studioScroller(view.container);
    const scrolls: number[] = [];
    scroller.scrollTo = ((options: ScrollToOptions) => { scrolls.push(options.top ?? 0); }) as typeof scroller.scrollTo;
    await openChapter('Foundations');
    await openChapter('Overview');
    expect(scrolls).toHaveLength(2);
    expect(scrolls[0]).toBeGreaterThan(0);
    expect(scrolls.at(-1)).toBe(0);
    // The first jump's scroll never landed; the bar keeps the last target, not where it was headed.
    expect(currentSection()).toBe('Overview');
  });
  it('resets to the overview and never shows the previous system when the id changes', async () => {
    const view = render(<DesignSystemStudio kit={kit} body="# Example" editable />);
    await openChapter('Foundations');
    await accentCard();
    const pending: ((css: string) => void)[] = [];
    vi.mocked(readStudioFile).mockImplementation((url: string) => url.includes('studio.json') ? Promise.resolve(null) : new Promise((resolve) => { pending.push(resolve); }));
    view.rerender(<DesignSystemStudio kit={{ ...kit, name: 'Second', designSystemId: 'user:second', projectId: 'p2' }} body="# Second" editable />);
    expect(screen.getByRole('status', { name: 'Loading…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Accent 123456/ })).not.toBeInTheDocument();
    await act(async () => { for (const finish of pending) finish(':root { --accent: #654321; }'); });
    expect(await screen.findByRole('heading', { level: 1, name: 'Second' })).toBeInTheDocument();
    expect(currentSection()).toBe('Overview');
    expect(screen.queryByRole('status', { name: 'Loading…' })).not.toBeInTheDocument();
  });
});
