// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-node-prompt-panel.tsx
// (the round send / stop button).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-31 (spec 05 §5.7): the panel's single filled control, with the chat composer's send disc
// in every state; disabled keeps the reason as a tooltip; preparing shows a spinner; running stops *waiting* (the provider
// may still finish and bill, said in its tooltip). The count stays in the params summary and the accessible name.
import { Square } from 'lucide-react';

import { Icon } from '../../../components/Icon';
import { useT } from '../../../i18n';
import { IconButton, Spinner } from '../../ui';
import { BOARD_CONTROL_PROPS } from './board-interactive';
import styles from './GeneratorPanel.module.css';

export type RunButtonState = 'idle' | 'preparing' | 'running';

export interface RunButtonProps {
  state: RunButtonState;
  count: number;
  disabledReason?: string | null;
  onRun(): void;
  onStop(): void;
}

export function RunButton({ state, count, disabledReason, onRun, onStop }: RunButtonProps) {
  const t = useT();
  if (state === 'running') {
    return (
      <IconButton
        size="md"
        shape="round"
        variant="brand"
        className={styles.run}
        aria-label={t('fantay.gen.run.stop')}
        tooltip={t('fantay.gen.run.stopHint')}
        data-testid="fx-gen-stop"
        {...BOARD_CONTROL_PROPS}
        onClick={() => onStop()}
      >
        <Square className={styles.stopGlyph} fill="currentColor" strokeWidth={0} aria-hidden />
      </IconButton>
    );
  }
  if (state === 'preparing') {
    return (
      <IconButton
        size="md"
        shape="round"
        variant="brand"
        className={styles.run}
        aria-label={t('fantay.gen.run.preparing')}
        data-testid="fx-gen-run"
        data-state="preparing"
        disabled
        aria-busy
        {...BOARD_CONTROL_PROPS}
      >
        <Spinner size="sm" />
      </IconButton>
    );
  }
  const label = count > 1 ? t('fantay.gen.run.generateCount', { n: count }) : t('fantay.gen.run.generate');
  return (
    <IconButton
      size="md"
      shape="round"
      variant="brand"
      className={styles.run}
      aria-label={label}
      shortcut={disabledReason ? undefined : 'mod+enter'}
      data-testid="fx-gen-run"
      data-state="idle"
      disabled={Boolean(disabledReason)}
      disabledReason={disabledReason || undefined}
      {...BOARD_CONTROL_PROPS}
      onClick={() => onRun()}
    >
      {/* The chat's send mark: it fills half of its own box, so it renders at the disc's full size. */}
      <Icon name="arrow-up-fill" size={32} className="size-8" />
    </IconButton>
  );
}
