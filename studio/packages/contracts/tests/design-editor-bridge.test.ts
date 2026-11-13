// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  DESIGN_BRIDGE_PROTOCOL,
  DESIGN_BRIDGE_VERSION,
  DESIGN_EDITOR_ENTRY,
  DesignBridgeFailure,
  createDesignRequestId,
  designBridgeTimeoutMs,
  designEditorUrl,
  isDesignBridgeError,
  isDesignBridgeMessage,
  isDesignBridgeVersionMismatch,
  toDesignBridgeError,
  type DesignBridgeCapability,
  type DesignBridgeMessage,
  type DesignConnectMessage,
  type DesignEventMessage,
  type DesignHelloMessage,
  type DesignRequestMessage,
  type DesignResponseErr,
  type DesignResponseOk,
  type DesignTheme,
  type EditorToHostEvents,
  type EditorToHostRequests,
  type HostToEditorRequests,
} from '../src/runtime/design-editor-bridge';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const envelope = { protocol: DESIGN_BRIDGE_PROTOCOL, v: DESIGN_BRIDGE_VERSION } as const;

const hello = {
  ...envelope,
  kind: 'hello',
  editorVersion: '0.1.0',
  engines: { openPencil: '0.16.0', opWebSdk: '0.8.0' },
  capabilities: ['document.open', 'document.flush', 'insert', 'asset.fetch'],
} satisfies DesignHelloMessage;
const connect = { ...envelope, kind: 'connect', sessionId: 'session-1' } satisfies DesignConnectMessage;
const request = {
  ...envelope,
  kind: 'request',
  id: 'request-1',
  type: 'document.save',
  payload: { bytes: new ArrayBuffer(8), format: 'fig', baseSha256: null, reason: 'autosave' },
} satisfies DesignRequestMessage<'document.save', EditorToHostRequests['document.save']['req']>;
const responseOk = {
  ...envelope,
  kind: 'response',
  replyTo: 'request-1',
  ok: true,
  payload: { path: 'designs/a.fig', sha256: 'abc', size: 8, savedAt: 1 },
} satisfies DesignResponseOk<EditorToHostRequests['document.save']['res']>;
const responseErr = {
  ...envelope,
  kind: 'response',
  replyTo: 'request-1',
  ok: false,
  error: { code: 'CONFLICT', message: 'Changed on disk', details: { currentSha256: 'def' } },
} satisfies DesignResponseErr;
const event = {
  ...envelope,
  kind: 'event',
  type: 'selection',
  payload: {
    pageId: '0:1',
    nodeIds: ['0:2'],
    nodes: [{ id: '0:2', name: 'Frame', type: 'FRAME', width: 10, height: 20 }],
  },
} satisfies DesignEventMessage<'selection', EditorToHostEvents['selection']>;

