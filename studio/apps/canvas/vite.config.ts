// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import Icons from 'unplugin-icons/vite';
import IconsResolver from 'unplugin-icons/resolver';
import Components from 'unplugin-vue-components/vite';
import { access, cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canvasAliases } from './aliases.ts';
import { compileFantayIcon } from './icons.ts';

const root = path.dirname(fileURLToPath(import.meta.url));

/** Bundled runtime packages whose licence ships next to the editor (06 §3.2). */
const LICENSED_DEPENDENCIES = [
  '@open-pencil/core', '@open-pencil/vue', '@open-pencil/scene-graph', '@open-pencil/dom-css', 'vue', 'react', 'react-dom', 'canvaskit-wasm',
  'reka-ui', '@floating-ui/vue', '@vueuse/core', 'tailwind-variants', 'tailwind-merge', 'es-toolkit', 'fflate', '@zseven-w/op-web-sdk',
  'tailwindcss', 'tw-animate-css',
];
const LICENSE_FILE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md'];
/** Packages that publish no licence file; their committed copy lives in apps/canvas/licenses/. */
const COMMITTED_LICENSE_FALLBACKS: Record<string, string> = { '@zseven-w/op-web-sdk': 'OpenPencil-ZSeven-MIT.txt' };

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false);
}

async function copyDependencyLicense(dependency: string, licenses: string): Promise<void> {
  for (const name of LICENSE_FILE_NAMES) {
    const source = path.join(root, 'node_modules', dependency, name);
    if (await exists(source)) {
      await cp(source, path.join(licenses, dependency.replaceAll('/', '_') + '.txt'));
      return;
    }
  }
  const fallback = COMMITTED_LICENSE_FALLBACKS[dependency];
  if (fallback && await exists(path.join(root, 'licenses', fallback))) return; // copied with apps/canvas/licenses
  throw new Error(`No licence file for bundled dependency ${dependency}; commit one under apps/canvas/licenses/`);
}

export default defineConfig({
  resolve: { alias: canvasAliases(root) },
  plugins: [{
    name: 'open-pencil-published-worker-extensions',
    enforce: 'pre',
    transform(code, id) {
      // 0.16.0 publishes compiled JS workers but retains TS URLs in two clients.
      if (!id.includes('/@open-pencil/core/dist/')) return;
      return code.replaceAll('"./export-worker.ts"', '"./export-worker.js"').replaceAll('"./worker.ts"', '"./worker.js"');
    },
  }, tailwindcss(), vue(), Icons({
    // D1: Lucide stroke 1.5 everywhere in the editor chrome (see icons.ts).
    compiler: { compiler: compileFantayIcon },
    scale: 1,
    defaultClass: '',
  }), Components({
    dirs: [],
    dts: 'src/components.d.ts',
    resolvers: [IconsResolver({ prefix: 'icon', enabledCollections: ['lucide'] })],
  }), {
    name: 'bundle-local-renderer-assets',
    async closeBundle() {
      const output = path.resolve(root, '../web/public/canvas-editor');
      await cp(path.resolve(root, 'node_modules/@open-pencil/core/assets'), output, { recursive: true });
      await cp(path.join(root, 'assets'), output, { recursive: true });
      const licenses = path.join(output, 'licenses');
      await mkdir(licenses, { recursive: true });
      await cp(path.join(root, 'licenses'), licenses, { recursive: true });
      await cp(path.join(root, 'src/vendor/open-pencil/LICENSE'), path.join(licenses, 'OpenPencil-app-MIT.txt'));
      for (const dependency of LICENSED_DEPENDENCIES) await copyDependencyLicense(dependency, licenses);
      await cp(path.resolve(root, 'node_modules/canvaskit-wasm/bin/canvaskit.wasm'), path.join(output, 'canvaskit.wasm'));
      await cp(path.resolve(root, 'node_modules/@zseven-w/op-web-sdk/wasm/op_web_sdk_bg.wasm'), path.join(output, 'op_web_sdk_bg.wasm'));
      const ck = path.resolve(root, '../web/public/canvaskit');
      await mkdir(ck, { recursive: true });
      for (const file of ['canvaskit.js', 'canvaskit.wasm']) await cp(path.resolve(root, 'node_modules/canvaskit-wasm/bin', file), path.join(ck, file));
    },
  }],
  base: '/canvas-editor/',
  build: { outDir: '../web/public/canvas-editor', emptyOutDir: true },
});
