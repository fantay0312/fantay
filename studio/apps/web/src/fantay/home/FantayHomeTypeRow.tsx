// SPDX-License-Identifier: AGPL-3.0-only
// The Home creation chips (spec 02 §8.2 with amendment C4). HomeHero imports this under the name TypePillRow
// (one import alias), so it receives the upstream props `{ chips, activeChipId, disabled, labelFor, onPick }`.
// Shell off → the upstream TypePillRow, untouched. Shell on → one wrapping row of Fantay chips in a fixed
// order — 网页/应用设计 · 图片 · 视频 · 代码动画 · 社媒设计 ▾ · 演示 · 文档 · 更多 ▾ — where every pick calls
// `onPick(chip)`, the same path as the upstream pill. 社媒设计 opens its platform sizes: picking one picks the
// chip and writes 画布尺寸：W×H（平台） into the brief.
import type { ComponentProps, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

import { findChip, type HomeHeroChip } from '../../components/home-hero/chips';
import { TypePillRow } from '../../components/home-hero/TypePillRow';
import { useT } from '../../i18n';
import { useFantayShellEnabled } from '../shell/flags';
import { Chip } from '../ui/chip';
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { FeatureIcon } from '../ui/feature-icon';
import { Icon } from '../ui/icons';
import { FANTAY_CREATION_CHIPS, FANTAY_INLINE_CHIP_IDS, moreChipIcon } from './creation-chips';
import { applySocialBriefSize } from './home-composer-brief';
import { SOCIAL_PLATFORM_PRESETS } from './social-presets';

export type FantayHomeTypeRowProps = ComponentProps<typeof TypePillRow>;

export function FantayHomeTypeRow(props: FantayHomeTypeRowProps) {
  const enabled = useFantayShellEnabled();
  if (!enabled) return <TypePillRow {...props} />;
  return <FantayCreationChips {...props} />;
}

function FantayCreationChips({ chips, activeChipId, disabled = false, labelFor, onPick }: FantayHomeTypeRowProps) {
  const t = useT();
  const resolve = (chipId: string): HomeHeroChip | undefined => chips.find((chip) => chip.id === chipId) ?? findChip(chipId);
  const moreChips = chips.filter((chip) => !FANTAY_INLINE_CHIP_IDS.has(chip.id));

  return (
    <div className="fx flex flex-wrap justify-center gap-2" role="group" aria-label={t('fantayHome.chips')} data-testid="fantay-home-type-row">
      {FANTAY_CREATION_CHIPS.map((def) => {
        const chip = resolve(def.chipId);
        if (!chip) return null;
        const icon = <FeatureIcon name={def.id} size={20} slot={16} />;
        const label = t(def.labelKey);
        if (def.id === 'social') {
          return (
            <SocialChip
              key={def.id}
              chip={chip}
              icon={icon}
              label={label}
              on={activeChipId === chip.id}
              disabled={disabled}
              onPick={onPick}
            />
          );
        }
        return (
          <Chip
            key={def.id}
            icon={icon}
            on={activeChipId === chip.id}
            disabled={disabled}
            data-testid={`fantay-home-chip-${chip.id}`}
            onClick={() => onPick(chip)}
          >
            {label}
          </Chip>
        );
      })}
      {moreChips.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <Chip disabled={disabled} data-testid="fantay-home-chip-more">
              {t('fantayHome.chip.more')}
              <Icon icon={ChevronDown} size={13} className="-me-0.5 text-ink-faint" />
            </Chip>
          </DropdownMenuTrigger>
          <DropdownMenuContent width="md" align="center" data-testid="fantay-home-chip-more-menu">
            {moreChips.map((chip) => (
              <DropdownMenuItem
                key={chip.id}
                icon={<Icon icon={moreChipIcon(chip.id)} size={14} />}
                data-testid={`fantay-home-more-${chip.id}`}
                onSelect={() => onPick(chip)}
              >
                {labelFor(chip.id)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

interface SocialChipProps {
  chip: HomeHeroChip;
  icon: ReactNode;
  label: string;
  on: boolean;
  disabled: boolean;
  onPick(chip: HomeHeroChip): void;
}

function SocialChip({ chip, icon, label, on, disabled, onPick }: SocialChipProps) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Chip icon={icon} on={on} disabled={disabled} data-testid={`fantay-home-chip-${chip.id}`}>
          {label}
          <Icon icon={ChevronDown} size={13} className="-me-0.5 text-ink-faint" />
        </Chip>
      </DropdownMenuTrigger>
      <DropdownMenuContent width="lg" align="center" data-testid="fantay-home-social-menu">
        <DropdownMenuCaption>{t('fantayHome.social.platformSize')}</DropdownMenuCaption>
        {SOCIAL_PLATFORM_PRESETS.map((preset) => (
          <DropdownMenuItem
            key={preset.id}
            description={`${preset.width}×${preset.height}`}
            data-testid={`fantay-home-social-${preset.id}`}
            onSelect={() => {
              onPick(chip);
              void applySocialBriefSize(t, preset).catch(() => undefined);
            }}
          >
            {t(preset.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
