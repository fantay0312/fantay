'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// "Connect to a new…" (spec 03 §3.8, §6.6; amendment C8): when a connector drag ends on empty canvas the stage sets
// `ui.connectMenu`; this menu opens at the drop point and creates an image or video generator there, connected
// from the dragged node (`extensions.createGenerator({ connectFrom })`). Without the generation extension the rows
// stay, disabled with "not available yet". Row visuals after infinite-canvas canvas-create-menus.tsx (no code).
import { useT } from '../../../i18n';
import {
  DropdownMenu,
  DropdownMenuCaption,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { useBoardEngine, useBoardHost, useBoardSelector } from '../context';
import { CHROME_ICON_STROKE, ICONS } from './icons';
import styles from './chrome.module.css';

const SURFACES = [
  { surface: 'image' as const, icon: ICONS.generator, titleKey: 'board.insert.imageGenerator' as const },
  { surface: 'video' as const, icon: ICONS.videoGenerator, titleKey: 'board.insert.videoGenerator' as const },
];

export function ConnectionCreateMenu() {
  const t = useT();
  const engine = useBoardEngine();
  const { extensions } = useBoardHost();
  const request = useBoardSelector((state) => state.ui.connectMenu);
  if (!request) return null;
  const close = () => {
    if (engine.store.getState().ui.connectMenu) engine.store.setUi({ connectMenu: null });
  };
  const create = extensions?.createGenerator;
  return (
    <DropdownMenu open modal={false} onOpenChange={(open) => (open ? undefined : close())}>
      <DropdownMenuTrigger asChild>
        <span className={styles.menuAnchor} style={{ left: request.client.x, top: request.client.y }} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        sideOffset={4}
        width="md"
        data-testid="board-connect-menu"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DropdownMenuCaption>{t('board.connect.menuTitle')}</DropdownMenuCaption>
        {SURFACES.map((entry) => {
          const Glyph = entry.icon;
          return (
            <DropdownMenuItem
              key={entry.surface}
              data-testid={`board-connect-${entry.surface}`}
              className={styles.insertRow}
              disabled={!create}
              icon={
                <span className={styles.insertIcon} aria-hidden>
                  <Glyph size={16} strokeWidth={CHROME_ICON_STROKE} />
                </span>
              }
              {...(create ? {} : { description: t('board.insert.unavailable') })}
              onSelect={() => {
                const id = create?.({ selectedIds: [], at: request.world, surface: entry.surface, connectFrom: request.from });
                close();
                if (id) engine.commands.select([id]);
              }}
            >
              {t(entry.titleKey)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
