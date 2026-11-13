import { existsSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it('resolves live workspace imports from source while packaging replaces dist', async () => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.resetModules();
  const config = (await import('../../next.config')).default;
  expect(config.webpack).toBeTypeOf('function');
  const input = { resolve: { alias: { existing: '/keep-me' } } };
  const output = config.webpack!(input, {} as never);
  expect(output.resolve.alias.existing).toBe('/keep-me');
  expect(output.resolve.alias['@open-design/contracts/analytics$']).toMatch(/packages\/contracts\/src\/analytics\/index\.ts$/);
  expect(output.resolve.alias['@open-design/contracts$']).toMatch(/packages\/contracts\/src\/index\.ts$/);
  expect(output.resolve.alias['@open-design/release$']).toMatch(/packages\/release\/src\/index\.ts$/);
  expect(output.resolve.alias['@open-design/host$']).toMatch(/packages\/host\/src\/index\.ts$/);
  for (const [key, file] of Object.entries(output.resolve.alias)) {
    if (!key.startsWith('@open-design/')) continue;
    expect(file).not.toContain('/dist/');
    expect(existsSync(file as string)).toBe(true);
  }
  expect(config.experimental?.extensionAlias?.['.js']).toContain('.ts');
  expect(config.turbopack?.resolveAlias?.['@open-design/contracts/analytics']).toBe(output.resolve.alias['@open-design/contracts/analytics$']);
});

it('leaves packaged production imports on their published package exports', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('OD_WEB_OUTPUT_MODE', 'standalone');
  vi.resetModules();
  const config = (await import('../../next.config')).default;
  expect(config.webpack).toBeUndefined();
  expect(config.turbopack?.resolveAlias).toBeUndefined();
  expect(config.experimental?.extensionAlias).toBeUndefined();
  expect(config.output).toBe('standalone');
});
