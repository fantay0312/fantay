// SPDX-License-Identifier: AGPL-3.0-only
// Formulas in Mermaid labels (`A["$$x^2$$"]`), typeset with the product's KaTeX engine. pele asks
// a resolver for each formula's size while it lays the diagram out, and draws whatever markup the
// resolver hands back. Here the resolver hands back only an empty, numbered placeholder: pele's
// output then goes through the SVG sanitiser unchanged (no `foreignObject`, no HTML), and the
// typeset formula is put in the placeholder afterwards. A formula's markup is built by KaTeX
// (`trust` off), never copied from the file, so it does not need to pass the wall; nothing the
// file writes can become markup on this path.
//
// A formula is measured as the page will draw it, so its fonts must be loaded first. The first
// layout pass only finds the formulas (that asks for their fonts); `settle` waits for the fonts and
// the second pass measures.
import type { MathResolver } from 'pele/lazy';

import { typesetFormula } from '../../math/engine';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
/** Marks the placeholder pele draws for formula N. */
export const MATH_SLOT = 'data-fx-math';
/** Formulas one drawing may hold; the rest stay as their source. */
const MAX_FORMULAS = 400;
/**
 * KaTeX sets a formula at 1.21 times its text, right beside Latin serif prose and too large beside
 * interface type and Chinese. A label's formula is set at 1.08 times the label, as in a notebook;
 * the factor is applied to the box, so what is measured is exactly what is drawn.
 */
const MATH_SCALE = 1.08 / 1.21;

/** The font size of the box a formula of a `size` px label sits in. */
function boxFontSize(size: number): string {
  return `${Math.round(size * MATH_SCALE * 100) / 100}px`;
}

interface Typeset {
  markup: string;
  /** The label's font size in px; KaTeX scales from it. */
  size: number;
  width: number;
  height: number;
}

export interface LabelMath {
  resolver: MathResolver;
  /** True when at least one formula was typeset. */
  used(): boolean;
  /** Waits for the fonts the formulas ask for, then forgets the sizes so the next pass measures again. */
  settle(): Promise<void>;
  /** Puts each typeset formula where pele left its placeholder. */
  place(svg: SVGSVGElement): void;
  dispose(): void;
}

/** The box pele gives a formula: centred, on one line, at the label's size. */
function boxStyle(size: number): string {
  return `display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:${boxFontSize(size)};line-height:normal;white-space:nowrap`;
}

export function createLabelMath(): LabelMath {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none;contain:layout style';
  document.body.append(host);

  const formulas: Typeset[] = [];
  const byKey = new Map<string, number | null>();
  const probes = new Map<number, HTMLElement>();

  const measure = (index: number): void => {
    const entry = formulas[index];
    const probe = probes.get(index);
    if (!entry || !probe) return;
    const rect = probe.getBoundingClientRect();
    entry.width = Math.max(1, Math.ceil(rect.width));
    entry.height = Math.max(1, Math.ceil(rect.height));
  };

  return {
    resolver(tex, size) {
      const key = `${size}\n${tex}`;
      let index = byKey.get(key);
      if (index === undefined) {
        const markup = formulas.length < MAX_FORMULAS ? typesetFormula({ tex, display: false }, 'html') : null;
        if (markup === null) {
          index = null;
        } else {
          const probe = document.createElement('span');
          probe.style.cssText = `display:inline-block;font-size:${boxFontSize(size)};line-height:normal;white-space:nowrap`;
          probe.innerHTML = markup;
          host.append(probe);
          index = formulas.length;
          formulas.push({ markup, size, width: 1, height: 1 });
          probes.set(index, probe);
          measure(index);
        }
        byKey.set(key, index);
      }
      if (index === null) return null;
      const entry = formulas[index];
      return entry ? { svg: `<g ${MATH_SLOT}="${index}"/>`, width: entry.width, height: entry.height } : null;
    },
    used: () => formulas.length > 0,
    async settle() {
      if (formulas.length === 0) return;
      try {
        await document.fonts?.ready;
      } catch {
        /* A face that cannot load is measured with its fallback, which is also what is drawn. */
      }
      for (const index of probes.keys()) measure(index);
    },
    place(svg) {
      for (const slot of Array.from(svg.querySelectorAll(`[${MATH_SLOT}]`))) {
        const entry = formulas[Number(slot.getAttribute(MATH_SLOT))];
        // Only the placeholder pele drew for a formula: an empty group directly inside its `pele-math` box.
        const box = slot.parentElement;
        if (!entry || slot.localName !== 'g' || slot.childElementCount > 0 || box?.localName !== 'svg' || !box.classList.contains('pele-math')) {
          slot.removeAttribute(MATH_SLOT);
          continue;
        }
        const frame = svg.ownerDocument.createElementNS(SVG_NS, 'foreignObject');
        frame.setAttribute('width', '100%');
        frame.setAttribute('height', '100%');
        frame.setAttribute(MATH_SLOT, '');
        const content = svg.ownerDocument.createElementNS(XHTML_NS, 'div') as HTMLElement;
        content.setAttribute('style', boxStyle(entry.size));
        content.innerHTML = entry.markup;
        frame.append(content);
        slot.replaceWith(frame);
      }
    },
    dispose() {
      host.remove();
      probes.clear();
    },
  };
}
