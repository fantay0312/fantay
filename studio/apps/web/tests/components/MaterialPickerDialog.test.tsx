// @vitest-environment jsdom
//
// The composer's material picker is aria-modal: Tab must stay inside it.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MaterialPickerDialog } from '../../src/components/materials/MaterialPickerDialog';
import { I18nProvider } from '../../src/i18n';
import { MockIntersectionObserver, materialsFetch } from './materials/fixtures';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

beforeEach(() => {
  MockIntersectionObserver.reset();
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
  vi.stubGlobal('fetch', vi.fn(materialsFetch().handler));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MaterialPickerDialog', () => {
  it('wraps Tab and Shift+Tab inside the dialog', async () => {
    render(
      <I18nProvider initial="en">
        <MaterialPickerDialog onClose={() => {}} onConfirm={() => {}} />
      </I18nProvider>,
    );
    const dialog = await screen.findByTestId('material-picker');
    await screen.findAllByTestId('material-picker-card');
    const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = nodes[0]!;
    const last = nodes[nodes.length - 1]!;

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
