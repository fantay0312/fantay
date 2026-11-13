'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// The "+" insert menu (spec 03 §6.2, plan §3.2, amendment C8): project files, materials, upload, a design document,
// a web preview, animation / video edit and the image or video generator. Entries whose extension is absent stay in
// the menu, disabled, with "not available yet" as their sub-line (a disabled menu row cannot show a tooltip). Row
// recipe (icon tile, title, one-line description) after infinite-canvas canvas-create-menus.tsx (visuals only). The
// same rows fill the background context menu's Insert ▸ sub-menu, placed at the pressed point.
import { Fragment } from 'react';
import type { LucideIcon } from 'lucide-react';

import { useT } from '../../../i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { useBoardHost } from '../context';
import type { BoardExtensions } from '../extensions';
import { UPLOAD_FILES_ACCEPT } from '../interaction/drop';
import type { DictKey, Point } from '../model/types';
import { useChromeActions, type ChromeActions } from './chrome-context';
import { ToolButton } from './ToolButton';
import { CHROME_ICON_STROKE, ICONS } from './icons';
import styles from './chrome.module.css';

export interface InsertEntry {
  id: string;
  icon: LucideIcon;
  titleKey: DictKey;
  descriptionKey?: DictKey;
  /** absent: the extension behind the entry is not available */
  run?: () => void;
}

/** The insert rows in their groups; `at` places uploads and generators (default: the stage centre). */
export function insertGroups(actions: ChromeActions, extensions: BoardExtensions | undefined, at?: Point): InsertEntry[][] {
  return [
    [
      { id: 'project-files', icon: ICONS.projectFiles, titleKey: 'board.insert.projectFiles', descriptionKey: 'board.insert.projectFilesDesc', run: () => actions.openFilesPicker() },
      {
        id: 'materials',
        icon: ICONS.materials,
        titleKey: 'board.insert.materials',
        descriptionKey: 'board.insert.materialsDesc',
        ...(extensions?.openMaterialsPicker ? { run: () => extensions.openMaterialsPicker?.() } : {}),
      },
      {
        id: 'upload',
        icon: ICONS.uploadFiles,
        titleKey: 'board.insert.upload',
        descriptionKey: 'board.insert.uploadDesc',
        run: () => actions.openUpload(UPLOAD_FILES_ACCEPT, at),
      },
    ],
    [
      {
        id: 'design-doc',
        icon: ICONS.design,
        titleKey: 'board.insert.designDoc',
        descriptionKey: 'board.insert.designDocDesc',
        ...(extensions?.createDesignDocument ? { run: () => extensions.createDesignDocument?.() } : {}),
      },
      { id: 'web', icon: ICONS.web, titleKey: 'board.insert.web', descriptionKey: 'board.insert.webDesc', run: () => actions.openUrlDialog() },
    ],
    [
      {
        id: 'animation',
        icon: ICONS.animation,
        titleKey: 'board.insert.animation',
        descriptionKey: 'board.insert.animationDesc',
        ...(extensions?.createMotion ? { run: () => extensions.createMotion?.('animation') } : {}),
      },
      {
        id: 'video-edit',
        icon: ICONS.videoEdit,
        titleKey: 'board.insert.videoEdit',
        descriptionKey: 'board.insert.videoEditDesc',
        ...(extensions?.createMotion ? { run: () => extensions.createMotion?.('video-edit') } : {}),
      },
    ],
    [
      {
        id: 'image-generator',
        icon: ICONS.generator,
        titleKey: 'board.insert.imageGenerator',
        ...(extensions?.createGenerator ? { run: () => actions.insertGenerator('image', at) } : {}),
      },
      {
        id: 'video-generator',
        icon: ICONS.videoGenerator,
        titleKey: 'board.insert.videoGenerator',
        ...(extensions?.createGenerator ? { run: () => actions.insertGenerator('video', at) } : {}),
      },
    ],
  ];
}

/** The insert rows as menu items (inside a DropdownMenuContent or a sub-menu). */
export function InsertMenuItems({ at, testIdPrefix = 'board-insert' }: { at?: Point; testIdPrefix?: string }) {
  const t = useT();
  const { extensions } = useBoardHost();
  const actions = useChromeActions();
  const groups = insertGroups(actions, extensions, at);
  return (
    <>
      {groups.map((group, index) => (
        <Fragment key={group[0]!.id}>
          {index > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuGroup>
            {group.map((entry) => {
              const available = entry.run !== undefined;
              const Glyph = entry.icon;
              return (
                <DropdownMenuItem
                  key={entry.id}
                  data-testid={`${testIdPrefix}-${entry.id}`}
                  disabled={!available}
                  className={styles.insertRow}
                  icon={
                    <span className={styles.insertIcon} aria-hidden>
                      <Glyph size={16} strokeWidth={CHROME_ICON_STROKE} />
                    </span>
                  }
                  description={available ? (entry.descriptionKey ? t(entry.descriptionKey) : undefined) : t('board.insert.unavailable')}
                  onSelect={() => entry.run?.()}
                >
                  {t(entry.titleKey)}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>
        </Fragment>
      ))}
    </>
  );
}

export function InsertMenu() {
  const t = useT();
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <ToolButton data-testid="board-tool-insert" label={t('board.tool.insert')}>
          <ICONS.insert strokeWidth={CHROME_ICON_STROKE} />
        </ToolButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="center" sideOffset={10} className="w-[min(288px,calc(100vw-24px))]" data-testid="board-insert-menu">
        <InsertMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
