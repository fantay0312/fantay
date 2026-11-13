// @vitest-environment jsdom
//
// Fantay 素材库 rail item: present in BOTH identity branches, directly after
// 设计系统 and before 插件 (设置 must still follow 插件 directly — see
// EntryNavRail.no-duplicate-settings.test.tsx).

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EntryNavRail, type EntryView } from '../../src/components/EntryNavRail';
import { I18nProvider } from '../../src/i18n';

const signedInContext = {
  workspaceId: 'ws-personal',
  workspaceType: 'personal',
  workspaceMemberId: 'wm-1',
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
  permissions: { canInviteMembers: false, canViewWorkspaceSettings: false },
} as unknown as WorkspaceCollabContext;

function renderRail(
  context: WorkspaceCollabContext | null,
  { view = 'home', locale = 'en', onViewChange = vi.fn() }: {
    view?: EntryView;
    locale?: 'en' | 'zh-CN';
    onViewChange?: (view: EntryView) => void;
  } = {},
) {
  render(
    <I18nProvider initial={locale}>
      <EntryNavRail
        view={view}
        onViewChange={onViewChange}
        onNewProject={() => {}}
        open
        context={context}
        onOpenSettings={() => {}}
      />
    </I18nProvider>,
  );
  return onViewChange;
}

function destinationOrder(): string[] {
  return Array.from(document.querySelectorAll('.entry-nav-rail__team-section .entry-nav-rail__btn'))
    .map((el) => el.getAttribute('data-testid') ?? '');
}

afterEach(() => {
  cleanup();
});

describe.each([
  ['signed out (local shell)', null],
  ['signed in', signedInContext],
] as const)('EntryNavRail materials item — %s', (_label, context) => {
  it('sits between design systems and TokenToSea, with plugins and settings downstream', () => {
    renderRail(context);
    const order = destinationOrder();
    const materials = order.indexOf('entry-nav-materials');
    expect(materials).toBeGreaterThan(-1);
    expect(order[materials - 1]).toBe('entry-nav-design-systems');
    expect(order[materials + 1]).toBe('entry-nav-tokentosea');
    expect(order[materials + 2]).toBe('entry-nav-movies');
    expect(order[materials + 3]).toBe('entry-nav-plugins');
    expect(order[materials + 4]).toBe('entry-settings-button');
    expect(screen.getAllByTestId('entry-nav-materials')).toHaveLength(1);
  });

  it('navigates to the materials view and marks itself current', () => {
    const onViewChange = renderRail(context);
    fireEvent.click(screen.getByTestId('entry-nav-materials'));
    expect(onViewChange).toHaveBeenCalledWith('materials');
    cleanup();
    renderRail(context, { view: 'materials' });
    expect(screen.getByTestId('entry-nav-materials').getAttribute('aria-current')).toBe('page');
    expect(screen.getByTestId('entry-nav-design-systems').getAttribute('aria-current')).toBeNull();
  });
});

describe('EntryNavRail resource library label', () => {
  it('reads 资源库 in zh-CN and Resource Library in en', () => {
    renderRail(null, { locale: 'zh-CN' });
    expect(screen.getByTestId('entry-nav-materials').textContent).toBe('资源库');
    cleanup();
    renderRail(null);
    expect(screen.getByTestId('entry-nav-materials').getAttribute('aria-label')).toBe('Resource Library');
  });
});
