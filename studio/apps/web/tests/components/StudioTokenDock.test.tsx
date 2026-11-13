// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyStudioDocument } from '@open-design/contracts';
import { StudioTokenDock } from '../../src/components/StudioTokenDock';

const dark = '[data-theme="dark"]';
const css = `:root { --bg: #ffffff; --fg: #353535; --space-4: 16px; }\n${dark} { --bg: #111111; --fg: #e8eadf; }`;
const themed = () => ({ ...emptyStudioDocument(), themes: [{ name: 'Dark', selector: dark, description: '' }] }) as ReturnType<typeof emptyStudioDocument>;

type DockProps = Parameters<typeof StudioTokenDock>[0];
function dock(overrides: Partial<DockProps> = {}) {
  const onSave = vi.fn(async (_css: string) => {});
  const onClose = vi.fn();
  const onNote = vi.fn();
  const props: DockProps = { name: '--bg', css, document: themed(), editable: true, busy: false, chinese: false, onSave, onNote, onClose, ...overrides };
  const view = render(<StudioTokenDock {...props} />);
  return { onSave, onClose, onNote, props, ...view };
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('token dock', () => {
  it('saves an edit left while the field was busy once the field is free again', async () => {
    const { onSave, rerender, props } = dock();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '--bg · :root' });
    fireEvent.change(input, { target: { value: '#eeeeee' } });
    rerender(<StudioTokenDock {...props} busy />);
    expect(input.readOnly).toBe(true);
    fireEvent.blur(input);
    expect(onSave).not.toHaveBeenCalled();
    expect(input.value).toBe('#eeeeee');
    // Another save landed meanwhile; the pending edit applies on top of it, not on the stale css.
    const landed = css.replace('--fg: #353535', '--fg: #303030');
    rerender(<StudioTokenDock {...props} css={landed} busy={false} />);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toContain('--bg: #eeeeee');
    expect(onSave.mock.calls[0]![0]).toContain('--fg: #303030');
  });

  it('drops a pending edit on escape', () => {
    const { onSave, rerender, props } = dock();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '--bg · :root' });
    fireEvent.change(input, { target: { value: '#eeeeee' } });
    rerender(<StudioTokenDock {...props} busy />);
    fireEvent.blur(input);
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    rerender(<StudioTokenDock {...props} busy={false} />);
    expect(onSave).not.toHaveBeenCalled();
    expect(input.value).toBe('#ffffff');
  });

  it('one escape closes a dialog that removes itself, but not the dock under it', () => {
    const { onClose } = dock();
    const dialog = window.document.body.appendChild(window.document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    dialog.tabIndex = -1;
    // The studio closes its dialogs from a document listener, which runs before a bubbling window one.
    const closeDialog = (event: KeyboardEvent) => { if (event.key === 'Escape') dialog.remove(); };
    window.document.addEventListener('keydown', closeDialog);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    window.document.removeEventListener('keydown', closeDialog);
    expect(dialog.isConnected).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('leaves escape to an open menu, and marks the key used when it closes', () => {
    const { onClose } = dock();
    const menu = window.document.body.appendChild(window.document.createElement('div'));
    menu.setAttribute('role', 'menu');
    fireEvent.keyDown(window.document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    menu.remove();
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.document.body.dispatchEvent(event);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('offers no notes editor on a read-only preset', () => {
    dock({ editable: false });
    expect(screen.queryByRole('button', { name: 'Edit notes --bg' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close details' })).toBeTruthy();
  });

  it('copies the value of the theme on screen', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    vi.stubGlobal('navigator', { ...window.navigator, clipboard: { writeText } });
    const { rerender, props } = dock({ name: '--fg' });
    expect(screen.getByRole('button', { name: 'Copy value' }).getAttribute('title')).toBe('#353535');
    rerender(<StudioTokenDock {...props} scope={dark} />);
    const copy = screen.getByRole('button', { name: 'Copy value' });
    expect(copy.getAttribute('title')).toBe('#e8eadf · Dark');
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('#e8eadf'));
  });

  it('drops the theme caption when there is only one theme', () => {
    const { unmount } = dock({ name: '--space-4' });
    expect(screen.getByRole('textbox', { name: '--space-4 · :root' })).toBeTruthy();
    expect(screen.queryByText('Light')).toBeNull();
    unmount();
    dock({ name: '--fg' });
    expect(screen.getByText('Light')).toBeTruthy();
    expect(screen.getByText('Dark')).toBeTruthy();
  });

  it('scrolls an opened colour card clear of the panel, alias or not', () => {
    const card = window.document.body.appendChild(window.document.createElement('div'));
    card.setAttribute('data-palette-card', '--bg');
    card.setAttribute('data-palette-aliases', '--color-paper --page');
    const hit = card.appendChild(window.document.createElement('button'));
    hit.setAttribute('aria-pressed', 'true');
    card.scrollIntoView = vi.fn();
    const { rerender, props, onClose } = dock();
    expect(card.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }));
    expect(card.style.scrollMarginBottom).toMatch(/px$/);
    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));
    expect(window.document.activeElement).toBe(hit);
    expect(onClose).toHaveBeenCalled();
    rerender(<StudioTokenDock {...props} name={null} />);
    rerender(<StudioTokenDock {...props} css={css + '\n:root { --page: #ffffff; }'} name="--page" />);
    expect(card.scrollIntoView).toHaveBeenCalledTimes(2);
    card.remove();
  });
});
