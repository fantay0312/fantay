// SPDX-License-Identifier: AGPL-3.0-only
// A themed island (Soul UI spec §8.4): the appearance preview and swatch hosts. It carries the same data attributes as
// the companion chat column, so everything inside resolves the chosen `--pa-skin-*` theme on its own paper.
import type { ReactNode } from 'react';
import type { PaResolvedAppearance } from '@open-design/contracts';

import { cn } from '../../ui';
import { soulThemeAttrs, soulThemeStyle } from './soul-theme';
import styles from './SoulThemeScope.module.css';

export interface SoulThemeScopeProps {
  appearance: PaResolvedAppearance;
  className?: string;
  children: ReactNode;
  'data-testid'?: string;
}

export function SoulThemeScope({ appearance, className, children, 'data-testid': testId }: SoulThemeScopeProps) {
  return (
    <div
      {...soulThemeAttrs(appearance)}
      data-testid={testId}
      className={cn(styles.scope, styles.paper, className)}
      style={soulThemeStyle(appearance)}
    >
      {children}
    </div>
  );
}
