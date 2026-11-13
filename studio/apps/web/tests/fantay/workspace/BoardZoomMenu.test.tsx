// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Header zoom menu (spec 02 §7.5/§13, plan R7): "—" and disabled without a published viewport for this
// project; with one, every control runs its `fantay.board.*` command.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import {
  registerFantayCommand,
  resetFantayCommandsForTests,
  type FantayCommandId,
} from '../../../src/fantay/shell/commands';
import { BOARD_ZOOM_PRESETS, BoardZoomMenu, boardZoomPercent } from '../../../src/fantay/workspace/BoardZoomMenu';
import {
  publishBoardViewport,
  resetBoardViewportForTests,
} from '../../../src/fantay/workspace/board-viewport-store';

type Calls = Array<{ id: FantayCommandId; payload: unknown }>;

function registerBoardCommands(): Calls {
  const calls: Calls = [];
  const ids: FantayCommandId[] = ['fantay.board.zoomIn', 'fantay.board.zoomOut', 'fantay.board.zoomFit', 'fantay.board.zoomTo'];
  for (const id of ids) {
    registerFantayCommand(id, ((payload: unknown) => {
      calls.push({ id, payload });
    }) as never);
  }
  return calls;
}

function publish(zoom: number, projectId = 'project-1'): void {
  act(() => {
    publishBoardViewport({ projectId, zoom, minZoom: 0.05, maxZoom: 8 });
  });
}

function openMenu(): void {
  fireEvent.keyDown(screen.getByTestId('fantay-board-zoom-trigger'), { key: 'Enter' });
}

beforeEach(() => {
  resetFantayCommandsForTests();
  resetBoardViewportForTests();
});

afterEach(() => {
  cleanup();
  resetFantayCommandsForTests();
  resetBoardViewportForTests();
});

describe('boardZoomPercent', () => {
  it('rounds the zoom to a percentage and has no value without a usable snapshot', () => {
    expect(boardZoomPercent(null)).toBeNull();
    expect(boardZoomPercent({ projectId: 'p', zoom: Number.NaN, minZoom: 0.05, maxZoom: 8 })).toBeNull();
    expect(boardZoomPercent({ projectId: 'p', zoom: 0.3333, minZoom: 0.05, maxZoom: 8 })).toBe(33);
    expect(boardZoomPercent({ projectId: 'p', zoom: 1.25, minZoom: 0.05, maxZoom: 8 })).toBe(125);
  });

  it('offers the 50 / 100 / 200 % presets', () => {
    expect([...BOARD_ZOOM_PRESETS]).toEqual([0.5, 1, 2]);
  });
});

