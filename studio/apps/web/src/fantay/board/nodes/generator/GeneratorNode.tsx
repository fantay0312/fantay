'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Generator face (spec 03 §4.9, plan R4): the generation UI (05 `GeneratorNodeBody`) when
// `extensions.renderGeneratorBody` is injected; otherwise the minimal fallback — header (Sparkles, surface, model),
// the prompt preview (3 lines; `@[node:…]` tokens shown as the referenced kind) and the input summary from the
// incoming reference edges. The panel opens through the chrome's panel slot, never from the face.
import { Sparkles } from 'lucide-react';

import { useT } from '../../../../i18n';
import { useBoardHost, useBoardSelector } from '../../context';
import type { EngineNodeOf, NodeFaceProps } from '../../model/types';
import type { EngineState } from '../../store/board-store';
import { ICON_STROKE } from '../common/kind-icons';
import { useNodeBodyProps } from '../media/body-props';
import styles from './generator.module.css';

/** Incoming `reference` sources by family (images vs notes/texts). */
export function generatorInputs(state: Pick<EngineState, 'doc'>, generatorId: string): { images: number; texts: number } {
  let images = 0;
  let texts = 0;
  for (const edge of state.doc.edges.values()) {
    if (edge.kind !== 'reference' || edge.to !== generatorId) continue;
    const source = state.doc.nodes.get(edge.from);
    if (!source) continue;
    if (source.kind === 'note') texts += 1;
    else images += 1;
  }
  return { images, texts };
}

/** The prompt with reference tokens folded to a readable marker. */
export function promptPreview(prompt: string): string {
  return prompt.replace(/@\[node:[^\]]+\]/g, '@').replace(/\s+/g, ' ').trim();
}

export function GeneratorNode({ view }: NodeFaceProps) {
  const { extensions } = useBoardHost();
  const body = useNodeBodyProps(view, 'generator');
  if (extensions?.renderGeneratorBody) {
    return (
      <div className={styles.body} data-testid="board-generator-body">
        {extensions.renderGeneratorBody(body)}
      </div>
    );
  }
  return <GeneratorFallback view={view} />;
}

function GeneratorFallback({ view }: NodeFaceProps) {
  const t = useT();
  const node = view.node as EngineNodeOf<'generator'>;
  const inputs = useBoardSelector(
    (state) => generatorInputs(state, node.id),
    (a, b) => a.images === b.images && a.texts === b.texts,
  );
  const prompt = promptPreview(node.data.prompt ?? '');
  const surface = node.data.surface === 'video' ? 'video' : 'image';
  const params = node.data.params;
  const settings = [params?.aspect, params?.quality, params?.count ? `×${params.count}` : null].filter(Boolean).join(' · ');
  return (
    <div className={styles.generator} data-testid="board-generator" data-selected={view.selected ? '' : undefined}>
      <div className={styles.header}>
        <span className={styles.glyph} aria-hidden>
          <Sparkles size={14} strokeWidth={ICON_STROKE} />
        </span>
        <span className={styles.surface}>{t(surface === 'video' ? 'board.node.generator.surface.video' : 'board.node.generator.surface.image')}</span>
        <span className={styles.model}>{node.data.model ?? t('board.node.generator.noModel')}</span>
      </div>
      <p className={styles.prompt} data-empty={prompt ? undefined : ''}>
        {prompt || t('board.node.generator.placeholder')}
      </p>
      <div className={styles.footer}>
        <span>{t('board.node.generator.inputs', { images: inputs.images, texts: inputs.texts })}</span>
        {settings ? <span className={styles.settings}>{settings}</span> : null}
      </div>
    </div>
  );
}
