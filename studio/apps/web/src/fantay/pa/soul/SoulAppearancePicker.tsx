// SPDX-License-Identifier: AGPL-3.0-only
// The chat appearance controls and their live preview (Soul UI spec 7.6, stage 2 spec 9.3): theme, bubble shape,
// font, size, layout, paper pattern, portrait frame, accent colour, pacing and — when the caller passes `stage` — the
// standing picture. `value` is the layer being edited and `base` the layer under it; the controls and the preview
// show the two resolved together. Every write keeps the layer's other keys; choosing a theme drops `font`, `pattern`
// and `avatarFrame` so that theme's own defaults show. A custom accent is stored as picked and drawn through the
// engine's `guardAccent`; the line under it says whether it was used as picked or adjusted, per mode.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { PaChatAppearance, PaChatTheme } from '@open-design/contracts/soul';
import { PA_CHAT_THEMES, PA_THEME_SURFACES, guardAccent, resolveAppearance } from '@open-design/contracts/soul';

import { useI18n, useT } from '../../../i18n';
import { Button, Input, Label, Segmented, SegmentedItem } from '../../ui';
import { PaSwitchRow } from '../PaAgentModal';
import modalStyles from '../PaModals.module.css';
import { SOUL_ACCENT_SEED, SOUL_ACCENT_SWATCHES, soulAccentFromDraft } from './soul-look';
import { soulThemeName } from './soul-theme';
import { SoulPortrait } from './SoulPortrait';
import { SoulPreviewChat, SoulThemeSwatch } from './SoulPrimitives';
import { SoulThemeScope } from './SoulThemeScope';
import styles from './SoulAppearancePicker.module.css';

const SHAPES = ['round', 'soft', 'square'] as const;
const FONTS = ['ui', 'serif', 'kai', 'mono'] as const;
const SCALES = ['sm', 'md', 'lg'] as const;
const LAYOUTS = ['bubble', 'journal'] as const;
const PATTERNS = ['none', 'grid', 'ruled', 'dots'] as const;
const FRAMES = ['circle', 'squircle', 'polaroid'] as const;
const ACCENT_MODES = ['theme', 'custom'] as const;

/** The preview's sample time, 21:06 like its date line, in the locale's 24-hour clock. */
function sampleTime(locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(2026, 0, 1, 21, 6));
  } catch {
    return '21:06';
  }
}

export interface SoulAppearancePickerProps {
  value: PaChatAppearance;
  base: PaChatAppearance | null;
  onChange(next: PaChatAppearance): void;
  portrait: { src: string | null; name: string };
  /** The 立绘 switch. Omitted: the row is not rendered (the profile editor omits it). */
  stage?: { available: boolean; reason?: 'no-sprites' | 'room'; onAdd?(): void };
}

/** One labelled option row: a full-width Segmented of equal items. */
function LookOption<T extends string>(p: {
  label: string;
  items: readonly T[];
  value: T;
  onChange(next: T): void;
  itemLabel(item: T): string;
  testId: string;
}) {
  return (
    <div>
      <Label variant="form" className={styles.label}>
        {p.label}
      </Label>
      <Segmented
        size="md"
        className="flex w-full"
        aria-label={p.label}
        value={p.value}
        onValueChange={(next) => p.onChange(next as T)}
        data-testid={p.testId}
      >
        {p.items.map((item) => (
          <SegmentedItem key={item} value={item} className="min-w-0 flex-1">
            {p.itemLabel(item)}
          </SegmentedItem>
        ))}
      </Segmented>
    </div>
  );
}

/** A colour dot set through `--pa-dot` on the paper of the mode it was fitted for. */
function accentDot(colour: string, ground: string): CSSProperties {
  return { '--pa-dot': colour, '--pa-dot-ground': ground } as CSSProperties;
}

/** A new theme on the layer: the theme's own font, pattern and frame show again. */
export function withTheme(layer: PaChatAppearance, theme: PaChatTheme): PaChatAppearance {
  const { font: _font, pattern: _pattern, avatarFrame: _frame, ...rest } = layer;
  return { ...rest, theme };
}