const validMessages: Record<string, DesignBridgeMessage> = { hello, connect, request, responseOk, responseErr, event };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isDesignBridgeMessage', () => {
  it.each(Object.entries(validMessages))('accepts a valid %s message', (_name, message) => {
    expect(isDesignBridgeMessage(message)).toBe(true);
  });

  it('accepts messages after a structured clone, as postMessage delivers them', () => {
    for (const message of Object.values(validMessages)) {
      expect(isDesignBridgeMessage(structuredClone(message))).toBe(true);
    }
  });

  it('accepts request and event types it does not know, so endpoints can answer INVALID_REQUEST or drop them', () => {
    expect(isDesignBridgeMessage({ ...request, type: 'document.delete', payload: {} })).toBe(true);
    expect(isDesignBridgeMessage({ ...event, type: 'future-event', payload: {} })).toBe(true);
  });

  it('rejects values that are not message objects', () => {
    for (const value of [null, undefined, 'hello', 1, true, [hello], new ArrayBuffer(4)]) {
      expect(isDesignBridgeMessage(value)).toBe(false);
    }
  });

  it('rejects a wrong or missing protocol', () => {
    const { protocol: _protocol, ...withoutProtocol } = request;
    expect(isDesignBridgeMessage({ ...hello, protocol: 'fantay.design' })).toBe(false);
    expect(isDesignBridgeMessage({ ...connect, protocol: 'od:slide' })).toBe(false);
    expect(isDesignBridgeMessage(withoutProtocol)).toBe(false);
  });

  it('rejects any version other than 1', () => {
    for (const v of [0, 2, '1', 1.5, null, undefined]) {
      for (const message of Object.values(validMessages)) {
        expect(isDesignBridgeMessage({ ...message, v })).toBe(false);
      }
    }
  });

  it('rejects an unknown or missing kind', () => {
    for (const kind of ['ping', 'Hello', '', undefined, 1, 'toString', '__proto__', 'constructor']) {
      expect(isDesignBridgeMessage({ ...event, kind })).toBe(false);
    }
  });

  it('rejects missing or empty ids and types', () => {
    const { id: _id, ...requestWithoutId } = request;
    const { replyTo: _replyTo, ...responseWithoutReplyTo } = responseOk;
    const { sessionId: _sessionId, ...connectWithoutSession } = connect;
    const { type: _type, ...eventWithoutType } = event;
    expect(isDesignBridgeMessage(requestWithoutId)).toBe(false);
    expect(isDesignBridgeMessage({ ...request, id: '' })).toBe(false);
    expect(isDesignBridgeMessage({ ...request, id: 7 })).toBe(false);
    expect(isDesignBridgeMessage({ ...request, type: '' })).toBe(false);
    expect(isDesignBridgeMessage(responseWithoutReplyTo)).toBe(false);
    expect(isDesignBridgeMessage({ ...responseErr, replyTo: '' })).toBe(false);
    expect(isDesignBridgeMessage(connectWithoutSession)).toBe(false);
    expect(isDesignBridgeMessage({ ...connect, sessionId: '' })).toBe(false);
    expect(isDesignBridgeMessage(eventWithoutType)).toBe(false);
  });

  it('rejects non-object payloads', () => {
    const payloads = [undefined, null, 'payload', 42, true, [], [{}], new ArrayBuffer(4), new Uint8Array(4), new Date(0)];
    for (const payload of payloads) {
      expect(isDesignBridgeMessage({ ...request, payload })).toBe(false);
      expect(isDesignBridgeMessage({ ...responseOk, payload })).toBe(false);
      expect(isDesignBridgeMessage({ ...event, payload })).toBe(false);
    }
    expect(isDesignBridgeMessage({ ...request, payload: {} })).toBe(true);
  });

  it('rejects responses without a boolean ok or with a malformed error', () => {
    expect(isDesignBridgeMessage({ ...responseOk, ok: 'true' })).toBe(false);
    expect(isDesignBridgeMessage({ ...responseErr, error: undefined })).toBe(false);
    expect(isDesignBridgeMessage({ ...responseErr, error: 'CONFLICT' })).toBe(false);
    expect(isDesignBridgeMessage({ ...responseErr, error: { code: 'EXPLODED', message: 'x' } })).toBe(false);
    expect(isDesignBridgeMessage({ ...responseErr, error: { code: 'CONFLICT' } })).toBe(false);
    expect(isDesignBridgeMessage({ ...responseErr, error: { code: 'CONFLICT', message: 'x', details: 'y' } })).toBe(false);
    expect(
      isDesignBridgeMessage({ ...responseErr, error: { code: 'CONFLICT', message: 'x', details: { currentSha256: 42 } } }),
    ).toBe(false);
    expect(
      isDesignBridgeMessage({ ...responseErr, error: { code: 'CONFLICT', message: 'x', details: { currentSha256: null } } }),
    ).toBe(true);
    expect(isDesignBridgeMessage({ ...responseErr, error: { code: 'TIMEOUT', message: 'Timed out' } })).toBe(true);
  });

  it('validates the hello handshake fields and tolerates unknown capabilities', () => {
    const { editorVersion: _editorVersion, ...helloWithoutVersion } = hello;
    expect(isDesignBridgeMessage(helloWithoutVersion)).toBe(false);
    expect(isDesignBridgeMessage({ ...hello, engines: null })).toBe(false);
    expect(isDesignBridgeMessage({ ...hello, engines: { openPencil: '0.16.0' } })).toBe(false);
    expect(isDesignBridgeMessage({ ...hello, capabilities: 'insert' })).toBe(false);
    expect(isDesignBridgeMessage({ ...hello, capabilities: ['insert', 1] })).toBe(false);
    expect(isDesignBridgeMessage({ ...hello, capabilities: [] })).toBe(true);
    expect(isDesignBridgeMessage({ ...hello, capabilities: ['document.open', 'future.capability'] })).toBe(true);
  });
});

