// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { rememberLoginReturnRoute, takeLoginReturnRoute } from '../../src/onboarding/login-return-route';

afterEach(() => window.sessionStorage.clear());

describe('login return route', () => {
  it('preserves the embedded movie and consumes the destination once', () => {
    const route = { kind: 'home', view: 'movies', embeddedMovie: true, movieProjectId: 'movie / 中文' } as const;
    rememberLoginReturnRoute(route);
    rememberLoginReturnRoute({ kind: 'home', view: 'onboarding' });
    expect(takeLoginReturnRoute()).toEqual(route);
    expect(takeLoginReturnRoute()).toEqual({ kind: 'home', view: 'home' });
  });

  it('preserves a project, conversation, and selected file', () => {
    const route = { kind: 'project', projectId: 'project', conversationId: 'chat', fileName: 'assets/设计.html' } as const;
    rememberLoginReturnRoute(route);
    expect(takeLoginReturnRoute()).toEqual(route);
  });

  it.each(['https://example.test/', '//example.test/', '/\\example.test/', '/onboarding', '/projects/%'])('ignores an invalid return target %s', (path) => {
    window.sessionStorage.setItem('fantay.loginReturnPath.v1', path);
    expect(takeLoginReturnRoute()).toEqual({ kind: 'home', view: 'home' });
  });
});
