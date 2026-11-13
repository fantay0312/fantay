// Test-time copy of the synthetic material library fixture.
//
// `素材库/` next to this file is a tiny archive in the shape the real
// tooling produces (`导览支持/search-index.json` + `assets.jsonl`, built with
// the archive's own `compact()`/`capabilities()`). Tests never read it in
// place: they copy it into a temp folder, add the symlinks and edge-case
// trees git cannot (or should not) carry, and point FANTASY_DESIGN_LIBRARY at
// the copy.

import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MATERIALS_FIXTURE_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '素材库');
export const SONNER_DIR = '交互组件/Sonner-通知反馈';

export interface MaterialsFixture {
  /** Temp folder holding the library copy and the "outside" files. */
  parent: string;
  /** Realpath of the copied `素材库` folder. */
  root: string;
  /** A file outside the library that symlinks point at. */
  outsideFile: string;
  cleanup(): void;
}

export function createMaterialsFixture(): MaterialsFixture {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), 'od-materials-fixture-')));
  const root = path.join(parent, '素材库');
  cpSync(MATERIALS_FIXTURE_SOURCE, root, { recursive: true });

  // `symlink-escape`: entry and thumbnail point outside the library.
  const outsideFile = path.join(parent, 'outside-secret.md');
  writeFileSync(outsideFile, 'outside the library\n');
  const outsidePng = path.join(parent, 'outside.png');
  writeFileSync(outsidePng, readFileSync(path.join(root, SONNER_DIR, 'references/preview.png')));
  const escapeDir = path.join(root, '杂项/escape');
  mkdirSync(escapeDir, { recursive: true });
  symlinkSync(outsideFile, path.join(escapeDir, 'leak.md'));
  symlinkSync(outsidePng, path.join(escapeDir, 'leak.png'));

  // Trees the copy walker must skip inside `upstream/`.
  const upstream = path.join(root, SONNER_DIR, 'upstream');
  writeFileSync(path.join(upstream, 'src/.hidden.ts'), 'export {};\n');
  mkdirSync(path.join(upstream, 'node_modules/pkg'), { recursive: true });
  writeFileSync(path.join(upstream, 'node_modules/pkg/index.d.ts'), 'export {};\n');
  mkdirSync(path.join(upstream, 'src/__pycache__'), { recursive: true });
  writeFileSync(path.join(upstream, 'src/__pycache__/state.pyc'), 'x');
  writeFileSync(path.join(upstream, '.DS_Store'), 'x');
  symlinkSync(path.join(root, '交互组件/Vaul-抽屉'), path.join(upstream, 'src/linked-dir'));

  // A file symlink inside a selectable directory rejects the copy.
  mkdirSync(path.join(root, SONNER_DIR, 'evil'), { recursive: true });
  writeFileSync(path.join(root, SONNER_DIR, 'evil/ok.md'), 'fine\n');
  symlinkSync(outsideFile, path.join(root, SONNER_DIR, 'evil/link.md'));

  // Copy limits: 201 files, and one sparse file just over 64 MiB.
  const many = path.join(root, SONNER_DIR, 'many');
  mkdirSync(many, { recursive: true });
  for (let i = 0; i < 201; i += 1) writeFileSync(path.join(many, `f${String(i).padStart(3, '0')}.txt`), `${i}\n`);
  const big = path.join(root, SONNER_DIR, 'big');
  mkdirSync(big, { recursive: true });
  writeFileSync(path.join(big, 'huge.bin'), '');
  truncateSync(path.join(big, 'huge.bin'), 64 * 1024 * 1024 + 1);

  return {
    parent,
    root: realpathSync(root),
    outsideFile,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  };
}

/** Replace the copied index with `content` (string or JSON value). */
export function writeFixtureIndex(root: string, content: unknown): void {
  writeFileSync(
    path.join(root, '导览支持/search-index.json'),
    typeof content === 'string' ? content : `${JSON.stringify(content)}\n`,
  );
}

export function readFixtureIndex(root: string): { schema_version: number; assets: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(path.join(root, '导览支持/search-index.json'), 'utf8'));
}
