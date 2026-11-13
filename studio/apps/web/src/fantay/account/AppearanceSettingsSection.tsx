// SPDX-License-Identifier: AGPL-3.0-only
// Settings ▸ 通用 ▸ 外观 (spec 07 §8, spec 02 R18): the theme block on the General page.
import { useT } from '../../i18n';
import { useTheme, type ThemePreference } from '../theme/theme';
import { cn, FX } from '../ui';
import { Segmented, SegmentedItem } from '../ui/segmented';
import styles from './AppearanceSettingsSection.module.css';

type TranslateFn = ReturnType<typeof useT>;

const PREVIEW_MODES: readonly ThemePreference[] = ['light', 'dark'];

function isPreference(value: string): value is ThemePreference {
  return (PREVIEW_MODES as readonly string[]).includes(value);
}

export function fantayAppearanceHeader(t: TranslateFn): { title: string; subtitle: string } {
  return {
    title: t('fantay.theme.label'),
    subtitle: t('fantay.theme.settingHint'),
  };
}

/* tokens.css keys each theme on the attribute alone, so data-theme re-resolves every token for this
   subtree: the tile draws the real palette of its theme, whichever theme the app is in. */
function PreviewWindow({ tone }: { tone: 'light' | 'dark' }) {
  return (
    <span className={styles.window} data-theme={tone}>
      <span className={styles.sidebar}>
        <span className={styles.barStrong} />
        <span className={styles.bar} />
        <span className={styles.bar} />
      </span>
      <span className={styles.main}>
        <span className={styles.barStrong} />
        <span className={styles.bar} />
        <span className={styles.composer}>
          <span className={styles.send} />
        </span>
      </span>
    </span>
  );
}

export function AppearanceSettingsSection() {
  const t = useT();
  const { preference, setPreference } = useTheme();

  const modeLabel = (mode: ThemePreference): string => {
    switch (mode) {
      case 'light':
        return t('fantay.theme.light');
      case 'dark':
        return t('fantay.theme.dark');
    }
  };

  return (
    <section
      className={cn(FX, 'settings-general-block')}
      data-testid="settings-appearance"
      aria-label={t('fantay.theme.label')}
    >
      <div className="settings-general-block-head">
        <h3>{t('fantay.theme.label')}</h3>
      </div>
      {/* Segmented for the radio behaviour only. Renaming the slots keeps these tiles out of the rule that
          makes every Segmented in Settings a 32px trough. */}
      <Segmented
        data-slot="theme-tiles"
        aria-label={t('fantay.theme.label')}
        value={preference}
        onValueChange={(next) => {
          if (isPreference(next) && next !== preference) setPreference(next);
        }}
        className={styles.options}
      >
        {PREVIEW_MODES.map((mode) => (
          <SegmentedItem key={mode} data-slot="theme-tile" value={mode} className={styles.option}>
            <span className={styles.frame} aria-hidden="true">
              <PreviewWindow tone={mode} />
            </span>
            <span className={styles.label}>{modeLabel(mode)}</span>
          </SegmentedItem>
        ))}
      </Segmented>
    </section>
  );
}
