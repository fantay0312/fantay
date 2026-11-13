// SPDX-License-Identifier: AGPL-3.0-only
// Style editor fields (spec 07 §4.2, §6.3), moved out of MovieStudio's `styleFields`: name, three
// colour swatches (`label > input[type=color]`), font, entrance motion, composition preset and the
// visual layer list. Used by the create panel (remix / my style) and the editor style stage.
import { useId, useMemo } from 'react';
import { Trash2 } from 'lucide-react';
import { MOVIE_STYLES, type MovieStyle } from '@open-design/contracts';

import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { Disclosure, Icon, IconButton, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, cn } from '../ui';
import styles from './StyleFields.module.css';

type DictKey = keyof Dict;

export interface StyleFieldsProps {
  value: MovieStyle;
  onChange: (next: MovieStyle) => void;
  disabled?: boolean;
  className?: string;
}

const COLOR_FIELDS: ReadonlyArray<{ key: 'background' | 'foreground' | 'accent'; label: DictKey }> = [
  { key: 'background', label: 'motion.style.background' },
  { key: 'foreground', label: 'motion.style.foreground' },
  { key: 'accent', label: 'motion.style.accent' },
];
const FONT_LABELS: Record<MovieStyle['font'], DictKey> = {
  sans: 'motion.style.fontSans',
  serif: 'motion.style.fontSerif',
  mono: 'motion.style.fontMono',
};
const MOTION_LABELS: Record<MovieStyle['motion'], DictKey> = {
  rise: 'motion.style.motionRise',
  slide: 'motion.style.motionSlide',
  scale: 'motion.style.motionScale',
};
const LAYER_LABELS: Record<string, DictKey> = {
  rect: 'motion.style.layer.rect',
  ellipse: 'motion.style.layer.ellipse',
  group: 'motion.style.layer.group',
  gear: 'motion.style.layer.gear',
  line: 'motion.style.layer.line',
  grid: 'motion.style.layer.grid',
  text: 'motion.style.layer.text',
  path: 'motion.style.layer.path',
  image: 'motion.style.layer.image',
};
const CUSTOM_COMPOSITION = 'custom';

/** One preset per composition (several built-in styles share a composition). */
function compositionPresets(): Array<{ composition: string; name: string; style: MovieStyle }> {
  const seen = new Set<string>();
  const presets: Array<{ composition: string; name: string; style: MovieStyle }> = [];
  for (const style of MOVIE_STYLES) {
    const composition = style.visual?.composition;
    if (!composition || composition === CUSTOM_COMPOSITION || seen.has(composition)) continue;
    seen.add(composition);
    presets.push({ composition, name: style.name, style });
  }
  return presets;
}

export function StyleFields({ value, onChange, disabled = false, className }: StyleFieldsProps) {
  const t = useT();
  const id = useId();
  const presets = useMemo(compositionPresets, []);
  const composition =
    value.visual?.composition ?? MOVIE_STYLES.find((style) => style.id === value.id)?.visual?.composition ?? 'poster';
  const selectedComposition = presets.some((preset) => preset.composition === composition) ? composition : CUSTOM_COMPOSITION;
  const layers = value.visual?.layers ?? [];

  return (
    <div className={cn(styles.fields, className)} data-testid="motion-style-fields">
      <label className={styles.field} htmlFor={`${id}-name`}>
        <span className={styles.label}>{t('motion.style.name')}</span>
        <Input
          id={`${id}-name`}
          inputSize="sm"
          value={value.name}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
      </label>
      <div className={styles.colors}>
        {COLOR_FIELDS.map(({ key, label }) => (
          <label key={key} className={styles.swatch}>
            <input
              type="color"
              className={styles.colorInput}
              aria-label={t(label)}
              value={value[key]}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, [key]: event.target.value })}
            />
            <span className={styles.swatchLabel}>{t(label)}</span>
          </label>
        ))}
      </div>
      <div className={styles.selects}>
        <div className={styles.field}>
          <span className={styles.label} id={`${id}-font`}>
            {t('motion.style.font')}
          </span>
          <Select
            value={value.font}
            disabled={disabled}
            onValueChange={(next) => onChange({ ...value, font: next as MovieStyle['font'], typeface: undefined })}
          >
            <SelectTrigger size="sm" aria-labelledby={`${id}-font`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(FONT_LABELS) as Array<MovieStyle['font']>).map((font) => (
                <SelectItem key={font} value={font}>
                  {t(FONT_LABELS[font])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className={styles.field}>
          <span className={styles.label} id={`${id}-motion`}>
            {t('motion.style.motion')}
          </span>
          <Select
            value={value.motion}
            disabled={disabled}
            onValueChange={(next) => onChange({ ...value, motion: next as MovieStyle['motion'] })}
          >
            <SelectTrigger size="sm" aria-labelledby={`${id}-motion`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(MOTION_LABELS) as Array<MovieStyle['motion']>).map((motion) => (
                <SelectItem key={motion} value={motion}>
                  {t(MOTION_LABELS[motion])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className={styles.field}>
          <span className={styles.label} id={`${id}-composition`}>
            {t('motion.style.composition')}
          </span>
          <Select
            value={selectedComposition}
            disabled={disabled}
            onValueChange={(next) => {
              const preset = presets.find((item) => item.composition === next);
              if (preset?.style.visual) onChange({ ...value, visual: structuredClone(preset.style.visual) });
            }}
          >
            <SelectTrigger size="sm" aria-labelledby={`${id}-composition`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {presets.map((preset) => (
                <SelectItem key={preset.composition} value={preset.composition}>
                  {preset.name}
                </SelectItem>
              ))}
              <SelectItem value={CUSTOM_COMPOSITION} disabled>
                {t('motion.style.customLayers')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <Disclosure label={t('motion.style.layers', { count: layers.length })} className={styles.layers}>
        <ul className={styles.layerList}>
          {layers.map((layer, index) => {
            const type = LAYER_LABELS[layer.type] ? t(LAYER_LABELS[layer.type]!) : layer.type;
            return (
              <li key={layer.id} className={styles.layerRow}>
                <span>{t('motion.style.layerRow', { type, n: index + 1 })}</span>
                <IconButton
                  variant="danger"
                  size="sm"
                  aria-label={t('motion.style.removeLayer', { n: index + 1 })}
                  disabled={disabled}
                  onClick={() =>
                    onChange({
                      ...value,
                      visual: {
                        ...value.visual!,
                        composition: CUSTOM_COMPOSITION,
                        layers: layers.filter((item) => item.id !== layer.id),
                      },
                    })
                  }
                >
                  <Icon icon={Trash2} size="sm" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      </Disclosure>
    </div>
  );
}
