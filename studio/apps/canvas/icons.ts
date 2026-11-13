// SPDX-License-Identifier: Apache-2.0
/**
 * Icon compilation for the design editor (unplugin-icons).
 *
 * D1: Lucide icons draw with a 1.5 stroke everywhere in the editor chrome. Lucide ships 2;
 * unplugin-icons applies its `transform` option only to custom collections, so the editor uses
 * its own Vue 3 compiler that rewrites the stroke before compiling the SVG into a render
 * function (same output shape as unplugin-icons' built-in `vue3` compiler).
 */
import { compileTemplate } from 'vue/compiler-sfc';

export const LUCIDE_STROKE_WIDTH = '1.5';

/** Rewrites every Lucide `stroke-width="2"` to the Fantay stroke; other collections pass through. */
export function fantayIconSvg(svg: string, collection: string): string {
  return collection === 'lucide' ? svg.replaceAll('stroke-width="2"', `stroke-width="${LUCIDE_STROKE_WIDTH}"`) : svg;
}

/** unplugin-icons custom compiler: Vue 3 render-function module for one icon. */
export function compileFantayIcon(svg: string, collection: string, icon: string): string {
  const { code } = compileTemplate({
    source: fantayIconSvg(svg, collection),
    id: `${collection}:${icon}`,
    filename: `${collection}-${icon}.vue`,
  });
  return [
    "import { markRaw } from 'vue'",
    code.replace(/^export /gm, ''),
    `export default markRaw({ name: '${collection}-${icon}', render })`,
    '/* vite-plugin-components disabled */',
  ].join('\n');
}
