import { describe, expect, it } from 'vitest';

import {
  BOARD_AUDIO_EXTENSIONS,
  BOARD_DESIGN_EXTENSIONS,
  BOARD_IMAGE_EXTENSIONS,
  BOARD_VIDEO_EXTENSIONS,
  boardCompositionDir,
  boardKindForPath,
  isBoardMovieDocumentPath,
  isBoardMovieRenderPath,
} from '../src/board/index.js';

describe('boardKindForPath (spec 04 §4.5.1)', () => {
  it.each([
    ['index.html', 'frame'],
    ['pages/about.htm', 'frame'],
    ['pages\\windows.html', 'frame'],
    ['./landing.html', 'frame'],
    ['hero.png', 'image'],
    ['hero.PNG', 'image'],
    ['a/b.jpg', 'image'],
    ['b.jpeg', 'image'],
    ['c.gif', 'image'],
    ['d.webp', 'image'],
    ['e.avif', 'image'],
    ['f.svg', 'image'],
    ['clip.mp4', 'video'],
    ['clip.mov', 'video'],
    ['clip.webm', 'video'],
    ['clip.m4v', 'video'],
    ['track.mp3', 'audio'],
    ['track.wav', 'audio'],
    ['track.m4a', 'audio'],
    ['track.aac', 'audio'],
    ['track.ogg', 'audio'],
    ['track.flac', 'audio'],
    ['designs/poster.fig', 'design'],
    ['designs/poster.op', 'design'],
    ['movie-studio.json', 'motion'],
    ['motion-source/intro/index.html', 'motion'],
  ])('%s → %s', (path, kind) => {
    expect(boardKindForPath(path)).toBe(kind);
  });

  it.each([
    'README.md',
    'data.json',
    'styles.css',
    'noextension',
    '.od/report.html',
    'assets/.hyperframes-cache/frame.mp4',
    '.hidden.png',
    'node_modules/pkg/index.html',
    'sketch-1.png',
    'notes/sketch-board.html',
    'board.sketch.json',
    'page.artifact.json',
    'sub/movie-studio.json',
    'motion-source/movie-abc/index.html',
    'motion-source/style-noir/index.html',
    'motion-source/intro/scene.html',
    'motion-source/intro/assets/logo.png',
    'motion-source/intro.html',
    'motion-source/.cache/index.html',
    '',
  ])('%s → null', (path) => {
    expect(boardKindForPath(path)).toBeNull();
  });

  it('exports dotted extension lists', () => {
    expect(BOARD_IMAGE_EXTENSIONS).toEqual(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg']);
    expect(BOARD_VIDEO_EXTENSIONS).toEqual(['.mp4', '.mov', '.webm', '.m4v']);
    expect(BOARD_AUDIO_EXTENSIONS).toEqual(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac']);
    expect(BOARD_DESIGN_EXTENSIONS).toEqual(['.fig', '.op']);
  });
});

describe('motion helpers', () => {
  it('boardCompositionDir', () => {
    expect(boardCompositionDir('motion-source/intro/index.html')).toBe('motion-source/intro');
    expect(boardCompositionDir('motion-source\\intro\\index.html')).toBe('motion-source/intro');
    expect(boardCompositionDir('motion-source/movie-x/index.html')).toBeNull();
    expect(boardCompositionDir('motion-source/intro/other.html')).toBeNull();
    expect(boardCompositionDir('pages/motion-source/intro/index.html')).toBeNull();
  });

  it('isBoardMovieDocumentPath / isBoardMovieRenderPath', () => {
    expect(isBoardMovieDocumentPath('movie-studio.json')).toBe(true);
    expect(isBoardMovieDocumentPath('./movie-studio.json')).toBe(true);
    expect(isBoardMovieDocumentPath('a/movie-studio.json')).toBe(false);
    expect(isBoardMovieRenderPath('movie-abc-123.mp4')).toBe(true);
    expect(isBoardMovieRenderPath('movie-.mp4')).toBe(false);
    expect(isBoardMovieRenderPath('renders/movie-abc.mp4')).toBe(false);
    expect(isBoardMovieRenderPath('movie-abc.mov')).toBe(false);
  });
});