describe('isDesignBridgeVersionMismatch', () => {
  it('flags messages of this protocol with another version', () => {
    expect(isDesignBridgeVersionMismatch({ ...hello, v: 2 })).toBe(true);
    expect(isDesignBridgeVersionMismatch({ ...hello, v: '1' })).toBe(true);
    expect(isDesignBridgeVersionMismatch({ protocol: DESIGN_BRIDGE_PROTOCOL, kind: 'hello' })).toBe(true);
  });

  it('ignores current-version messages and unrelated window traffic', () => {
    expect(isDesignBridgeVersionMismatch(hello)).toBe(false);
    expect(isDesignBridgeVersionMismatch({ type: 'od:slide', action: 'next' })).toBe(false);
    expect(isDesignBridgeVersionMismatch({ protocol: 'other', v: 2 })).toBe(false);
    expect(isDesignBridgeVersionMismatch(null)).toBe(false);
    expect(isDesignBridgeVersionMismatch('fantay.design-editor')).toBe(false);
  });
});

describe('designEditorUrl', () => {
  it('builds the embed URL with the protocol version, theme and locale', () => {
    expect(designEditorUrl({ theme: 'dark', locale: 'zh-CN' })).toBe(
      '/canvas-editor/index.html?embed=1&v=1&theme=dark&locale=zh-CN',
    );
    expect(designEditorUrl({ theme: 'light', locale: 'pt-BR' })).toBe(
      `${DESIGN_EDITOR_ENTRY}?embed=1&v=1&theme=light&locale=pt-BR`,
    );
  });

  it('encodes the locale and only ever emits a known theme', () => {
    const url = designEditorUrl({ theme: 'sepia' as DesignTheme, locale: 'x&theme=light #' });
    expect(url).toBe('/canvas-editor/index.html?embed=1&v=1&theme=dark&locale=x%26theme%3Dlight%20%23');
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    expect(params.getAll('theme')).toEqual(['dark']);
    expect(params.get('locale')).toBe('x&theme=light #');
  });
});

