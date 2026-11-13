// SPDX-License-Identifier: AGPL-3.0-only
// The first row of Home's composer while a sidebar folder's new-project button has set a target: says which group
// the project will go to, and takes the target back.
import { FolderOpen, X } from 'lucide-react';

import { useT } from '../../i18n';
import { setNewProjectGroup, useProjectOrganization } from '../shell/project-organization-store';
import { IconButton } from '../ui/icon-button';
import { Icon } from '../ui/icons';

export function FantayHomeGroupTarget() {
  const t = useT();
  const { groups, newProjectGroupId } = useProjectOrganization();
  const group = groups.find(({ id }) => id === newProjectGroupId);
  if (!group) return null;
  return (
    <div className="fx flex items-center gap-1.5 px-4 pt-3 text-label text-ink-soft" data-testid="fantay-home-group-target">
      <Icon icon={FolderOpen} size={14} className="flex-none text-ink-faint" />
      <span className="min-w-0 truncate">{t('fantayShell.sidebar.newProjectTarget', { name: group.name })}</span>
      <IconButton
        size="xs"
        aria-label={t('fantayShell.sidebar.clearNewProjectTarget')}
        data-testid="fantay-home-group-target-clear"
        className="ms-auto flex-none"
        onClick={() => setNewProjectGroup(null)}
      >
        <Icon icon={X} size={12} />
      </IconButton>
    </div>
  );
}
