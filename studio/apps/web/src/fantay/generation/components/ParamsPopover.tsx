// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/image-settings-panel.tsx
// (AspectIcon, option grid) and web/src/components/video-settings-panel.tsx (duration/count rows).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29 (spec 05 §5.6): only what the selected model supports (aspect,
// quality, resolution, duration, count 1–4) from `GenerationParamSupport`, Fantay primitives, the summary
// as a plain text trigger; every change goes to `onChange` (the panel patches the generator, undoable).
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { GenerationParamSupport, GenerationSurface, GeneratorParams, MediaAspect } from '@open-design/contracts';

import { useT } from '../../../i18n';
import type { Dict } from '../../../i18n/types';
import { Button, Popover, PopoverContent, PopoverTrigger, Segmented, SegmentedItem } from '../../ui';
import { BOARD_CONTROL_PROPS, BOARD_INTERACTIVE_PROPS } from './board-interactive';
import styles from './ParamsPopover.module.css';

type DictKey = keyof Dict;
type Translate = (key: DictKey, vars?: Record<string, string | number>) => string;

const QUALITY_KEYS: Record<string, DictKey> = {
  auto: 'fantay.gen.params.quality.auto',
  low: 'fantay.gen.params.quality.low',
  medium: 'fantay.gen.params.quality.medium',
  high: 'fantay.gen.params.quality.high',
};

const COUNTS = [1, 2, 3, 4] as const;

export function qualityLabel(t: Translate, quality: string): string {
  const key = QUALITY_KEYS[quality];
  return key ? t(key) : quality;
}

export function countLabel(t: Translate, surface: GenerationSurface, count: number): string {
  return t(surface === 'video' ? 'fantay.gen.params.countVideos' : 'fantay.gen.params.countImages', { n: count });
}

/** `1:1 · 2 张`, `16:9 · 5 秒 · 1 个`, plus quality / resolution when set. */
export function paramsSummary(t: Translate, surface: GenerationSurface, params: GeneratorParams): string {
  const parts: string[] = [params.aspect];
  if (surface === 'video' && typeof params.length === 'number') parts.push(t('fantay.gen.params.seconds', { n: params.length }));
  if (params.quality) parts.push(qualityLabel(t, params.quality));
  if (params.resolution) parts.push(params.resolution);
  parts.push(countLabel(t, surface, params.count));
  return parts.join(' · ');
}

function AspectShape({ aspect }: { aspect: MediaAspect }) {
  const [w, h] = aspect.split(':').map(Number);
  const ratio = w && h ? w / h : 1;
  const long = 22;
  const width = ratio >= 1 ? long : Math.max(9, Math.round(long * ratio));
  const height = ratio >= 1 ? Math.max(9, Math.round(long / ratio)) : long;
  return <span className={styles.aspectShape} style={{ width, height }} aria-hidden />;
}

export interface ParamsPopoverProps {
  surface: GenerationSurface;
  support: GenerationParamSupport;
  value: GeneratorParams;
  onChange(next: GeneratorParams): void;
  disabled?: boolean;
}

