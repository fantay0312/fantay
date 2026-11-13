import { describe, expect, it } from 'vitest';

import {
  MEDIA_TASK_WAIT_MAX_TIMEOUT_MS,
  isTerminalMediaTaskStatus,
  parseDaemonApiError,
  parseMediaGenerateAccepted,
  parseMediaTaskSnapshot,
} from '../src/api/media-generate';
import { tokenToSeaMediaAssets, tokenToSeaVideoAssets } from '../src/index.js';

// Spec 05 §3.1 / §11 "media-generate-dto": tolerant parsers over the existing daemon endpoints.

describe('isTerminalMediaTaskStatus', () => {
  it('is true for done, failed and interrupted only', () => {
    expect(isTerminalMediaTaskStatus('done')).toBe(true);
    expect(isTerminalMediaTaskStatus('failed')).toBe(true);
    expect(isTerminalMediaTaskStatus('interrupted')).toBe(true);
    expect(isTerminalMediaTaskStatus('queued')).toBe(false);
    expect(isTerminalMediaTaskStatus('running')).toBe(false);
  });

  it('pins the daemon long-poll cap', () => {
    expect(MEDIA_TASK_WAIT_MAX_TIMEOUT_MS).toBe(25_000);
  });
});

describe('parseMediaGenerateAccepted', () => {
  it('reads the 202 body', () => {
    expect(parseMediaGenerateAccepted({ taskId: 't1', status: 'queued', startedAt: 1700 })).toEqual({
      taskId: 't1',
      status: 'queued',
      startedAt: 1700,
    });
  });

  it('returns null without a string taskId and tolerates the rest', () => {
    expect(parseMediaGenerateAccepted(null)).toBeNull();
    expect(parseMediaGenerateAccepted('t1')).toBeNull();
    expect(parseMediaGenerateAccepted({ status: 'queued' })).toBeNull();
    expect(parseMediaGenerateAccepted({ taskId: 42 })).toBeNull();
    expect(parseMediaGenerateAccepted({ taskId: '   ' })).toBeNull();
    expect(parseMediaGenerateAccepted({ taskId: 't2', status: 'weird' })).toEqual({
      taskId: 't2',
      status: 'queued',
      startedAt: 0,
    });
  });
});

describe('parseMediaTaskSnapshot', () => {
  it('normalizes a full daemon snapshot', () => {
    const snapshot = parseMediaTaskSnapshot({
      taskId: 't1',
      status: 'done',
      startedAt: 10,
      endedAt: 20,
      progress: ['queued', 'rendering'],
      nextSince: 2,
      file: {
        name: 'gen-a-b-1.png',
        size: 1234,
        mtime: 99,
        kind: 'image',
        mime: 'image/png',
        model: 'gpt-image-2',
        surface: 'image',
        providerNote: 'openai · gpt-image-2',
        providerId: 'openai',
        providerError: null,
        usedStubFallback: false,
        intentionalStub: false,
        warnings: ['--length 7 clamped to 8', 3],
      },
    });
    expect(snapshot).toEqual({
      taskId: 't1',
      status: 'done',
      startedAt: 10,
      endedAt: 20,
      progress: ['queued', 'rendering'],
      nextSince: 2,
      file: {
        name: 'gen-a-b-1.png',
        size: 1234,
        mtime: 99,
        kind: 'image',
        mime: 'image/png',
        model: 'gpt-image-2',
        surface: 'image',
        providerNote: 'openai · gpt-image-2',
        providerId: 'openai',
        providerError: null,
        usedStubFallback: false,
        intentionalStub: false,
        warnings: ['--length 7 clamped to 8'],
      },
      error: null,
    });
  });

  it('coerces missing arrays and numbers instead of failing', () => {
    expect(parseMediaTaskSnapshot({ taskId: 't1', status: 'running' })).toEqual({
      taskId: 't1',
      status: 'running',
      startedAt: 0,
      endedAt: null,
      progress: [],
      nextSince: 0,
      file: null,
      error: null,
    });
    const partial = parseMediaTaskSnapshot({
      taskId: 't1',
      status: 'running',
      startedAt: '10',
      progress: ['a', null, 'b', { line: 'c' }],
      file: { size: 3 },
    });
    expect(partial?.progress).toEqual(['a', 'b']);
    // Without nextSince the next long-poll continues after what was received.
    expect(partial?.nextSince).toBe(2);
    expect(partial?.startedAt).toBe(0);
    expect(partial?.file).toBeNull();
    expect(parseMediaTaskSnapshot({ taskId: 't1', status: 'done', file: { name: 'x.png' } })?.file).toEqual({
      name: 'x.png',
      warnings: [],
    });
    expect(parseMediaTaskSnapshot({ taskId: 't1', status: 'running', nextSince: 4.7 })?.nextSince).toBe(4);
    expect(parseMediaTaskSnapshot({ taskId: 't1', status: 'running', nextSince: -1, progress: ['x'] })?.nextSince).toBe(1);
  });

  it('returns null for an unknown status or a body without taskId', () => {
    expect(parseMediaTaskSnapshot({ taskId: 't1', status: 'cancelled' })).toBeNull();
    expect(parseMediaTaskSnapshot({ taskId: 't1' })).toBeNull();
    expect(parseMediaTaskSnapshot({ status: 'running' })).toBeNull();
    expect(parseMediaTaskSnapshot(['t1'])).toBeNull();
    expect(parseMediaTaskSnapshot(null)).toBeNull();
    expect(parseMediaTaskSnapshot('{"taskId":"t1"}')).toBeNull();
  });

  it('normalizes errors, including the legacy string form and unknown next steps', () => {
    const failed = parseMediaTaskSnapshot({
      taskId: 't1',
      status: 'failed',
      error: { message: 'refused', code: 'safety_rejection', status: 400, subject: 'prompt', retryable: false, nextStep: 'revise-request' },
    });
    expect(failed?.error).toEqual({
      message: 'refused',
      code: 'safety_rejection',
      status: 400,
      subject: 'prompt',
      retryable: false,
      nextStep: 'revise-request',
    });
    expect(parseMediaTaskSnapshot({ taskId: 't1', status: 'failed', error: 'boom' })?.error).toEqual({ message: 'boom' });
    expect(
      parseMediaTaskSnapshot({ taskId: 't1', status: 'failed', error: { message: 'x', nextStep: 'panic', subject: 'other' } })?.error,
    ).toEqual({ message: 'x' });
    expect(parseMediaTaskSnapshot({ taskId: 't1', status: 'failed', error: { code: 'X' } })?.error).toEqual({
      message: '',
      code: 'X',
    });
  });
});

