import { describe, expect, it } from 'vitest';

import { buildPath, parseRoute } from '../src/router';

// Fantay 素材库 is its own entry view (`materials`), separate from the hidden
// OD Library (`library`, flag-gated).
describe('resource library routes', () => {
  it('opens the materials module from a legacy bookmark', () => {
    expect(parseRoute('/materials')).toEqual({ kind: 'home', view: 'materials' });
    expect(parseRoute('/materials/')).toEqual({ kind: 'home', view: 'materials' });
  });

  it('uses /resources as the canonical entry path', () => {
    const route = parseRoute('/materials');
    expect(buildPath(route)).toBe('/resources');
    expect(parseRoute(buildPath({ kind: 'home', view: 'materials' }))).toEqual(route);
    expect(parseRoute('/resources/materials')).toEqual(route);
  });

  it.each(['skills', 'mcp', 'tutorials'] as const)('round-trips the %s module', (resourceModule) => {
    const path = '/resources/' + resourceModule;
    const route = { kind: 'home', view: 'materials', resourceModule } as const;
    expect(parseRoute(path)).toEqual(route);
    expect(buildPath(route)).toBe(path);
  });

  it('does not claim sub-paths or the OD Library route', () => {
    expect(parseRoute('/materials/some-id')).toEqual({ kind: 'home', view: 'home' });
    expect(parseRoute('/resources/unknown')).toEqual({ kind: 'home', view: 'home' });
    expect(parseRoute('/library')).not.toEqual({ kind: 'home', view: 'materials' });
  });
});