describe('designBridgeTimeoutMs', () => {
  it('returns configured timeouts for known requests and falls back to 15 s for unknown or prototype keys', () => {
    expect(designBridgeTimeoutMs('init')).toBe(60_000);
    expect(designBridgeTimeoutMs('document.open')).toBe(90_000);
    for (const type of ['document.delete', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(designBridgeTimeoutMs(type as 'focus')).toBe(15_000);
    }
  });
});

describe('createDesignRequestId', () => {
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it('returns unique v4 UUIDs', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createDesignRequestId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(uuidV4);
  });

  it('uses getRandomValues when randomUUID is missing (plain-HTTP LAN origins)', () => {
    const getRandomValues = vi.fn((array: Uint8Array) => array.fill(0xff));
    vi.stubGlobal('crypto', { getRandomValues });
    expect(createDesignRequestId()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(getRandomValues).toHaveBeenCalledOnce();
  });

  it('falls back to Math.random without Web Crypto', () => {
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(createDesignRequestId()).toBe('00000000-0000-4000-8000-000000000000');
  });
});

describe('DesignBridgeFailure and toDesignBridgeError', () => {
  it('is an Error carrying a bridge code and optional details', () => {
    const failure = new DesignBridgeFailure('CONFLICT', 'Changed on disk', { currentSha256: null });
    expect(failure).toBeInstanceOf(Error);
    expect(failure.name).toBe('DesignBridgeFailure');
    expect(failure.message).toBe('Changed on disk');
    expect(failure.code).toBe('CONFLICT');
    expect(failure.details).toEqual({ currentSha256: null });
    expect(Object.hasOwn(new DesignBridgeFailure('READ_ONLY', 'Read-only'), 'details')).toBe(false);
  });

  it('serializes failures into wire errors that survive the message guard', () => {
    const details = { currentSha256: 'abc' };
    const error = toDesignBridgeError(new DesignBridgeFailure('CONFLICT', 'Changed', details));
    expect(error).toEqual({ code: 'CONFLICT', message: 'Changed', details: { currentSha256: 'abc' } });
    expect(error.details).not.toBe(details);
    expect(isDesignBridgeError(error)).toBe(true);
    const response: DesignResponseErr = { ...envelope, kind: 'response', replyTo: 'request-1', ok: false, error };
    expect(isDesignBridgeMessage(structuredClone(response))).toBe(true);
    expect(toDesignBridgeError(new DesignBridgeFailure('TIMEOUT', 'Too slow'))).toEqual({ code: 'TIMEOUT', message: 'Too slow' });
  });

  it('keeps the code of structurally matching errors (wire errors, copies from another bundle)', () => {
    const copy = Object.assign(new Error('Gone'), { code: 'NOT_FOUND', details: { path: 'designs/a.fig' } });
    expect(toDesignBridgeError(copy)).toEqual({ code: 'NOT_FOUND', message: 'Gone', details: { path: 'designs/a.fig' } });
    expect(toDesignBridgeError({ code: 'TOO_LARGE', message: 'Too big' })).toEqual({ code: 'TOO_LARGE', message: 'Too big' });
    const badDetails = Object.assign(new Error('Offline'), { code: 'NETWORK', details: 'x' });
    expect(toDesignBridgeError(badDetails)).toEqual({ code: 'NETWORK', message: 'Offline' });
  });

  it('maps every other thrown value to the fallback code', () => {
    expect(toDesignBridgeError(new TypeError('boom'))).toEqual({ code: 'INTERNAL', message: 'boom' });
    expect(toDesignBridgeError(Object.assign(new Error('no file'), { code: 'ENOENT' }))).toEqual({
      code: 'INTERNAL',
      message: 'no file',
    });
    expect(toDesignBridgeError(new Error(''))).toEqual({ code: 'INTERNAL', message: 'Error' });
    expect(toDesignBridgeError('plain text', 'EXPORT_FAILED')).toEqual({ code: 'EXPORT_FAILED', message: 'plain text' });
    expect(toDesignBridgeError(undefined)).toEqual({ code: 'INTERNAL', message: 'Unknown error' });
    expect(toDesignBridgeError(42, 'PARSE_FAILED')).toEqual({ code: 'PARSE_FAILED', message: 'Unknown error' });
  });
});

describe('protocol constants and package surface', () => {
  it('advertises one capability per optional request', () => {
    expectTypeOf<DesignBridgeCapability>().toEqualTypeOf<Exclude<keyof HostToEditorRequests, 'init'> | 'asset.fetch'>();
  });

  it('is published as the runtime/design-editor-bridge subpath', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, { types?: string; default?: string }>;
    };
    expect(pkg.exports['./runtime/design-editor-bridge']).toEqual({
      types: './dist/runtime/design-editor-bridge.d.ts',
      default: './dist/runtime/design-editor-bridge.mjs',
    });
  });
});