export function SoulAppearancePicker({ value, base, onChange, portrait, stage }: SoulAppearancePickerProps) {
  const t = useT();
  const { locale } = useI18n();
  const lang = locale.startsWith('zh') ? 'zh' : 'en';
  const resolved = resolveAppearance(base, value);

  // 强调色: the last custom colour of this open picker (跟随主题 → 自选 returns to it) and the hex field's draft, which
  // follows the stored colour unless it already spells that colour.
  const accent = resolved.accent;
  const [lastCustom, setLastCustom] = useState<string | null>(accent);
  const [draft, setDraft] = useState(accent ?? '');
  useEffect(() => {
    if (accent === null) return;
    setLastCustom(accent);
    setDraft((current) => (soulAccentFromDraft(current) === accent ? current : accent));
  }, [accent]);
  const writeAccent = (next: string) => onChange({ ...value, accent: next });
  const draftInvalid = accent !== null && soulAccentFromDraft(draft) === null;
  const guard = guardAccent(resolved.theme, accent);
  const surfaces = PA_THEME_SURFACES[resolved.theme] ?? PA_THEME_SURFACES.fantay;

  let accentNote: ReactNode = null;
  if (draftInvalid) accentNote = t('pa.soul.manage.look.accentInvalid');
  else if (guard?.ok && !guard.adjusted) accentNote = t('pa.soul.manage.look.accentOk');
  else if (guard?.ok)
    accentNote = (
      <>
        {!guard.light.adjusted
          ? t('pa.soul.manage.look.accentAdjustedDark', { dark: guard.dark.accent })
          : !guard.dark.adjusted
            ? t('pa.soul.manage.look.accentAdjustedLight', { light: guard.light.accent })
            : t('pa.soul.manage.look.accentAdjusted', { light: guard.light.accent, dark: guard.dark.accent })}
        <span className={styles.dots} aria-hidden="true">
          <span className={styles.dot} data-mode="light" style={accentDot(guard.light.accent, surfaces.light.paper)} />
          <span className={styles.dot} data-mode="dark" style={accentDot(guard.dark.accent, surfaces.dark.paper)} />
        </span>
      </>
    );
  else if (guard && guard.reason === 'invalid') accentNote = t('pa.soul.manage.look.accentInvalid');

  let stageHint: ReactNode = null;
  if (stage?.available) stageHint = t('pa.soul.manage.look.stageHint', { name: portrait.name });
  else if (stage?.reason === 'room') stageHint = t('pa.soul.manage.look.stageRoom');
  else if (stage)
    stageHint = (
      <>
        {t('pa.soul.manage.look.stageNoSprites')}
        {stage.onAdd ? (
          <Button variant="link" size="sm" className={styles.hintLink} onClick={stage.onAdd} data-testid="pa-look-stage-add">
            {t('pa.soul.manage.look.stageAdd')}
          </Button>
        ) : null}
      </>
    );

  return (
    <div className={styles.root} data-testid="pa-appearance-picker">
      <div className={styles.layout}>
        <div className={styles.form}>
          <div>
            <Label variant="form" className={styles.label}>
              {t('pa.soul.manage.look.theme')}
            </Label>
            <div className={styles.themes} role="group" aria-label={t('pa.soul.manage.look.theme')}>
              {PA_CHAT_THEMES.map((theme) => (
                <Button
                  key={theme}
                  variant="bare"
                  className={styles.themeCell}
                  aria-pressed={resolved.theme === theme}
                  data-testid="pa-theme-swatch"
                  data-theme={theme}
                  onClick={() => onChange(withTheme(value, theme))}
                >
                  <span className={styles.ring}>
                    <SoulThemeSwatch theme={theme} />
                  </span>
                  <span className={styles.themeName}>{soulThemeName(theme, lang)}</span>
                </Button>
              ))}
            </div>
          </div>

          <div>
            <Label variant="form" className={styles.label}>
              {t('pa.soul.manage.look.shape')}
            </Label>
            <Segmented
              size="md"
              className="flex w-full"
              aria-label={t('pa.soul.manage.look.shape')}
              value={resolved.shape}
              onValueChange={(shape) => onChange({ ...value, shape: shape as (typeof SHAPES)[number] })}
            >
              {SHAPES.map((shape) => (
                <SegmentedItem key={shape} value={shape} className="min-w-0 flex-1">
                  {t(`pa.soul.manage.look.shape.${shape}`)}
                </SegmentedItem>
              ))}
            </Segmented>
          </div>

          <div>
            <Label variant="form" className={styles.label}>
              {t('pa.soul.manage.look.font')}
            </Label>
            <Segmented
              size="md"
              className="flex w-full"
              aria-label={t('pa.soul.manage.look.font')}
              value={resolved.font}
              onValueChange={(font) => onChange({ ...value, font: font as (typeof FONTS)[number] })}
            >
              {FONTS.map((font) => (
                <SegmentedItem key={font} value={font} className="min-w-0 flex-1">
                  {t(`pa.soul.manage.look.font.${font}`)}
                </SegmentedItem>
              ))}
            </Segmented>
          </div>

          <div>
            <Label variant="form" className={styles.label}>
              {t('pa.soul.manage.look.scale')}
            </Label>
            <Segmented
              size="md"
              className="flex w-full"
              aria-label={t('pa.soul.manage.look.scale')}
              value={resolved.scale}
              onValueChange={(scale) => onChange({ ...value, scale: scale as (typeof SCALES)[number] })}
            >
              {SCALES.map((scale) => (
                <SegmentedItem key={scale} value={scale} className="min-w-0 flex-1">
                  {t(`pa.soul.manage.look.scale.${scale}`)}
                </SegmentedItem>
              ))}
            </Segmented>
          </div>

          <LookOption
            label={t('pa.soul.manage.look.layout')}
            items={LAYOUTS}
            value={resolved.layout}
            onChange={(layout) => onChange({ ...value, layout })}
            itemLabel={(item) => t(`pa.soul.manage.look.layout.${item}`)}
            testId="pa-look-layout"
          />

          <LookOption
            label={t('pa.soul.manage.look.pattern')}
            items={PATTERNS}
            value={resolved.pattern}
            onChange={(pattern) => onChange({ ...value, pattern })}
            itemLabel={(item) => t(`pa.soul.manage.look.pattern.${item}`)}
            testId="pa-look-pattern"
          />

          <LookOption
            label={t('pa.soul.manage.look.frame')}
            items={FRAMES}
            value={resolved.avatarFrame}
            onChange={(avatarFrame) => onChange({ ...value, avatarFrame })}
            itemLabel={(item) => t(`pa.soul.manage.look.frame.${item}`)}
            testId="pa-look-frame"
          />

          <div>
            <LookOption
              label={t('pa.soul.manage.look.accent')}
              items={ACCENT_MODES}
              value={accent === null ? 'theme' : 'custom'}
              onChange={(mode) => onChange({ ...value, accent: mode === 'custom' ? (lastCustom ?? SOUL_ACCENT_SEED) : null })}
              itemLabel={(item) => t(`pa.soul.manage.look.accent.${item}`)}
              testId="pa-look-accent-mode"
            />
            {accent !== null ? (
              <>
                <div className={styles.accentRow}>
                  <div className={styles.swatches} role="group" aria-label={t('pa.soul.manage.look.accent')}>
                    {SOUL_ACCENT_SWATCHES.map((swatch) => (
                      <Button
                        key={swatch}
                        variant="bare"
                        className={styles.swatch}
                        style={{ '--pa-swatch': swatch } as CSSProperties}
                        aria-label={`${t('pa.soul.manage.look.accentHex')} ${swatch}`}
                        aria-pressed={accent === swatch}
                        data-testid="pa-look-accent-swatch"
                        onClick={() => writeAccent(swatch)}
                      />
                    ))}
                  </div>
                  <input
                    type="color"
                    className={styles.well}
                    value={accent}
                    aria-label={t('pa.soul.manage.look.accentPick')}
                    data-testid="pa-look-accent-color"
                    onChange={(event) => {
                      const next = soulAccentFromDraft(event.target.value);
                      if (next) writeAccent(next);
                    }}
                  />
                  <Input
                    variant="mono"
                    inputSize="sm"
                    className={styles.hex}
                    value={draft}
                    maxLength={7}
                    spellCheck={false}
                    autoComplete="off"
                    aria-label={t('pa.soul.manage.look.accentHex')}
                    aria-invalid={draftInvalid || undefined}
                    data-testid="pa-look-accent-hex"
                    onChange={(event) => {
                      setDraft(event.target.value);
                      const next = soulAccentFromDraft(event.target.value);
                      if (next && next !== accent) writeAccent(next);
                    }}
                  />
                </div>
                <p
                  className={styles.accentNote}
                  role="status"
                  data-invalid={draftInvalid ? '' : undefined}
                  data-testid="pa-look-accent-note"
                >
                  {accentNote}
                </p>
              </>
            ) : null}
          </div>

          <div className={modalStyles.group}>
            <PaSwitchRow
              label={t('pa.soul.manage.look.pacing')}
              hint={t('pa.soul.manage.look.pacingHint')}
              checked={resolved.pacing === 'paced'}
              onChange={(on) => onChange({ ...value, pacing: on ? 'paced' : 'instant' })}
            />
            {stage ? (
              <div data-testid="pa-look-stage" data-available={stage.available ? '' : undefined}>
                <PaSwitchRow
                  label={t('pa.soul.manage.look.stage')}
                  hint={stageHint}
                  checked={resolved.stage === 'side'}
                  disabled={!stage.available}
                  onChange={(on) => onChange({ ...value, stage: on ? 'side' : 'off' })}
                />
              </div>
            ) : null}
          </div>
        </div>

        <div className={styles.previewCol}>
          <Label variant="form" className={styles.label}>
            {t('pa.soul.manage.look.preview')}
          </Label>
          <SoulThemeScope appearance={resolved} className={styles.preview} data-testid="pa-appearance-preview">
            <SoulPreviewChat
              portrait={
                <SoulPortrait
                  src={portrait.src}
                  name={portrait.name}
                  size={resolved.layout === 'journal' ? 36 : 28}
                  frame="scope"
                  theme={resolved.theme}
                />
              }
              labels={{
                // The journal's head line (name · HH:mm, as the transcript writes it); the bubble layout hides it.
                name: portrait.name,
                time: sampleTime(locale),
                date: t('pa.soul.manage.look.sample.date'),
                incoming: t('pa.soul.manage.look.sample.in'),
                narration: t('pa.soul.manage.look.sample.narration'),
                outgoing: t('pa.soul.manage.look.sample.out'),
                rollCaption: t('pa.soul.manage.look.sample.rollCaption'),
                rollLabel: t('pa.soul.manage.look.sample.rollLabel'),
                delta: t('pa.soul.manage.look.sample.delta'),
              }}
            />
          </SoulThemeScope>
        </div>
      </div>
    </div>
  );
}