export function ParamsPopover({ surface, support, value, onChange, disabled = false }: ParamsPopoverProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const change = (patch: Partial<GeneratorParams>) => onChange({ ...value, ...patch });
  const summary = paramsSummary(t, surface, value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="bare"
          size="md"
          className={styles.trigger}
          data-testid="fx-gen-params-trigger"
          aria-label={`${t('fantay.gen.params.label')}: ${summary}`}
          disabled={disabled}
          {...BOARD_CONTROL_PROPS}
        >
          <span className={styles.triggerLabel}>{summary}</span>
          <ChevronDown size={14} strokeWidth={1.5} aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        width={340}
        align="start"
        side="top"
        className="p-0"
        aria-label={t('fantay.gen.params.label')}
        data-testid="fx-gen-params-popover"
        {...BOARD_INTERACTIVE_PROPS}
      >
        <div className={styles.body}>
          <section className={styles.section} data-testid="fx-gen-param-aspect">
            <span className={styles.title}>{t('fantay.gen.params.aspect')}</span>
            <div className={styles.aspects} role="group" aria-label={t('fantay.gen.params.aspect')}>
              {support.aspects.map((aspect) => (
                <Button
                  key={aspect}
                  variant="ghost"
                  size="md"
                  className={styles.aspectTile}
                  aria-pressed={value.aspect === aspect}
                  data-testid={`fx-gen-param-aspect-${aspect}`}
                  onClick={() => change({ aspect })}
                >
                  <AspectShape aspect={aspect} />
                  <span>{aspect}</span>
                </Button>
              ))}
            </div>
          </section>

          {support.qualities && support.qualities.length > 0 ? (
            <section className={styles.section} data-testid="fx-gen-param-quality">
              <span className={styles.title}>{t('fantay.gen.params.quality')}</span>
              <Segmented
                size="sm"
                className={styles.segmented}
                aria-label={t('fantay.gen.params.quality')}
                value={value.quality ?? support.defaultQuality ?? support.qualities[0] ?? ''}
                onValueChange={(quality) => change({ quality })}
              >
                {support.qualities.map((quality) => (
                  <SegmentedItem key={quality} value={quality} data-testid={`fx-gen-param-quality-${quality}`}>
                    {qualityLabel(t, quality)}
                  </SegmentedItem>
                ))}
              </Segmented>
            </section>
          ) : null}

          {support.resolutions && support.resolutions.length > 0 ? (
            <section className={styles.section} data-testid="fx-gen-param-resolution">
              <span className={styles.title}>{t('fantay.gen.params.resolution')}</span>
              <Segmented
                size="sm"
                className={styles.segmented}
                aria-label={t('fantay.gen.params.resolution')}
                value={value.resolution ?? support.defaultResolution ?? support.resolutions[0] ?? ''}
                onValueChange={(resolution) => change({ resolution })}
              >
                {support.resolutions.map((resolution) => (
                  <SegmentedItem key={resolution} value={resolution} data-testid={`fx-gen-param-resolution-${resolution}`}>
                    {resolution}
                  </SegmentedItem>
                ))}
              </Segmented>
            </section>
          ) : null}

          {surface === 'video' && support.lengths && support.lengths.length > 0 ? (
            <section className={styles.section} data-testid="fx-gen-param-duration">
              <span className={styles.title}>{t('fantay.gen.params.duration')}</span>
              <Segmented
                size="sm"
                className={styles.segmented}
                aria-label={t('fantay.gen.params.duration')}
                value={String(value.length ?? support.lengths[0] ?? '')}
                onValueChange={(length) => change({ length: Number(length) })}
              >
                {support.lengths.map((length) => (
                  <SegmentedItem key={length} value={String(length)} data-testid={`fx-gen-param-duration-${length}`}>
                    {t('fantay.gen.params.seconds', { n: length })}
                  </SegmentedItem>
                ))}
              </Segmented>
              <span className={styles.note}>{t('fantay.gen.params.durationNote')}</span>
            </section>
          ) : null}

          <section className={styles.section} data-testid="fx-gen-param-count">
            <span className={styles.title}>{t('fantay.gen.params.count')}</span>
            <Segmented
              size="sm"
              className={styles.segmented}
              aria-label={t('fantay.gen.params.count')}
              value={String(value.count)}
              onValueChange={(count) => change({ count: Number(count) as GeneratorParams['count'] })}
            >
              {COUNTS.map((count) => (
                <SegmentedItem key={count} value={String(count)} data-testid={`fx-gen-param-count-${count}`}>
                  {countLabel(t, surface, count)}
                </SegmentedItem>
              ))}
            </Segmented>
          </section>
        </div>
      </PopoverContent>
    </Popover>
  );
}
