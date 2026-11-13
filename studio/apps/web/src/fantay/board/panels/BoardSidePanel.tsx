'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// The panel docked beside the canvas: 参考 (this project) and 我的素材 (the user's, across projects). It pushes the
// stage instead of covering it, and stays mounted so the width transition plays both ways and its lists survive.
import { X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useT } from '../../../i18n';
import { cn } from '../../ui/cn';
import { IconButton } from '../../ui/icon-button';
import { useBoardEngine, useBoardSelector } from '../context';
import { CHROME_ICON_STROKE } from '../chrome/icons';
import { AssetsPanel } from './AssetsPanel';
import { ReferencesPanel } from './ReferencesPanel';
import styles from './panels.module.css';

export function BoardSidePanel({ readOnly }: { readOnly: boolean }) {
  const engine = useBoardEngine();
  const t = useT();
  const panel = useBoardSelector((state) => state.ui.sidePanel);
  const [visited, setVisited] = useState({ references: false, assets: false });

  useEffect(() => {
    if (panel) setVisited((current) => (current[panel] ? current : { ...current, [panel]: true }));
  }, [panel]);

  return (
    <aside
      className={cn('fx', styles.dock)}
      data-state={panel ? 'open' : 'closed'}
      aria-hidden={panel ? undefined : true}
      aria-label={t(panel === 'assets' ? 'board.panel.assets' : 'board.panel.references')}
      data-testid="board-side-panel"
    >
      <div className={styles.panel}>
        <div className={styles.view} hidden={panel !== 'references'}>
          {visited.references ? <ReferencesPanel readOnly={readOnly} /> : null}
        </div>
        <div className={styles.view} hidden={panel !== 'assets'}>
          {visited.assets ? <AssetsPanel readOnly={readOnly} /> : null}
        </div>
        <IconButton
          className={styles.close}
          size="sm"
          aria-label={t('board.panel.close')}
          tabIndex={panel ? 0 : -1}
          onClick={() => engine.store.setUi({ sidePanel: null })}
        >
          <X strokeWidth={CHROME_ICON_STROKE} />
        </IconButton>
      </div>
    </aside>
  );
}
