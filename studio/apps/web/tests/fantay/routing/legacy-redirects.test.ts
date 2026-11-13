// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';

import {
  LEGACY_REDIRECT_HOME,
  legacyFantayRedirect,
  type LegacyRedirect,
} from '../../../src/fantay/routing/legacy-redirects';
import { buildPath, parseRoute } from '../../../src/router';

/** What a legacy URL redirects to, through the real parser (`router.ts` keeps parsing the old paths). */
function redirectFor(url: string): LegacyRedirect | null {
  const parsed = new URL(url, 'http://localhost');
  return legacyFantayRedirect(parseRoute(parsed.pathname), parsed.search);
}

const editor = (id: string) => ({ kind: 'route', route: { kind: 'project', projectId: id, conversationId: null, fileName: 'movie-studio.json' } });

describe('legacyFantayRedirect (spec 07 §5.5)', () => {
  it.each([
    ['/movies/film-1', editor('film-1')],
    ['/movies?project=film-2', editor('film-2')],
    ['/movies/film-3?project=other', editor('film-3')],
    ['/movies', null],
    ['/movies?project=', null],
    ['/movies?project=%20%20', null],
    ['/create/animation/film-4', editor('film-4')],
    ['/create/animation', { kind: 'home-then', effect: { kind: 'motion-create' } }],
    ['/tokentosea', { kind: 'home-then', effect: { kind: 'settings', section: 'account' } }],
  ] as const)('%s', (url, expected) => {
    expect(redirectFor(url)).toEqual(expected);
  });

  it('decodes ids the way the router does', () => {
    expect(redirectFor('/movies/%E5%BD%B1%E7%89%87%201')).toEqual(editor('影片 1'));
    const action = redirectFor('/movies/a%2Fb');
    expect(action?.kind === 'route' ? buildPath(action.route) : null).toBe('/projects/a%2Fb/files/movie-studio.json');
  });

  it('leaves the MCP Apps embed alone: /movie-app[/:id] → null', () => {
    expect(parseRoute('/movie-app/film-1')).toMatchObject({ embeddedMovie: true });
    expect(redirectFor('/movie-app')).toBeNull();
    expect(redirectFor('/movie-app/film-1')).toBeNull();
    expect(redirectFor('/movie-app/film-1?project=film-2')).toBeNull();
  });

  it.each(['/', '/projects', '/projects/p1', '/projects/p1/files/movie-studio.json', '/settings', '/design-systems', '/plugins', '/materials', '/materials/extra'])(
    'is null for a current route: %s',
    (url) => {
      expect(redirectFor(url)).toBeNull();
    },
  );

  it('lands every home-then redirect on the home view', () => {
    expect(LEGACY_REDIRECT_HOME).toEqual({ kind: 'home', view: 'home' });
    expect(buildPath(LEGACY_REDIRECT_HOME)).toBe('/');
  });
});
