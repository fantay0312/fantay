import { describe, expect, it } from 'vitest';

import { BOARD_TAB } from '../../../src/fantay/workspace/board-host-contract';
import {
  isFantayEditorFileName,
  routeOpenRequestTarget,
} from '../../../src/fantay/workspace/open-request-routing';

function route(name: string, overrides: Partial<Parameters<typeof routeOpenRequestTarget>[0]> = {}) {
  return routeOpenRequestTarget({ name, activeTab: BOARD_TAB, routeFileName: null, boardReady: true, ...overrides });
}

describe('open-request routing', () => {
  it('rule 1: tabs when the board is not ready or not the active tab', () => {
    expect(route('index.html', { boardReady: false })).toBe('tab');
    expect(route('index.html', { activeTab: '__design_files__' })).toBe('tab');
    expect(route('index.html', { activeTab: 'about.html' })).toBe('tab');
  });

  it('rule 2: an explicit deep link opens a tab', () => {
    expect(route('index.html', { routeFileName: 'index.html' })).toBe('tab');
    expect(route('index.html', { routeFileName: 'about.html' })).toBe('board');
    expect(route('index.html', { routeFileName: undefined })).toBe('board');
  });

  it('rule 3 is dropped (R8): editor files focus the board node', () => {
    expect(route('movie-studio.json')).toBe('board');
    expect(route('designs/首页.fig')).toBe('board');
    expect(route('legacy.op')).toBe('board');
    expect(route('movie-studio.json', { routeFileName: 'movie-studio.json' })).toBe('tab');
  });

  it('rule 4: terminals, side chats and internal tab ids open tabs', () => {
    expect(route('terminal:t1')).toBe('tab');
    expect(route('chat:c1')).toBe('tab');
    expect(route('__design_files__')).toBe('tab');
    expect(route('__browser__:1')).toBe('tab');
    expect(route('__project_design_system__')).toBe('tab');
  });

  it('rule 5: files and live artifacts land on the board', () => {
    expect(route('index.html')).toBe('board');
    expect(route('assets/hero.png')).toBe('board');
    expect(route('live:a1')).toBe('board');
  });

  it('still classifies editor file names', () => {
    expect(isFantayEditorFileName('movie-studio.json')).toBe(true);
    expect(isFantayEditorFileName('nested/movie-studio.json')).toBe(true);
    expect(isFantayEditorFileName('designs/首页.fig')).toBe(true);
    expect(isFantayEditorFileName('a.OP')).toBe(true);
    expect(isFantayEditorFileName('x.penpot')).toBe(true);
    expect(isFantayEditorFileName('movie-studio.json.bak')).toBe(false);
    expect(isFantayEditorFileName('figma.html')).toBe(false);
    expect(isFantayEditorFileName('index.html')).toBe(false);
  });
});
