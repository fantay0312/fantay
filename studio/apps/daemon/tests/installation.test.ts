import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readAppConfig, writeAppConfig } from '../src/app-config.js';
import {
  readInstallationFile,
  writeInstallationFile,
} from '../src/installation.js';

/**
 * Fantaydesign ships with automatic reporting switched off, so there is no
 * analytics person to keep continuous: the app-config layer never surfaces
 * or persists an installation identity. The contract these tests pin down:
 * a legacy id (left in `app-config.json` by a 0.7.x daemon, or in the
 * channel-root `installation.json` by an earlier install) is never served,
 * never mirrored forward, and any explicit installationId write clears the
 * channel-root copy instead of storing a new one.
 *
 * Two directories per test:
 *   - `dataDir`     — simulates `<namespace>/data/`
 *   - `installDir`  — simulates the channel root (`<userData>/`)
 * They live as siblings so we can independently reset either side.
 */

let rootDir: string;
let dataDir: string;
let installDir: string;
const SAVED_INSTALL_ENV = process.env.OD_INSTALLATION_DIR;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'od-install-test-'));
  dataDir = join(rootDir, 'namespace', 'data');
  installDir = join(rootDir, 'channel-root');
  await mkdir(dataDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  process.env.OD_INSTALLATION_DIR = installDir;
});

afterEach(async () => {
  if (SAVED_INSTALL_ENV == null) {
    delete process.env.OD_INSTALLATION_DIR;
  } else {
    process.env.OD_INSTALLATION_DIR = SAVED_INSTALL_ENV;
  }
  if (rootDir != null) {
    await rm(rootDir, { recursive: true, force: true });
  }
});

describe('installation identity under the no-reporting product policy', () => {
  it('does not serve a legacy app-config installationId (0.7.x state)', async () => {
    await writeFile(
      join(dataDir, 'app-config.json'),
      JSON.stringify({ installationId: 'legacy-id-7' }),
      'utf8',
    );
    const cfg = await readAppConfig(dataDir);
    expect(cfg.installationId).toBeNull();
  });

  it('does not mirror a legacy app-config installationId into installation.json on read', async () => {
    await writeFile(
      join(dataDir, 'app-config.json'),
      JSON.stringify({ installationId: 'legacy-id-8' }),
      'utf8',
    );
    await readAppConfig(dataDir);
    const persisted = await readInstallationFile(installDir);
    expect(persisted.installationId).toBeUndefined();
  });

  it('does not serve an installation.json id when app-config.json was wiped', async () => {
    await writeInstallationFile(installDir, { installationId: 'stable-id' });
    // dataDir is empty — no app-config.json
    const cfg = await readAppConfig(dataDir);
    expect(cfg.installationId).toBeNull();
  });

  it('serves neither id when installation.json and app-config.json diverge', async () => {
    await writeInstallationFile(installDir, { installationId: 'new-id' });
    await writeFile(
      join(dataDir, 'app-config.json'),
      JSON.stringify({ installationId: 'old-id' }),
      'utf8',
    );
    const cfg = await readAppConfig(dataDir);
    expect(cfg.installationId).toBeNull();
  });

  it('never persists an installationId from writeAppConfig to either file', async () => {
    await writeAppConfig(dataDir, { installationId: 'fresh-id', telemetry: { metrics: true } });
    const persisted = await readInstallationFile(installDir);
    expect(persisted.installationId).toBeUndefined();
    const appConfigContents = JSON.parse(
      await readFile(join(dataDir, 'app-config.json'), 'utf8'),
    ) as { installationId: unknown; telemetry: { metrics: unknown } };
    expect(appConfigContents.installationId).toBeNull();
    expect(appConfigContents.telemetry.metrics).toBe(false);
  });

  it('does not touch installation.json on an unrelated writeAppConfig (no churn)', async () => {
    await writeInstallationFile(installDir, { installationId: 'untouched' });
    await writeAppConfig(dataDir, { telemetry: { metrics: true } });
    const persisted = await readInstallationFile(installDir);
    expect(persisted.installationId).toBe('untouched');
  });

  it('falls back to dataDir when OD_INSTALLATION_DIR is unset (dev / OSS / tools-dev paths)', async () => {
    delete process.env.OD_INSTALLATION_DIR;
    await writeInstallationFile(dataDir, { installationId: 'devmode-legacy-id' });
    await writeInstallationFile(installDir, { installationId: 'channel-root-id' });
    await writeAppConfig(dataDir, { installationId: 'devmode-id' });
    // With no override, the clear lands in the install file next to app-config.json.
    expect((await readInstallationFile(dataDir)).installationId).toBeUndefined();
    expect((await readInstallationFile(installDir)).installationId).toBe('channel-root-id');
  });

  it('returns an empty object when neither file exists (cold first boot)', async () => {
    const cfg = await readAppConfig(dataDir);
    expect(cfg.installationId).toBeUndefined();
    const persisted = await readInstallationFile(installDir);
    expect(persisted.installationId).toBeUndefined();
  });

  it('clears a legacy installation.json id when "Delete my data" sets installationId to null', async () => {
    await writeInstallationFile(installDir, { installationId: 'before-delete' });
    // "Delete my data" path: PUT /api/app-config with installationId: null.
    await writeAppConfig(dataDir, { installationId: null });
    const persisted = await readInstallationFile(installDir);
    expect(persisted.installationId).toBeUndefined();
    const cfg = await readAppConfig(dataDir);
    expect(cfg.installationId).toBeNull();
  });

  it('clears a legacy installation.json id instead of storing a rotated fresh id', async () => {
    await writeInstallationFile(installDir, { installationId: 'old' });
    await writeAppConfig(dataDir, { installationId: 'new' });
    const persisted = await readInstallationFile(installDir);
    expect(persisted.installationId).toBeUndefined();
  });
});
