import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TOKENTOSEA_TEST_ORIGIN_ENV, isPackagedForTestSeam, resolveTokenToSeaTestOrigin, tokenToSeaEndpointsFromEnvironment, tokenToSeaTestEndpoints,
} from '../../src/integrations/tokentosea-endpoints.js';
import { TokenToSeaRuntime } from '../../src/integrations/tokentosea-runtime.js';
import { TOKENTOSEA_CONNECT_BASE, TOKENTOSEA_DESIGN_BASE, TOKENTOSEA_ISSUER } from '../../src/integrations/tokentosea.js';


const production = { issuer: TOKENTOSEA_ISSUER, connectBase: TOKENTOSEA_CONNECT_BASE, designBase: TOKENTOSEA_DESIGN_BASE };
const folders: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true }));
});

describe('OD_TOKENTOSEA_TEST_ORIGIN decision', () => {
  const unpackaged = { packaged: false };

  it('keeps production endpoints when the variable is absent or blank', () => {
    expect(TOKENTOSEA_TEST_ORIGIN_ENV).toBe('OD_TOKENTOSEA_TEST_ORIGIN');
    expect(resolveTokenToSeaTestOrigin(undefined, unpackaged)).toEqual({ status: 'production' });
    expect(resolveTokenToSeaTestOrigin('  ', unpackaged)).toEqual({ status: 'production' });
    expect(resolveTokenToSeaTestOrigin(undefined, { packaged: true })).toEqual({ status: 'production' });
  });

  it('maps a loopback http or https origin onto the issuer, connect and design bases', () => {
    expect(resolveTokenToSeaTestOrigin('http://127.0.0.1:43210', unpackaged)).toEqual({
      status: 'test-origin', origin: 'http://127.0.0.1:43210',
      endpoints: { issuer: 'http://127.0.0.1:43210/api/oauth', connectBase: 'http://127.0.0.1:43210/api/v1/connect', designBase: 'http://127.0.0.1:43210/design/api' },
    });
    expect(resolveTokenToSeaTestOrigin('https://localhost:8443/', unpackaged)).toMatchObject({ status: 'test-origin', origin: 'https://localhost:8443' });
    expect(resolveTokenToSeaTestOrigin('http://[::1]:9000', unpackaged)).toMatchObject({ status: 'test-origin', endpoints: tokenToSeaTestEndpoints('http://[::1]:9000') });
  });

  it('ignores any value in a packaged runtime, even a valid loopback origin', () => {
    expect(resolveTokenToSeaTestOrigin('http://127.0.0.1:43210', { packaged: true })).toEqual({ status: 'ignored', reason: 'packaged-runtime' });
  });

  it('ignores remote hosts', () => {
    for (const value of ['https://tokentosea.com', 'http://evil.example:80', 'http://10.0.0.2:3000', 'http://localhost.evil.example', 'http://127.0.0.2:3000']) {
      expect(resolveTokenToSeaTestOrigin(value, unpackaged)).toEqual({ status: 'ignored', reason: 'not-loopback' });
    }
  });

  it('ignores malformed values and anything beyond a bare http(s) origin', () => {
    for (const value of ['not a url', '127.0.0.1:43210', 'ftp://127.0.0.1', 'file:///tmp', 'http://user:pass@127.0.0.1:1', 'http://127.0.0.1:1/api', 'http://127.0.0.1:1/?x=1', 'http://127.0.0.1:1?', 'http://127.0.0.1:1/#x']) {
      expect(resolveTokenToSeaTestOrigin(value, unpackaged)).toEqual({ status: 'ignored', reason: 'malformed' });
    }
  });

  it('logs one line when active, one warning when ignored and nothing when absent', () => {
    const log = { log: vi.fn(), warn: vi.fn() };
    expect(tokenToSeaEndpointsFromEnvironment({}, false, log)).toBeUndefined();
    expect(log.log).not.toHaveBeenCalled(); expect(log.warn).not.toHaveBeenCalled();

    expect(tokenToSeaEndpointsFromEnvironment({ OD_TOKENTOSEA_TEST_ORIGIN: 'http://127.0.0.1:43210' }, false, log)).toEqual(tokenToSeaTestEndpoints('http://127.0.0.1:43210'));
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.log.mock.calls[0]![0]).toContain('OD_TOKENTOSEA_TEST_ORIGIN active');

    expect(tokenToSeaEndpointsFromEnvironment({ OD_TOKENTOSEA_TEST_ORIGIN: 'http://127.0.0.1:43210' }, true, log)).toBeUndefined();
    expect(tokenToSeaEndpointsFromEnvironment({ OD_TOKENTOSEA_TEST_ORIGIN: 'https://tokentosea.example' }, false, log)).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls.map(call => String(call[0]))).toEqual([
      expect.stringContaining('ignoring OD_TOKENTOSEA_TEST_ORIGIN (packaged-runtime)'),
      expect.stringContaining('ignoring OD_TOKENTOSEA_TEST_ORIGIN (not-loopback)'),
    ]);
    expect(log.log).toHaveBeenCalledTimes(1);
  });
});

