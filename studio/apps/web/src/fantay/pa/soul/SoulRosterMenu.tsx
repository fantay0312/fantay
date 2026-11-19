// SPDX-License-Identifier: AGPL-3.0-only
// The roster's ＋ menu (Soul UI spec §3.3): new character, import a card, new group chat, then the starters shelf.
// The trigger is the caller's (the full roster's IconButton, or the rail's), passed as `children`.
import type { ReactNode } from 'react';
import { FileUp, Sparkles, UserRoundPlus, UsersRound } from 'lucide-react';

import { useT } from '../../../i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Icon } from '../../ui';
import { usePa } from '../pa-context';

export interface SoulRosterMenuProps {
  /** `right` for the 64 px rail, where the menu opens beside the button. */
  side?: 'bottom' | 'right';
  children: ReactNode;
}

export function SoulRosterMenu({ side = 'bottom', children }: SoulRosterMenuProps) {
  const t = useT();
  const { nav, index } = usePa();
  // Enterprise mode: a member who cannot manage the library has nothing to create here but can browse it.
  if (!index.canManageLibrary) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent width="md" side={side} align={side === 'right' ? 'start' : 'end'} data-testid="pa-roster-plus-menu">
          <DropdownMenuItem
            icon={<Icon icon={Sparkles} size="sm" />}
            onSelect={() => nav.openPlace('library', { libraryTab: 'characters' })}
          >
            {t('pa.soul.library.title')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent width="md" side={side} align={side === 'right' ? 'start' : 'end'} data-testid="pa-roster-plus-menu">
        <DropdownMenuItem icon={<Icon icon={UserRoundPlus} size="sm" />} onSelect={() => nav.openModal({ kind: 'agent', agentId: null })}>
          {t('pa.soul.shell.plus.newCharacter')}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Icon icon={FileUp} size="sm" />} onSelect={() => nav.openModal({ kind: 'cardImport' })}>
          {t('pa.soul.shell.plus.importCard')}
        </DropdownMenuItem>
        <DropdownMenuItem icon={<Icon icon={UsersRound} size="sm" />} onSelect={() => nav.openModal({ kind: 'group', groupId: null })}>
          {t('pa.soul.shell.plus.newGroup')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          icon={<Icon icon={Sparkles} size="sm" />}
          onSelect={() => nav.openPlace('library', { libraryTab: 'characters' })}
        >
          {t('pa.soul.shell.plus.starters')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