describe('BoardZoomMenu', () => {
  it('shows the fallback numeric percentage and disables every control while no viewport is published', () => {
    const calls = registerBoardCommands();
    render(<BoardZoomMenu projectId="project-1" />);

    const trigger = screen.getByTestId('fantay-board-zoom-trigger');
    expect(trigger).toHaveTextContent('100%');
    expect(trigger).toHaveAccessibleName('Zoom 100%');
    expect(trigger).toBeDisabled();
    expect(screen.getByTestId('fantay-board-zoom-out')).toBeDisabled();
    expect(screen.getByTestId('fantay-board-zoom-in')).toBeDisabled();
    expect(screen.getByTestId('fantay-board-zoom')).toHaveAttribute('data-ready', 'false');

    fireEvent.click(screen.getByTestId('fantay-board-zoom-in'));
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('ignores a viewport another project published', () => {
    render(<BoardZoomMenu projectId="project-1" />);
    publish(1.5, 'project-2');
    expect(screen.getByTestId('fantay-board-zoom-trigger')).toHaveTextContent('100%');
    expect(screen.getByTestId('fantay-board-zoom-in')).toBeDisabled();
  });

  it('shows the published zoom and follows later publishes', () => {
    render(<BoardZoomMenu projectId="project-1" />);
    publish(1.25);
    const trigger = screen.getByTestId('fantay-board-zoom-trigger');
    expect(trigger).toHaveTextContent('125%');
    expect(trigger).toHaveAccessibleName('Zoom 125%');
    expect(trigger).not.toBeDisabled();
    expect(screen.getByTestId('fantay-board-zoom')).toHaveAttribute('data-ready', 'true');

    publish(0.5);
    expect(trigger).toHaveTextContent('50%');

    act(() => publishBoardViewport(null));
    expect(trigger).toHaveTextContent('50%');
    expect(trigger).toBeDisabled();
  });

  it('runs the step commands from the buttons', () => {
    const calls = registerBoardCommands();
    render(<BoardZoomMenu projectId="project-1" />);
    publish(1);

    fireEvent.click(screen.getByTestId('fantay-board-zoom-in'));
    fireEvent.click(screen.getByTestId('fantay-board-zoom-out'));
    expect(calls.map((call) => call.id)).toEqual(['fantay.board.zoomIn', 'fantay.board.zoomOut']);
  });

  it('runs every menu item as its board command', () => {
    const calls = registerBoardCommands();
    render(<BoardZoomMenu projectId="project-1" />);
    publish(1);

    openMenu();
    expect(screen.getByRole('menu')).toHaveClass('fx');
    expect(screen.getAllByRole('menuitem').map((item) => item.getAttribute('data-testid'))).toEqual([
      'fantay-board-zoom-menu-in',
      'fantay-board-zoom-menu-out',
      'fantay-board-zoom-menu-fit',
      'fantay-board-zoom-menu-50',
      'fantay-board-zoom-menu-100',
      'fantay-board-zoom-menu-200',
    ]);
    fireEvent.click(screen.getByTestId('fantay-board-zoom-menu-fit'));

    openMenu();
    fireEvent.click(screen.getByTestId('fantay-board-zoom-menu-50'));
    openMenu();
    fireEvent.click(screen.getByTestId('fantay-board-zoom-menu-200'));
    openMenu();
    fireEvent.click(screen.getByTestId('fantay-board-zoom-menu-in'));
    openMenu();
    fireEvent.click(screen.getByTestId('fantay-board-zoom-menu-out'));

    expect(calls).toEqual([
      { id: 'fantay.board.zoomFit', payload: undefined },
      { id: 'fantay.board.zoomTo', payload: { zoom: 0.5 } },
      { id: 'fantay.board.zoomTo', payload: { zoom: 2 } },
      { id: 'fantay.board.zoomIn', payload: undefined },
      { id: 'fantay.board.zoomOut', payload: undefined },
    ]);
  });

  it('labels the menu with the zoom keys', () => {
    render(<BoardZoomMenu projectId="project-1" />);
    publish(1);
    openMenu();
    expect(screen.getByTestId('fantay-board-zoom-menu-fit').querySelectorAll('kbd')).toHaveLength(2);
    expect(screen.getByTestId('fantay-board-zoom-menu-100').querySelectorAll('kbd')).toHaveLength(2);
    expect(screen.getByTestId('fantay-board-zoom-menu-50').querySelector('kbd')).toBeNull();
  });

  it('disables the step that would leave the zoom range', () => {
    render(<BoardZoomMenu projectId="project-1" />);
    publish(0.05);
    expect(screen.getByTestId('fantay-board-zoom-out')).toBeDisabled();
    expect(screen.getByTestId('fantay-board-zoom-in')).not.toBeDisabled();

    publish(8);
    expect(screen.getByTestId('fantay-board-zoom-in')).toBeDisabled();
    expect(screen.getByTestId('fantay-board-zoom-out')).not.toBeDisabled();
  });

  it('does nothing visible when no board handles the command', () => {
    render(<BoardZoomMenu projectId="project-1" />);
    publish(1);
    expect(() => fireEvent.click(screen.getByTestId('fantay-board-zoom-in'))).not.toThrow();
  });

  it('speaks zh-CN', () => {
    render(
      <I18nProvider initial="zh-CN">
        <BoardZoomMenu projectId="project-1" />
      </I18nProvider>,
    );
    publish(2);
    expect(screen.getByTestId('fantay-board-zoom-trigger')).toHaveAccessibleName('缩放 200%');
    expect(screen.getByTestId('fantay-board-zoom-in')).toHaveAccessibleName('放大');
    expect(screen.getByTestId('fantay-board-zoom-out')).toHaveAccessibleName('缩小');
    openMenu();
    expect(screen.getByTestId('fantay-board-zoom-menu-fit')).toHaveTextContent('适应画布');
    expect(screen.getByTestId('fantay-board-zoom-menu-100')).toHaveTextContent('缩放到 100%');
  });
});