describe('TokenToSeaRuntime identity endpoints', () => {
  function runtime(): TokenToSeaRuntime {
    const folder = mkdtempSync(path.join(tmpdir(), 'tts-runtime-endpoints-')); folders.push(folder);
    const created = new TokenToSeaRuntime(folder);
    created.identity.close(); created.usage.close();
    return created;
  }

  it('builds its identity on production endpoints by default', () => {
    vi.stubEnv(TOKENTOSEA_TEST_ORIGIN_ENV, '');
    expect(runtime().identity.endpoints).toEqual(production);
  });

  it('builds its identity on the test origin in an unpackaged daemon', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubEnv(TOKENTOSEA_TEST_ORIGIN_ENV, 'http://127.0.0.1:43210');
    expect(runtime().identity.endpoints).toEqual(tokenToSeaTestEndpoints('http://127.0.0.1:43210'));
  });

  it('keeps production endpoints when the daemon is packaged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // A packaged daemon runs under Electron's node.
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    vi.stubEnv(TOKENTOSEA_TEST_ORIGIN_ENV, 'http://127.0.0.1:43210');
    expect(runtime().identity.endpoints).toEqual(production);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('packaged signal for the TokenToSea test seam', () => {
  it('treats plain Node from a CI tool cache as unpackaged', () => {
    expect(isPackagedForTestSeam({ electron: undefined, resourcesPath: undefined, execPath: '/opt/hostedtoolcache/node/24.22.1/x64/bin/node', env: {} })).toBe(false);
    expect(isPackagedForTestSeam({ electron: undefined, resourcesPath: undefined, execPath: '/Users/dev/.local/share/mise/installs/node/24.22.1/bin/node', env: {} })).toBe(false);
  });

  it('treats Electron, a resources path or an app-bundle executable as packaged', () => {
    expect(isPackagedForTestSeam({ electron: '41.3.0', resourcesPath: undefined, execPath: '/x/node', env: {} })).toBe(true);
    expect(isPackagedForTestSeam({ electron: undefined, resourcesPath: '/Applications/FantayDesign.app/Contents/Resources', execPath: '/x/node', env: {} })).toBe(true);
    expect(isPackagedForTestSeam({ electron: undefined, resourcesPath: undefined, execPath: '/x/node', env: { ELECTRON_RUN_AS_NODE: '1' } })).toBe(true);
    expect(isPackagedForTestSeam({ electron: undefined, resourcesPath: undefined, execPath: '/Applications/FantayDesign.app/Contents/Resources/open-design/bin/node', env: {} })).toBe(true);
    expect(isPackagedForTestSeam({ electron: undefined, resourcesPath: undefined, execPath: 'C:\\Program Files\\Fantaydesign\\resources\\open-design\\bin\\node.exe', env: {} })).toBe(true);
    expect(isPackagedForTestSeam({ electron: undefined, resourcesPath: undefined, execPath: '/opt/Fantaydesign/resources/app.asar.unpacked/node', env: {} })).toBe(true);
  });
});