describe('parseDaemonApiError', () => {
  it('reads the compat envelope { error: { code, message } }', () => {
    expect(
      parseDaemonApiError(403, { error: { code: 'MEDIA_MODEL_DENIED', message: 'media model "x" is not allowed for this run' } }),
    ).toEqual({ status: 403, code: 'MEDIA_MODEL_DENIED', message: 'media model "x" is not allowed for this run' });
    expect(parseDaemonApiError(401, { error: { code: 'TOOL_TOKEN_MISSING' } })).toEqual({
      status: 401,
      code: 'TOOL_TOKEN_MISSING',
      message: 'HTTP 401',
    });
  });

  it('reads the legacy { error: string, code? } shape and { message }', () => {
    expect(parseDaemonApiError(404, { error: 'project not found' })).toEqual({ status: 404, message: 'project not found' });
    expect(parseDaemonApiError(409, { code: 'CONFLICT', error: 'busy' })).toEqual({ status: 409, code: 'CONFLICT', message: 'busy' });
    expect(parseDaemonApiError(400, { message: 'bad input', code: 'BAD_REQUEST' })).toEqual({
      status: 400,
      code: 'BAD_REQUEST',
      message: 'bad input',
    });
  });

  it('handles non-JSON bodies passed as text', () => {
    expect(parseDaemonApiError(502, 'Bad Gateway')).toEqual({ status: 502, message: 'Bad Gateway' });
    expect(parseDaemonApiError(502, '  upstream\n  timed   out ')).toEqual({ status: 502, message: 'upstream timed out' });
    expect(parseDaemonApiError(503, '<!doctype html><html><body>Service Unavailable</body></html>')).toEqual({
      status: 503,
      message: 'HTTP 503',
    });
    expect(parseDaemonApiError(429, '{"error":{"code":"RATE_LIMITED","message":"slow down"}}')).toEqual({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'slow down',
    });
    expect(parseDaemonApiError(500, '{not json')).toEqual({ status: 500, message: '{not json' });
    expect(parseDaemonApiError(500, 'x'.repeat(2_000)).message).toHaveLength(500);
  });

  it('falls back to the HTTP status for empty or unknown bodies', () => {
    expect(parseDaemonApiError(500, null)).toEqual({ status: 500, message: 'HTTP 500' });
    expect(parseDaemonApiError(500, undefined)).toEqual({ status: 500, message: 'HTTP 500' });
    expect(parseDaemonApiError(500, '')).toEqual({ status: 500, message: 'HTTP 500' });
    expect(parseDaemonApiError(500, 42)).toEqual({ status: 500, message: 'HTTP 500' });
    expect(parseDaemonApiError(500, { error: { code: '', message: '  ' } })).toEqual({ status: 500, message: 'HTTP 500' });
    expect(parseDaemonApiError(Number.NaN, {})).toEqual({ status: 0, message: 'Request failed' });
  });
});

describe('tokenToSeaMediaAssets', () => {
  it('discovers only archived media assets and keeps the video-only selector compatible', () => {
    const video = `asset_${'a'.repeat(64)}`;
    const image = `asset_${'b'.repeat(64)}`;
    const audio = `asset_${'c'.repeat(64)}`;
    const result = {
      output: {
        assets: [
          { asset_id: video, mime_type: 'video/mp4' },
          { asset_id: image, mime_type: 'image/png' },
          { asset_id: audio, mime_type: 'audio/wav' },
          { url: 'https://untrusted.example/file.mp4' },
        ],
      },
    };
    expect(tokenToSeaVideoAssets(result)).toEqual([video]);
    expect(tokenToSeaMediaAssets(result)).toEqual([video, image, audio]);
  });
});
